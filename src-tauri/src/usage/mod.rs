use crate::{AppState, ProviderConfig};
use chrono::{DateTime, Datelike, Duration, SecondsFormat, TimeZone, Utc};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

pub async fn refresh_all_providers(
    app_state: &AppState,
) -> Vec<crate::commands::ProviderUsageStatus> {
    use crate::commands::ProviderUsageStatus;

    let settings = {
        let vault = app_state.vault.lock().unwrap();
        vault.get_usage_provider_settings().unwrap_or_default()
    };

    let (
        openai_config,
        anthropic_config,
        opencode_config,
        openclaw_config,
        openai_key,
        anthropic_key,
        opencode_key,
        openclaw_key,
        claude_cli_path,
        amp_cli_path,
        gemini_cli_path,
        kimi_cli_path,
    ) = {
        let vault = app_state.vault.lock().unwrap();
        let credentials = vault.get_credentials();
        let openai_key = vault
            .get_latest_credential_for_provider("openai")
            .map(|cred| cred.key);
        let anthropic_key = vault
            .get_latest_credential_for_provider("anthropic")
            .map(|cred| cred.key);
        let opencode_key = vault
            .get_latest_credential_for_provider("opencode")
            .map(|cred| cred.key)
            .or_else(|| find_credential_value(&credentials, "OPENCODE_API_KEY"));
        let openclaw_key = vault
            .get_latest_credential_for_provider("openclaw")
            .map(|cred| cred.key)
            .or_else(|| find_credential_value(&credentials, "OPENCLAW_API_KEY"));
        let claude_cli_path =
            find_credential_value(&credentials, "CLAUDE_CLI_PATH").or_else(|| {
                std::env::var("CLAUDE_CLI_PATH")
                    .ok()
                    .filter(|v| !v.trim().is_empty())
            });
        let amp_cli_path = find_credential_value(&credentials, "AMP_CLI_PATH")
            .or_else(|| std::env::var("AMP_CLI_PATH").ok().filter(|v| !v.trim().is_empty()));
        let gemini_cli_path = find_credential_value(&credentials, "GEMINI_CLI_PATH")
            .or_else(|| std::env::var("GEMINI_CLI_PATH").ok().filter(|v| !v.trim().is_empty()));
        let kimi_cli_path = find_credential_value(&credentials, "KIMI_CLI_PATH")
            .or_else(|| {
                find_credential_value(&credentials, "KIMI_CODING_CLI_PATH")
                    .or_else(|| std::env::var("KIMI_CLI_PATH").ok().filter(|v| !v.trim().is_empty()))
            });
        (
            vault.get_provider_config("openai"),
            vault.get_provider_config("anthropic"),
            vault.get_provider_config("opencode"),
            vault.get_provider_config("openclaw"),
            openai_key,
            anthropic_key,
            opencode_key,
            openclaw_key,
            claude_cli_path,
            amp_cli_path,
            gemini_cli_path,
            kimi_cli_path,
        )
    };

    let mut statuses = Vec::new();

    for provider in KNOWN_PROVIDERS {
        let enabled = settings.get(provider).copied().unwrap_or(true);
        if !enabled {
            let usage_state = app_state.usage.lock().unwrap();
            statuses.push(ProviderUsageStatus {
                provider_id: provider.to_string(),
                enabled,
                error: None,
                snapshot: usage_state.get(provider),
            });
            continue;
        }

        let (config, key_override) = match provider {
            "openai" => (openai_config.as_ref(), openai_key.as_deref()),
            "anthropic" => (anthropic_config.as_ref(), anthropic_key.as_deref()),
            "opencode" => (
                opencode_config.as_ref(),
                opencode_key.as_deref().or(openai_key.as_deref()),
            ),
            "openclaw" => (
                openclaw_config.as_ref(),
                openclaw_key.as_deref().or(openai_key.as_deref()),
            ),
            _ => (None, None),
        };

        let cli_path_override = match provider {
            "amp" => amp_cli_path.as_deref(),
            "gemini" => gemini_cli_path.as_deref(),
            "kimi" => kimi_cli_path.as_deref(),
            _ => claude_cli_path.as_deref(),
        };

        match probe(provider, config, key_override, cli_path_override).await {
            Ok(mut snapshot) => {
                snapshot.provider_id = provider.to_string();
                {
                    let mut usage_state = app_state.usage.lock().unwrap();
                    usage_state.update(vec![snapshot.clone()]);
                    usage_state.clear_error(provider);
                }
                {
                    let mut vault = app_state.vault.lock().unwrap();
                    let _ = vault.save_usage_snapshot(&snapshot);
                }
                statuses.push(ProviderUsageStatus {
                    provider_id: provider.to_string(),
                    enabled,
                    error: None,
                    snapshot: Some(snapshot),
                });
            }
            Err(e) => {
                let mut usage_state = app_state.usage.lock().unwrap();
                usage_state.set_error(provider, e.clone());
                // Get old snapshot if exists
                let snapshot = usage_state.get(provider);
                statuses.push(ProviderUsageStatus {
                    provider_id: provider.to_string(),
                    enabled,
                    error: Some(e),
                    snapshot,
                });
            }
        }
    }
    statuses
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageQuota {
    pub quota_type: String,
    pub label: String,
    pub percent_remaining: f64,
    pub reset_at: Option<String>,
    pub reset_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostUsage {
    pub total_cost: f64,
    pub budget: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageSnapshot {
    pub provider_id: String,
    pub captured_at: String,
    pub quotas: Vec<UsageQuota>,
    pub cost_usage: Option<CostUsage>,
    pub account_tier: Option<String>,
    pub account_email: Option<String>,
}

#[derive(Default)]
pub struct UsageState {
    pub snapshots: HashMap<String, UsageSnapshot>,
    pub errors: HashMap<String, String>,
}

impl UsageState {
    pub fn update(&mut self, snapshots: Vec<UsageSnapshot>) {
        for snapshot in snapshots {
            self.snapshots
                .insert(snapshot.provider_id.clone(), snapshot);
        }
    }

    pub fn list(&self) -> Vec<UsageSnapshot> {
        self.snapshots.values().cloned().collect()
    }

    pub fn get(&self, provider_id: &str) -> Option<UsageSnapshot> {
        self.snapshots.get(provider_id).cloned()
    }

    pub fn set_error(&mut self, provider_id: &str, error: String) {
        self.errors.insert(provider_id.to_string(), error);
    }

    pub fn clear_error(&mut self, provider_id: &str) {
        self.errors.remove(provider_id);
    }

    pub fn get_error(&self, provider_id: &str) -> Option<String> {
        self.errors.get(provider_id).cloned()
    }
}

mod cli;

pub const KNOWN_PROVIDERS: [&str; 9] = [
    "openai",
    "anthropic",
    "antigravity",
    "claude-code",
    "opencode",
    "openclaw",
    "gemini",
    "kimi",
    "amp",
];

pub async fn probe(
    provider_id: &str,
    config: Option<&ProviderConfig>,
    api_key_override: Option<&str>,
    claude_cli_path_override: Option<&str>,
) -> Result<UsageSnapshot, String> {
    match provider_id {
        "anthropic" => probe_anthropic(config, api_key_override, claude_cli_path_override).await,
        "claude-code" => cli::probe_claude_cli("claude-code", claude_cli_path_override),
        "anthropic-cli" => cli::probe_claude_cli("anthropic-cli", claude_cli_path_override),
        "openai" => probe_openai(config, api_key_override).await,
        "opencode" => probe_openai_api(config, api_key_override, "OpenCode").await,
        "openclaw" => probe_openai_api(config, api_key_override, "OpenClaw").await,
        "gemini" => cli::probe_gemini_cli("gemini", claude_cli_path_override),
        "kimi" => cli::probe_kimi_cli("kimi", claude_cli_path_override),
        "antigravity" => probe_antigravity().await,
        "amp" => cli::probe_amp_cli("amp", claude_cli_path_override),
        _ => Err(format!("Unknown provider: {}", provider_id)),
    }
}

fn normalize_base_url(
    base_url: Option<&str>,
    expected_domain: &str,
    default_base: &str,
) -> Result<String, String> {
    let raw = base_url.unwrap_or(default_base).trim();
    if raw.is_empty() {
        return Ok(default_base.to_string());
    }
    let mut normalized = raw.trim_end_matches('/').to_string();
    if normalized.ends_with("/v1") {
        normalized.truncate(normalized.len() - 3);
    }
    if !normalized.contains(expected_domain) {
        return Err(format!(
            "Usage API only supports official {} endpoints",
            expected_domain
        ));
    }
    Ok(normalized)
}

fn require_api_key(
    config: Option<&ProviderConfig>,
    provider_name: &str,
    api_key_override: Option<&str>,
) -> Result<String, String> {
    if let Some(key) = api_key_override {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let api_key = config
        .map(|c| c.api_key.trim().to_string())
        .unwrap_or_default();
    if api_key.is_empty() {
        return Err(format!(
            "Missing {} API key in key vault or provider settings",
            provider_name
        ));
    }
    Ok(api_key)
}

fn current_month_range() -> (DateTime<Utc>, DateTime<Utc>) {
    let now = Utc::now();
    let start = Utc
        .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .single()
        .unwrap_or(now);
    (start, now)
}

fn parse_numeric_value(value: &Value) -> Option<f64> {
    if let Some(v) = value.as_f64() {
        return Some(v);
    }
    if let Some(v) = value.as_i64() {
        return Some(v as f64);
    }
    if let Some(v) = value.as_str() {
        return v.parse::<f64>().ok();
    }
    None
}

fn parse_cents_value(value: &Value) -> Option<f64> {
    if let Some(obj) = value.as_object() {
        for key in ["value", "amount", "cost", "total_cost"] {
            if let Some(inner) = obj.get(key) {
                if let Some(parsed) = parse_cents_value(inner) {
                    return Some(parsed);
                }
            }
        }
    }
    if let Some(text) = value.as_str() {
        if let Ok(num) = text.parse::<f64>() {
            if text.contains('.') {
                return Some(num);
            }
            return Some(num / 100.0);
        }
    }
    if let Some(num) = value.as_f64() {
        if (num.fract() - 0.0).abs() < 0.000_001 {
            return Some(num / 100.0);
        }
        return Some(num);
    }
    None
}

fn find_credential_value(credentials: &[crate::Credential], variable_name: &str) -> Option<String> {
    let target = variable_name.trim().to_ascii_uppercase();
    if target.is_empty() {
        return None;
    }

    for credential in credentials {
        let name_upper = credential.name.to_ascii_uppercase();
        let direct_match = name_upper == target;
        let wrapped_match = name_upper.contains(&format!("({})", target));
        let fuzzy_match = name_upper.contains(&target);
        if direct_match || wrapped_match || fuzzy_match {
            let value = credential.key.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }

    None
}

async fn probe_openai(
    config: Option<&ProviderConfig>,
    api_key_override: Option<&str>,
) -> Result<UsageSnapshot, String> {
    match probe_codex_oauth().await {
        Ok(snapshot) => Ok(snapshot),
        Err(oauth_err) => match probe_openai_api(config, api_key_override, "OpenAI").await {
            Ok(snapshot) => Ok(snapshot),
            Err(api_err) => {
                if api_err.contains("Missing OpenAI API key") {
                    return Err(format!("OpenAI OAuth probe failed: {}", oauth_err));
                }
                Err(format!(
                    "OpenAI OAuth probe failed: {}; OpenAI Admin API probe failed: {}",
                    oauth_err, api_err
                ))
            }
        },
    }
}

async fn probe_anthropic(
    config: Option<&ProviderConfig>,
    api_key_override: Option<&str>,
    claude_cli_path_override: Option<&str>,
) -> Result<UsageSnapshot, String> {
    let oauth_err = match probe_claude_oauth().await {
        Ok(snapshot) => return Ok(snapshot),
        Err(err) => err,
    };

    let cli_err = match cli::probe_claude_cli("anthropic", claude_cli_path_override) {
        Ok(snapshot) => return Ok(snapshot),
        Err(err) => err,
    };

    match probe_anthropic_api(config, api_key_override).await {
        Ok(snapshot) => Ok(snapshot),
        Err(api_err) => Err(format!(
            "Claude OAuth probe failed: {}; Claude CLI probe failed: {}; Anthropic Admin API probe failed: {}",
            oauth_err, cli_err, api_err
        )),
    }
}

// ---- OpenAI API Key Usage ----

async fn probe_openai_api(
    config: Option<&ProviderConfig>,
    api_key_override: Option<&str>,
    provider_name: &str,
) -> Result<UsageSnapshot, String> {
    let api_key = require_api_key(config, provider_name, api_key_override)?;
    let base_url = normalize_base_url(
        config.map(|c| c.base_url.as_str()),
        "openai.com",
        "https://api.openai.com",
    )?;

    let (start, end) = current_month_range();
    let url = format!(
        "{}/v1/organization/costs?start_time={}&end_time={}&bucket_width=1d",
        base_url,
        start.timestamp(),
        end.timestamp()
    );

    let client = Client::new();
    let resp = client
        .get(&url)
        .bearer_auth(api_key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if resp.status() == StatusCode::UNAUTHORIZED || resp.status() == StatusCode::FORBIDDEN {
        return Err(format!(
            "{} usage API requires an Admin API key",
            provider_name
        ));
    }
    if !resp.status().is_success() {
        return Err(format!(
            "{} usage API failed (HTTP {})",
            provider_name,
            resp.status()
        ));
    }

    let body = resp.json::<Value>().await.map_err(|e| e.to_string())?;
    let total_cost = sum_openai_costs(&body)?;

    Ok(UsageSnapshot {
        provider_id: "openai".to_string(),
        captured_at: Utc::now().to_rfc3339(),
        quotas: Vec::new(),
        cost_usage: Some(CostUsage {
            total_cost,
            budget: None,
        }),
        account_tier: None,
        account_email: None,
    })
}

fn sum_openai_costs(body: &Value) -> Result<f64, String> {
    let mut total = 0.0;
    let data = body
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or("OpenAI usage response missing data")?;

    for bucket in data {
        if let Some(results) = bucket.get("results").and_then(|v| v.as_array()) {
            for result in results {
                if let Some(amount) = result.get("amount") {
                    if let Some(value) = amount.get("value").and_then(parse_numeric_value) {
                        total += value;
                        continue;
                    }
                }
                if let Some(value) = result
                    .get("total_cost")
                    .or_else(|| result.get("cost"))
                    .and_then(parse_numeric_value)
                {
                    total += value;
                }
            }
        }
    }

    Ok(total)
}

// ---- Anthropic API Key Usage ----

async fn probe_anthropic_api(
    config: Option<&ProviderConfig>,
    api_key_override: Option<&str>,
) -> Result<UsageSnapshot, String> {
    let api_key = require_api_key(config, "Anthropic", api_key_override)?;
    let base_url = normalize_base_url(
        config.map(|c| c.base_url.as_str()),
        "anthropic.com",
        "https://api.anthropic.com",
    )?;

    let (start, end) = current_month_range();
    let start_iso = start.to_rfc3339_opts(SecondsFormat::Secs, true);
    let end_iso = end.to_rfc3339_opts(SecondsFormat::Secs, true);
    let url = format!(
        "{}/v1/organizations/cost_report?starting_at={}&ending_at={}&bucket_width=1d",
        base_url, start_iso, end_iso
    );

    let client = Client::new();
    let resp = client
        .get(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if resp.status() == StatusCode::UNAUTHORIZED || resp.status() == StatusCode::FORBIDDEN {
        return Err("Anthropic usage API requires an Admin API key".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!(
            "Anthropic usage API failed (HTTP {})",
            resp.status()
        ));
    }

    let body = resp.json::<Value>().await.map_err(|e| e.to_string())?;
    let total_cost = sum_anthropic_costs(&body)?;

    Ok(UsageSnapshot {
        provider_id: "anthropic".to_string(),
        captured_at: Utc::now().to_rfc3339(),
        quotas: Vec::new(),
        cost_usage: Some(CostUsage {
            total_cost,
            budget: None,
        }),
        account_tier: Some("api".to_string()),
        account_email: None,
    })
}

fn sum_anthropic_costs(body: &Value) -> Result<f64, String> {
    let mut total = 0.0;
    let data = body
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or("Anthropic usage response missing data")?;

    for bucket in data {
        if let Some(results) = bucket.get("results").and_then(|v| v.as_array()) {
            for result in results {
                if let Some(amount) = result.get("amount") {
                    if let Some(value) = parse_cents_value(amount) {
                        total += value;
                        continue;
                    }
                }
                if let Some(value) = result
                    .get("total_cost")
                    .or_else(|| result.get("cost"))
                    .and_then(parse_cents_value)
                {
                    total += value;
                }
            }
        }
    }

    Ok(total)
}

// ---- Claude OAuth (Claude Code) ----

#[derive(Debug, Clone)]
enum CredentialSource {
    File,
    Keychain,
}

#[derive(Debug, Clone)]
struct ClaudeOAuthCredentials {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<f64>,
    subscription_type: Option<String>,
}

#[derive(Debug, Clone)]
struct ClaudeCredentialResult {
    oauth: ClaudeOAuthCredentials,
    source: CredentialSource,
    full_data: Value,
}

fn claude_credentials_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Missing home directory")?;
    Ok(home.join(".claude").join(".credentials.json"))
}

fn load_claude_credentials_from_file() -> Result<Option<ClaudeCredentialResult>, String> {
    let path = claude_credentials_path()?;
    if !path.exists() {
        return Ok(None);
    }

    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    let oauth = json
        .get("claudeAiOauth")
        .and_then(|v| v.as_object())
        .ok_or("Missing claudeAiOauth")?;

    let access_token = oauth
        .get("accessToken")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if access_token.is_empty() {
        return Ok(None);
    }

    let refresh_token = oauth
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let expires_at = oauth.get("expiresAt").and_then(|v| v.as_f64());
    let subscription_type = oauth
        .get("subscriptionType")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());

    Ok(Some(ClaudeCredentialResult {
        oauth: ClaudeOAuthCredentials {
            access_token,
            refresh_token,
            expires_at,
            subscription_type,
        },
        source: CredentialSource::File,
        full_data: json,
    }))
}

fn load_claude_credentials_from_keychain() -> Result<Option<ClaudeCredentialResult>, String> {
    let output = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output();

    let output = match output {
        Ok(out) if out.status.success() => out.stdout,
        _ => return Ok(None),
    };

    let json_str = String::from_utf8_lossy(&output).trim().to_string();
    if json_str.is_empty() {
        return Ok(None);
    }

    let json: Value = serde_json::from_str(&json_str).map_err(|e| e.to_string())?;
    let oauth = json
        .get("claudeAiOauth")
        .and_then(|v| v.as_object())
        .ok_or("Missing claudeAiOauth")?;

    let access_token = oauth
        .get("accessToken")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if access_token.is_empty() {
        return Ok(None);
    }

    let refresh_token = oauth
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let expires_at = oauth.get("expiresAt").and_then(|v| v.as_f64());
    let subscription_type = oauth
        .get("subscriptionType")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());

    Ok(Some(ClaudeCredentialResult {
        oauth: ClaudeOAuthCredentials {
            access_token,
            refresh_token,
            expires_at,
            subscription_type,
        },
        source: CredentialSource::Keychain,
        full_data: json,
    }))
}

fn load_claude_credentials() -> Result<ClaudeCredentialResult, String> {
    if let Some(result) = load_claude_credentials_from_file()? {
        return Ok(result);
    }
    if let Some(result) = load_claude_credentials_from_keychain()? {
        return Ok(result);
    }
    Err("Claude OAuth credentials not found".to_string())
}

fn save_claude_credentials(result: &ClaudeCredentialResult) -> Result<(), String> {
    let mut data = result.full_data.clone();
    let mut oauth = serde_json::Map::new();
    oauth.insert(
        "accessToken".to_string(),
        Value::String(result.oauth.access_token.clone()),
    );
    if let Some(refresh) = &result.oauth.refresh_token {
        oauth.insert("refreshToken".to_string(), Value::String(refresh.clone()));
    }
    if let Some(expires_at) = result.oauth.expires_at {
        oauth.insert(
            "expiresAt".to_string(),
            Value::Number(serde_json::Number::from_f64(expires_at).unwrap()),
        );
    }
    if let Some(sub) = &result.oauth.subscription_type {
        oauth.insert("subscriptionType".to_string(), Value::String(sub.clone()));
    }
    data.as_object_mut()
        .ok_or("Invalid credential JSON")?
        .insert("claudeAiOauth".to_string(), Value::Object(oauth));

    match result.source {
        CredentialSource::File => {
            let path = claude_credentials_path()?;
            let json_data = serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?;
            fs::write(path, json_data).map_err(|e| e.to_string())?;
        }
        CredentialSource::Keychain => {
            let json_data = serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?;
            let json_str = String::from_utf8_lossy(&json_data).to_string();
            let _ = Command::new("/usr/bin/security")
                .args(["delete-generic-password", "-s", "Claude Code-credentials"])
                .output();
            let status = Command::new("/usr/bin/security")
                .args([
                    "add-generic-password",
                    "-s",
                    "Claude Code-credentials",
                    "-w",
                    &json_str,
                ])
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("Failed to save Claude credentials to Keychain".to_string());
            }
        }
    }
    Ok(())
}

fn claude_needs_refresh(oauth: &ClaudeOAuthCredentials) -> bool {
    let refresh_buffer_ms: f64 = 5.0 * 60.0 * 1000.0;
    match oauth.expires_at {
        None => true,
        Some(expires_at) => {
            let now_ms = Utc::now().timestamp_millis() as f64;
            now_ms + refresh_buffer_ms >= expires_at
        }
    }
}

async fn refresh_claude_token(credentials: &mut ClaudeCredentialResult) -> Result<(), String> {
    let refresh_token = credentials
        .oauth
        .refresh_token
        .clone()
        .ok_or("Claude refresh token missing")?;

    let client = Client::new();
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        "scope": "user:profile user:inference user:sessions:claude_code"
    });

    let resp = client
        .post("https://platform.claude.com/v1/oauth/token")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if resp.status() == StatusCode::UNAUTHORIZED || resp.status() == StatusCode::BAD_REQUEST {
        return Err("Claude OAuth refresh failed (session expired)".to_string());
    }

    if !resp.status().is_success() {
        return Err(format!(
            "Claude OAuth refresh failed (HTTP {})",
            resp.status()
        ));
    }

    #[derive(Deserialize)]
    struct RefreshResponse {
        access_token: Option<String>,
        refresh_token: Option<String>,
        expires_in: Option<i64>,
    }

    let data: RefreshResponse = resp.json().await.map_err(|e| e.to_string())?;
    let access_token = data.access_token.ok_or("Missing access token")?;
    credentials.oauth.access_token = access_token;
    if let Some(refresh_token) = data.refresh_token {
        credentials.oauth.refresh_token = Some(refresh_token);
    }
    if let Some(expires_in) = data.expires_in {
        let now_ms = Utc::now().timestamp_millis();
        credentials.oauth.expires_at = Some((now_ms + expires_in * 1000) as f64);
    }

    save_claude_credentials(credentials)?;
    Ok(())
}

async fn fetch_claude_usage(access_token: &str) -> Result<Value, String> {
    let client = Client::new();
    let mut headers = HeaderMap::new();
    headers.insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", access_token.trim()))
            .map_err(|e| e.to_string())?,
    );
    headers.insert("Accept", HeaderValue::from_static("application/json"));
    headers.insert("Content-Type", HeaderValue::from_static("application/json"));
    headers.insert(
        "anthropic-beta",
        HeaderValue::from_static("oauth-2025-04-20"),
    );
    headers.insert("User-Agent", HeaderValue::from_static("MyKey"));

    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .headers(headers)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if resp.status() == StatusCode::UNAUTHORIZED || resp.status() == StatusCode::FORBIDDEN {
        return Err("Claude OAuth unauthorized".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!(
            "Claude usage fetch failed (HTTP {})",
            resp.status()
        ));
    }

    resp.json::<Value>().await.map_err(|e| e.to_string())
}

fn parse_iso_date(value: Option<&str>) -> Option<DateTime<Utc>> {
    let value = value?;
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc))
        .ok()
}

fn format_reset_text(date: Option<DateTime<Utc>>) -> Option<String> {
    let date = date?;
    let now = Utc::now();
    let diff = date.signed_duration_since(now);
    if diff.num_seconds() <= 0 {
        return None;
    }
    let hours = diff.num_hours();
    let minutes = (diff - Duration::hours(hours)).num_minutes();
    if hours > 0 {
        Some(format!("{}h {}m", hours, minutes))
    } else if minutes > 0 {
        Some(format!("{}m", minutes))
    } else {
        Some("soon".to_string())
    }
}

fn value_by_keys<'a>(source: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    for key in keys {
        if let Some(value) = source.get(key) {
            return Some(value);
        }
    }
    None
}

fn numeric_by_keys(source: &Value, keys: &[&str]) -> Option<f64> {
    value_by_keys(source, keys).and_then(parse_numeric_value)
}

fn parse_datetime_value(value: Option<&Value>) -> Option<DateTime<Utc>> {
    let value = value?;
    if let Some(text) = value.as_str() {
        return parse_iso_date(Some(text));
    }
    if let Some(timestamp) = value.as_i64() {
        return DateTime::<Utc>::from_timestamp(timestamp, 0);
    }
    if let Some(timestamp) = value.as_f64() {
        let seconds = if timestamp > 1_000_000_000_000.0 {
            (timestamp / 1000.0).round() as i64
        } else {
            timestamp.round() as i64
        };
        return DateTime::<Utc>::from_timestamp(seconds, 0);
    }
    None
}

fn claude_quota_meta(raw_key: &str) -> (String, String) {
    let compact: String = raw_key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();

    match compact.as_str() {
        "fivehour" | "fivehours" | "session" | "primarywindow" => {
            ("session".to_string(), "Session".to_string())
        }
        "sevenday" | "weekly" | "secondarywindow" => ("weekly".to_string(), "Weekly".to_string()),
        "sevendaysonnet" | "sonnet" => ("seven_day_sonnet".to_string(), "Sonnet".to_string()),
        "sevendayopus" | "opus" => ("seven_day_opus".to_string(), "Opus".to_string()),
        _ => {
            let readable = raw_key
                .replace('_', " ")
                .replace('-', " ")
                .split_whitespace()
                .map(|part| {
                    let mut chars = part.chars();
                    match chars.next() {
                        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                        None => String::new(),
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            ("window".to_string(), readable)
        }
    }
}

fn push_claude_quota(
    quotas: &mut Vec<UsageQuota>,
    seen: &mut HashSet<String>,
    quota_type: String,
    label: String,
    payload: &Value,
) {
    let percent_remaining = numeric_by_keys(
        payload,
        &[
            "percent_remaining",
            "percentRemaining",
            "remaining_percent",
            "remainingPercent",
        ],
    )
    .or_else(|| {
        numeric_by_keys(
            payload,
            &["utilization", "utilisation", "used_percent", "usedPercent"],
        )
        .map(|used| 100.0 - used)
    })
    .or_else(|| {
        let used = numeric_by_keys(payload, &["used", "usage", "consumed"]);
        let limit = numeric_by_keys(payload, &["limit", "quota", "allowance", "maximum"]);
        match (used, limit) {
            (Some(used), Some(limit)) if limit > 0.0 => Some(100.0 - (used / limit * 100.0)),
            _ => None,
        }
    });

    let percent_remaining = match percent_remaining {
        Some(value) => value.clamp(0.0, 100.0),
        None => return,
    };

    let dedup_key = format!("{}:{}", quota_type, label.to_ascii_lowercase());
    if seen.contains(&dedup_key) {
        return;
    }

    let reset_dt = parse_datetime_value(value_by_keys(
        payload,
        &[
            "resets_at",
            "reset_at",
            "resetAt",
            "next_reset_at",
            "nextResetAt",
            "renews_at",
            "renewsAt",
        ],
    ));

    quotas.push(UsageQuota {
        quota_type,
        label,
        percent_remaining,
        reset_at: reset_dt.map(|d| d.to_rfc3339()),
        reset_text: format_reset_text(reset_dt),
    });
    seen.insert(dedup_key);
}

async fn probe_claude_oauth() -> Result<UsageSnapshot, String> {
    let mut credentials = load_claude_credentials()?;
    if claude_needs_refresh(&credentials.oauth) {
        refresh_claude_token(&mut credentials).await?;
    }

    let data = fetch_claude_usage(&credentials.oauth.access_token).await?;
    let mut quotas = Vec::new();
    let mut seen = HashSet::new();

    let roots = [
        Some(&data),
        data.get("quotas"),
        data.get("rate_limits"),
        data.get("rateLimits"),
        data.get("limits"),
        data.get("usage"),
    ];

    let known_keys = [
        "five_hour",
        "fiveHour",
        "session",
        "primary_window",
        "primaryWindow",
        "seven_day",
        "sevenDay",
        "weekly",
        "secondary_window",
        "secondaryWindow",
        "seven_day_sonnet",
        "sevenDaySonnet",
        "sonnet",
        "seven_day_opus",
        "sevenDayOpus",
        "opus",
    ];

    for root in roots.iter().flatten() {
        for key in known_keys {
            if let Some(payload) = root.get(key) {
                let (quota_type, label) = claude_quota_meta(key);
                push_claude_quota(&mut quotas, &mut seen, quota_type, label, payload);
            }
        }

        if let Some(obj) = root.as_object() {
            for (key, payload) in obj {
                if !payload.is_object() {
                    continue;
                }
                let (quota_type, label) = claude_quota_meta(key);
                push_claude_quota(&mut quotas, &mut seen, quota_type, label, payload);
            }
        }
    }

    let cost_usage = data
        .get("extra_usage")
        .or_else(|| data.get("extraUsage"))
        .and_then(|extra| {
            let enabled = value_by_keys(extra, &["is_enabled", "isEnabled"])
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            if !enabled {
                return None;
            }

            let used = numeric_by_keys(extra, &["used_credits", "usedCredits"]);
            let budget = numeric_by_keys(extra, &["monthly_limit", "monthlyLimit"]);
            used.map(|used| CostUsage {
                total_cost: used / 100.0,
                budget: budget.map(|b| b / 100.0),
            })
        });

    if quotas.is_empty() && cost_usage.is_none() {
        return Err("Claude OAuth response did not include usage windows".to_string());
    }

    let snapshot = UsageSnapshot {
        provider_id: "anthropic".to_string(),
        captured_at: Utc::now().to_rfc3339(),
        quotas,
        cost_usage,
        account_tier: credentials.oauth.subscription_type.clone(),
        account_email: None,
    };
    Ok(snapshot)
}

// ---- Codex OAuth (OpenAI) ----

#[derive(Debug, Clone)]
struct CodexTokens {
    access_token: String,
    refresh_token: String,
    account_id: Option<String>,
}

#[derive(Debug, Clone)]
struct CodexCredentialResult {
    tokens: CodexTokens,
    raw: Value,
}

fn codex_auth_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Missing home directory")?;
    Ok(home.join(".codex").join("auth.json"))
}

fn load_codex_credentials() -> Result<CodexCredentialResult, String> {
    let path = codex_auth_path()?;
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    let tokens = json
        .get("tokens")
        .and_then(|v| v.as_object())
        .ok_or("Missing tokens")?;
    let access_token = tokens
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let refresh_token = tokens
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let account_id = tokens
        .get("account_id")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    if access_token.is_empty() || refresh_token.is_empty() {
        return Err("Invalid Codex OAuth tokens".to_string());
    }
    Ok(CodexCredentialResult {
        tokens: CodexTokens {
            access_token,
            refresh_token,
            account_id,
        },
        raw: json,
    })
}

fn codex_needs_refresh(raw: &Value) -> bool {
    let last_refresh = raw.get("last_refresh").and_then(|v| v.as_str());
    let last_refresh = match last_refresh {
        Some(value) => DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|dt| dt.with_timezone(&Utc)),
        None => None,
    };
    match last_refresh {
        None => true,
        Some(dt) => Utc::now().signed_duration_since(dt).num_days() > 8,
    }
}

async fn refresh_codex_token(credentials: &mut CodexCredentialResult) -> Result<(), String> {
    let client = Client::new();
    let form = [
        ("grant_type", "refresh_token"),
        ("client_id", "app_EMoamEEZ73f0CkXaXp7hrann"),
        ("refresh_token", credentials.tokens.refresh_token.as_str()),
    ];

    let resp = client
        .post("https://auth.openai.com/oauth/token")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!(
            "Codex OAuth refresh failed (HTTP {})",
            resp.status()
        ));
    }

    #[derive(Deserialize)]
    struct RefreshResponse {
        access_token: Option<String>,
        refresh_token: Option<String>,
    }

    let data: RefreshResponse = resp.json().await.map_err(|e| e.to_string())?;
    let access = data.access_token.ok_or("Missing access token")?;
    credentials.tokens.access_token = access;
    if let Some(refresh) = data.refresh_token {
        credentials.tokens.refresh_token = refresh;
    }

    if let Some(tokens) = credentials
        .raw
        .get_mut("tokens")
        .and_then(|v| v.as_object_mut())
    {
        tokens.insert(
            "access_token".to_string(),
            Value::String(credentials.tokens.access_token.clone()),
        );
        tokens.insert(
            "refresh_token".to_string(),
            Value::String(credentials.tokens.refresh_token.clone()),
        );
        if let Some(account_id) = &credentials.tokens.account_id {
            tokens.insert("account_id".to_string(), Value::String(account_id.clone()));
        }
    }
    if let Some(root) = credentials.raw.as_object_mut() {
        root.insert(
            "last_refresh".to_string(),
            Value::String(Utc::now().to_rfc3339()),
        );
    }

    let path = codex_auth_path()?;
    let json_data = serde_json::to_vec_pretty(&credentials.raw).map_err(|e| e.to_string())?;
    fs::write(path, json_data).map_err(|e| e.to_string())?;
    Ok(())
}

async fn fetch_codex_usage(
    access_token: &str,
    account_id: Option<&str>,
) -> Result<(HeaderMap, Value), String> {
    let client = Client::new();
    let mut request = client
        .get("https://chatgpt.com/backend-api/wham/usage")
        .header("Authorization", format!("Bearer {}", access_token))
        .header("Accept", "application/json");
    if let Some(account_id) = account_id.filter(|value| !value.trim().is_empty()) {
        request = request.header("ChatGPT-Account-Id", account_id);
    }
    let resp = request.send().await.map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Codex usage fetch failed (HTTP {})", resp.status()));
    }

    let headers = resp.headers().clone();
    let body = resp.json::<Value>().await.map_err(|e| e.to_string())?;
    Ok((headers, body))
}

fn header_percent(headers: &HeaderMap, key: &str) -> Option<f64> {
    headers
        .get(key)
        .and_then(|v| v.to_str().ok())?
        .parse::<f64>()
        .ok()
}

async fn probe_codex_oauth() -> Result<UsageSnapshot, String> {
    let mut credentials = load_codex_credentials()?;
    if codex_needs_refresh(&credentials.raw) {
        refresh_codex_token(&mut credentials).await?;
    }

    let (headers, body) = fetch_codex_usage(
        &credentials.tokens.access_token,
        credentials.tokens.account_id.as_deref(),
    )
    .await?;

    let mut quotas = Vec::new();

    let session_used = header_percent(&headers, "x-codex-primary-used-percent").or_else(|| {
        body.get("rate_limit")?
            .get("primary_window")?
            .get("used_percent")?
            .as_f64()
    });

    let weekly_used = header_percent(&headers, "x-codex-secondary-used-percent").or_else(|| {
        body.get("rate_limit")?
            .get("secondary_window")?
            .get("used_percent")?
            .as_f64()
    });

    if let Some(used) = session_used {
        quotas.push(UsageQuota {
            quota_type: "session".to_string(),
            label: "Session".to_string(),
            percent_remaining: 100.0 - used,
            reset_at: body
                .get("rate_limit")
                .and_then(|v| v.get("primary_window"))
                .and_then(|v| v.get("reset_at"))
                .and_then(|v| v.as_i64())
                .map(|s| {
                    DateTime::<Utc>::from_timestamp(s, 0)
                        .unwrap_or_else(Utc::now)
                        .to_rfc3339()
                }),
            reset_text: None,
        });
    }

    if let Some(used) = weekly_used {
        quotas.push(UsageQuota {
            quota_type: "weekly".to_string(),
            label: "Weekly".to_string(),
            percent_remaining: 100.0 - used,
            reset_at: body
                .get("rate_limit")
                .and_then(|v| v.get("secondary_window"))
                .and_then(|v| v.get("reset_at"))
                .and_then(|v| v.as_i64())
                .map(|s| {
                    DateTime::<Utc>::from_timestamp(s, 0)
                        .unwrap_or_else(Utc::now)
                        .to_rfc3339()
                }),
            reset_text: None,
        });
    }

    Ok(UsageSnapshot {
        provider_id: "openai".to_string(),
        captured_at: Utc::now().to_rfc3339(),
        quotas,
        cost_usage: None,
        account_tier: body
            .get("plan_type")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        account_email: None,
    })
}

// ---- Antigravity (local) ----

#[derive(Debug)]
struct AntigravityProcess {
    pid: i32,
    csrf_token: String,
    extension_port: Option<i32>,
}

fn is_antigravity_process(command_line: &str) -> bool {
    let lower = command_line.to_lowercase();
    let has_name =
        lower.contains("language_server_macos") || lower.contains("language_server_macos_arm");
    if !has_name {
        return false;
    }
    if lower.contains("--app_data_dir") && lower.contains("antigravity") {
        return true;
    }
    lower.contains("/antigravity/") || lower.contains(".antigravity/")
}

fn extract_flag(command_line: &str, flag: &str) -> Option<String> {
    let pattern = format!(r"{}[=\s]+([^\s]+)", regex::escape(flag));
    let re = regex::Regex::new(&pattern).ok()?;
    re.captures(command_line)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()))
}

fn detect_antigravity_process() -> Result<AntigravityProcess, String> {
    let output = Command::new("/usr/bin/pgrep")
        .args(["-lf", "language_server_macos"])
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || !is_antigravity_process(line) {
            continue;
        }
        let mut parts = line.splitn(2, ' ');
        let pid = parts
            .next()
            .and_then(|v| v.parse::<i32>().ok())
            .ok_or("Invalid PID")?;
        let csrf_token = extract_flag(line, "--csrf_token").ok_or("Missing CSRF token")?;
        let extension_port =
            extract_flag(line, "--extension_server_port").and_then(|v| v.parse::<i32>().ok());
        return Ok(AntigravityProcess {
            pid,
            csrf_token,
            extension_port,
        });
    }
    Err("Antigravity process not found".to_string())
}

fn discover_ports(pid: i32) -> Result<Vec<i32>, String> {
    let lsof_path = ["/usr/sbin/lsof", "/usr/bin/lsof"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
        .unwrap_or("/usr/sbin/lsof");

    let output = Command::new(lsof_path)
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", &pid.to_string()])
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let re = regex::Regex::new(r":(\d+)\s+\(LISTEN\)").map_err(|e| e.to_string())?;
    let mut ports: Vec<i32> = re
        .captures_iter(&stdout)
        .filter_map(|caps| caps.get(1).and_then(|m| m.as_str().parse::<i32>().ok()))
        .collect();
    ports.sort();
    ports.dedup();
    if ports.is_empty() {
        return Err("No listening ports found".to_string());
    }
    Ok(ports)
}

async fn antigravity_request(
    client: &Client,
    scheme: &str,
    port: i32,
    path: &str,
    csrf_token: &str,
) -> Result<Value, String> {
    let url = format!("{}://127.0.0.1:{}{}", scheme, port, path);
    let body = serde_json::json!({
        "metadata": {
            "ideName": "antigravity",
            "extensionName": "antigravity",
            "ideVersion": "unknown",
            "locale": "en"
        }
    });
    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("X-Codeium-Csrf-Token", csrf_token)
        .header("Connect-Protocol-Version", "1")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Antigravity API failed (HTTP {})", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

fn parse_antigravity_quotas(
    data: &Value,
) -> Result<(Vec<UsageQuota>, Option<String>, Option<String>), String> {
    let user_status = data.get("userStatus");
    let model_configs = user_status
        .and_then(|v| v.get("cascadeModelConfigData"))
        .and_then(|v| v.get("clientModelConfigs"))
        .and_then(|v| v.as_array())
        .cloned()
        .or_else(|| {
            data.get("clientModelConfigs")
                .and_then(|v| v.as_array())
                .cloned()
        })
        .unwrap_or_default();

    let mut quotas = Vec::new();
    for config in model_configs {
        let label = config
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("model");
        let quota_info = config.get("quotaInfo");
        if let Some(quota_info) = quota_info {
            let remaining_fraction = quota_info
                .get("remainingFraction")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let reset_time = quota_info.get("resetTime").and_then(|v| v.as_str());
            let reset_dt = parse_iso_date(reset_time).or_else(|| {
                reset_time
                    .and_then(|v| v.parse::<i64>().ok())
                    .and_then(|s| DateTime::<Utc>::from_timestamp(s, 0))
            });
            quotas.push(UsageQuota {
                quota_type: "model".to_string(),
                label: label.to_string(),
                percent_remaining: remaining_fraction * 100.0,
                reset_at: reset_dt.map(|d| d.to_rfc3339()),
                reset_text: format_reset_text(reset_dt),
            });
        }
    }

    if quotas.is_empty() {
        return Err("No model quotas found".to_string());
    }

    let account_email = user_status
        .and_then(|v| v.get("email"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());

    let account_tier = user_status
        .and_then(|v| v.get("planStatus"))
        .and_then(|v| v.get("planInfo"))
        .and_then(|v| v.get("planName"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());

    Ok((quotas, account_email, account_tier))
}

async fn probe_antigravity() -> Result<UsageSnapshot, String> {
    let process = detect_antigravity_process()?;
    let ports = discover_ports(process.pid)?;
    let client = Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    let paths = [
        "/exa.language_server_pb.LanguageServerService/GetUserStatus",
        "/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs",
    ];

    let mut response: Option<Value> = None;
    for port in ports.iter() {
        for path in paths.iter() {
            if let Ok(data) =
                antigravity_request(&client, "https", *port, path, &process.csrf_token).await
            {
                response = Some(data);
                break;
            }
        }
        if response.is_some() {
            break;
        }
    }

    if response.is_none() {
        if let Some(http_port) = process.extension_port {
            for path in paths.iter() {
                if let Ok(data) =
                    antigravity_request(&client, "http", http_port, path, &process.csrf_token).await
                {
                    response = Some(data);
                    break;
                }
            }
        }
    }

    let response = response.ok_or("Antigravity API not reachable")?;
    let (quotas, account_email, account_tier) = parse_antigravity_quotas(&response)?;

    Ok(UsageSnapshot {
        provider_id: "antigravity".to_string(),
        captured_at: Utc::now().to_rfc3339(),
        quotas,
        cost_usage: None,
        account_tier,
        account_email,
    })
}
