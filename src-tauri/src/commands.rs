use crate::{
    usage, AppRoute, AppState, Credential, ExternalLibraryMcp, ExternalLibrarySkill,
    GatewayAccessCredentials, GatewayPolicySettings, GatewayRequestLog, GatewayTrafficMetrics,
    GlobalSettingsPayload, IntegrationConfigSnapshot, OpencodeConfigSnapshot, Project,
    PromptTemplate, ProviderAppBindingInput, ProviderConfig, ProviderDetails,
    ProviderEndpointInput, ProviderEnvVarInput, QuickActionHistoryRecord, QuickActionResult,
    QuickActionSettings,
};
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::str::FromStr;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use walkdir::WalkDir;
use base64::Engine as _;

#[tauri::command]
pub fn set_master_password(password: String, state: State<'_, AppState>) -> Result<bool, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    vault.set_master_password(&password)?;
    Ok(true)
}

#[tauri::command]
pub fn authenticate(password: String, state: State<'_, AppState>) -> Result<bool, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    Ok(vault.authenticate(&password))
}

#[tauri::command]
pub fn is_password_set(state: State<'_, AppState>) -> Result<bool, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    Ok(vault.is_password_set())
}

#[tauri::command]
pub fn add_credential(
    provider: String,
    name: String,
    key: String,
    source: Option<String>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Credential, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;

    // Verify password
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    vault.add_credential(provider, name, key, source)
}

#[tauri::command]
pub fn get_credentials(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Vec<Credential>, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;

    // Verify password
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    Ok(vault.get_credentials())
}

#[tauri::command]
pub fn update_credential(
    id: String,
    provider: String,
    name: String,
    key: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Credential, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;

    // Verify password
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    vault.update_credential(id, provider, name, key)
}

#[tauri::command]
pub fn delete_credential(id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    vault.delete_credential(&id)?;
    Ok(true)
}

#[tauri::command]
pub fn get_credential_project_labels(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<HashMap<String, String>, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.get_credential_project_labels()
}

#[tauri::command]
pub fn set_credential_project_label(
    credential_id: String,
    label: Option<String>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.set_credential_project_label(credential_id, label)?;
    Ok(true)
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ParsedKey {
    pub provider: String,
    pub name: String,
    pub key: String,
    pub source: Option<String>,
    pub variable: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ShipkeyScanReport {
    pub parsed_keys: Vec<ParsedKey>,
    pub env_files: usize,
    pub env_vars: usize,
    pub workflow_files: Vec<String>,
    pub workflow_secrets: Vec<String>,
    pub missing_workflow_secrets: Vec<String>,
    pub wrangler_file: Option<String>,
    pub wrangler_projects: Vec<String>,
    pub wrangler_bindings: Vec<String>,
    pub package_dependencies: Vec<String>,
    pub shipkey_fields: Vec<String>,
    pub used_shipkey_config: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct MykeySyncGenerateResult {
    pub output_path: String,
    pub project_name: String,
    pub secret_count: usize,
    pub github_target_count: usize,
    pub cloudflare_target_count: usize,
    pub report: ShipkeyScanReport,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct OnePasswordProjectSyncResult {
    pub project_id: String,
    pub project_name: String,
    pub project_path: String,
    pub detected_keys: usize,
    pub success_keys: usize,
    pub failed_keys: usize,
    pub restored_file: Option<String>,
    pub message: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct OnePasswordSyncSummary {
    pub vault: String,
    pub env: String,
    pub total_projects: usize,
    pub processed_projects: usize,
    pub skipped_projects: usize,
    pub total_keys: usize,
    pub success_keys: usize,
    pub failed_keys: usize,
    pub results: Vec<OnePasswordProjectSyncResult>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MykeyCapability {
    pub id: String,
    pub description: String,
    pub requires_master_password: bool,
    pub mutating: bool,
    pub params: Vec<String>,
}

#[derive(Default)]
struct EnvScanResult {
    parsed_keys: Vec<ParsedKey>,
    total_files: usize,
    total_vars: usize,
    discovered_vars: HashSet<String>,
}

#[derive(Default)]
struct WorkflowScanResult {
    files: Vec<String>,
    secrets: Vec<String>,
}

#[derive(Default)]
struct WranglerScanResult {
    file: Option<String>,
    projects: Vec<String>,
    bindings: Vec<String>,
}

const QUICK_RESULT_EVENT: &str = "quick_result_updated";
const QUICK_RESULT_WINDOW_LABEL: &str = "quick-result";
const QUICK_TRANSLATE_ATTEMPTS_PER_PROVIDER: usize = 2;
const QUICK_SELECTION_POLL_INTERVAL_MS: u64 = 60;
const QUICK_SELECTION_MAX_POLLS: usize = 6;
const TRANSLATION_PROVIDERS: &[&str] = &[
    "google-translate",
    "google-translate-free",
    "deepl",
    "apple-translate",
    "microsoft-translate",
];
const OCR_PROVIDERS: &[&str] = &["apple-ocr", "ocr-space", "paddleocr"];

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QuickProviderOption {
    pub provider: String,
    pub label: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QuickProviderOptions {
    pub translate: Vec<QuickProviderOption>,
    pub ocr: Vec<QuickProviderOption>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QuickHotkeyDiagnostics {
    pub translate_hotkey: String,
    pub ocr_hotkey: String,
    pub translate_registered: bool,
    pub ocr_registered: bool,
    pub translate_parse_error: Option<String>,
    pub ocr_parse_error: Option<String>,
    pub last_trigger_shortcut: Option<String>,
    pub last_trigger_at: Option<String>,
    pub last_register_at: Option<String>,
    pub last_register_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MacosPermissionStatus {
    pub is_macos: bool,
    pub accessibility_granted: bool,
    pub automation_granted: bool,
    pub selection_capture_ready: bool,
    pub automation_error: Option<String>,
    pub guidance: String,
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

fn normalize_hotkey(value: &str, fallback: &str) -> String {
    let compact = value.replace(' ', "");
    let trimmed = compact.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn decode_html_entities(input: &str) -> String {
    input
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn normalize_google_lang(lang: &str, fallback: &str) -> String {
    let trimmed = lang.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        return fallback.to_string();
    }
    match trimmed {
        "zh-Hans" | "zh_CN" => "zh-CN".to_string(),
        "zh-Hant" | "zh_TW" => "zh-TW".to_string(),
        _ => trimmed.to_string(),
    }
}

fn normalize_deepl_lang(lang: &str, fallback: &str) -> String {
    let trimmed = lang.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        return fallback.to_string();
    }
    match trimmed.to_ascii_lowercase().as_str() {
        "zh-hans" | "zh-cn" => "ZH".to_string(),
        "zh-hant" | "zh-tw" => "ZH".to_string(),
        "pt-br" => "PT-BR".to_string(),
        "pt-pt" => "PT-PT".to_string(),
        _ => trimmed
            .split(['-', '_'])
            .next()
            .unwrap_or(trimmed)
            .to_ascii_uppercase(),
    }
}

fn quick_now() -> String {
    chrono::Local::now().to_rfc3339()
}

fn default_quick_settings() -> QuickActionSettings {
    let mut settings = QuickActionSettings::default();
    settings.updated_at = quick_now();
    settings
}

fn build_quick_error_result(
    action_type: &str,
    provider: &str,
    source_text: Option<String>,
    ocr_text: Option<String>,
    error_code: &str,
    error_message: String,
    latency_ms: i64,
    translate_provider: Option<String>,
    ocr_provider: Option<String>,
) -> QuickActionResult {
    QuickActionResult {
        action_type: action_type.to_string(),
        source_text,
        ocr_text,
        result_text: None,
        provider: provider.to_string(),
        translate_provider,
        ocr_provider,
        latency_ms,
        status: "error".to_string(),
        error_code: Some(error_code.to_string()),
        error_message: Some(error_message),
        created_at: quick_now(),
    }
}

fn resolve_quick_endpoint(provider: &ProviderConfig) -> String {
    if let Some(primary) = provider
        .endpoints
        .iter()
        .find(|endpoint| endpoint.is_primary && !endpoint.base_url.trim().is_empty())
    {
        return primary.base_url.trim().to_string();
    }
    if let Some(first) = provider
        .endpoints
        .iter()
        .find(|endpoint| !endpoint.base_url.trim().is_empty())
    {
        return first.base_url.trim().to_string();
    }
    provider.base_url.trim().to_string()
}

fn resolve_provider_auth(vault: &crate::vault::Vault, provider: &ProviderConfig) -> String {
    if !provider.api_key.trim().is_empty() {
        return provider.api_key.trim().to_string();
    }
    vault
        .get_latest_credential_for_provider(&provider.provider)
        .map(|cred| cred.key.trim().to_string())
        .filter(|key| !key.is_empty())
        .unwrap_or_default()
}

fn as_object_args(args: Option<Value>) -> Result<serde_json::Map<String, Value>, String> {
    match args {
        None => Ok(serde_json::Map::new()),
        Some(Value::Object(map)) => Ok(map),
        Some(_) => Err("args must be a JSON object".to_string()),
    }
}

fn required_string_arg(args: &serde_json::Map<String, Value>, key: &str) -> Result<String, String> {
    let value = args
        .get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("Missing required string arg: {}", key))?;
    Ok(value.to_string())
}

fn optional_string_arg(args: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
}

fn optional_i64_arg(args: &serde_json::Map<String, Value>, key: &str) -> Result<Option<i64>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| format!("Arg {} must be integer", key)),
    }
}

fn optional_usize_arg(
    args: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<usize>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(|v| v as usize)
            .map(Some)
            .ok_or_else(|| format!("Arg {} must be number", key)),
    }
}

fn optional_string_vec_arg(
    args: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<Vec<String>>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let list = value
                .as_array()
                .ok_or_else(|| format!("Arg {} must be an array", key))?;
            let mut out = Vec::new();
            for item in list {
                let next = item
                    .as_str()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| format!("Arg {} entries must be non-empty strings", key))?;
                out.push(next.to_string());
            }
            Ok(Some(out))
        }
    }
}

fn run_python_code_internal(
    code: &str,
    timeout_ms: Option<i64>,
    max_output_chars: Option<usize>,
    python_args: Option<Vec<String>>,
) -> Result<Value, String> {
    let code = code.trim();
    if code.is_empty() {
        return Err("Python code is empty".to_string());
    }
    if code.chars().count() > 20_000 {
        return Err("Python code exceeds max size".to_string());
    }

    if let Some(args) = &python_args {
        if args.len() > 12 {
            return Err("Too many Python args".to_string());
        }
        if args.iter().any(|item| item.len() > 300) {
            return Err("One Python arg exceeds max length".to_string());
        }
    }

    let python = if command_exists("python3") {
        "python3"
    } else if command_exists("python") {
        "python"
    } else {
        return Err("No Python runtime found in PATH".to_string());
    };

    let timeout = (timeout_ms.unwrap_or(30_000)).clamp(500, 120_000) as u64;
    let max_output_chars = (max_output_chars.unwrap_or(8_000)).clamp(256, 200_000);

    let temp_script = std::env::temp_dir().join(format!("mykey-python-{}.py", uuid::Uuid::new_v4()));
    fs::write(&temp_script, code).map_err(|e| format!("Failed to write Python script: {}", e))?;

    let mut cmd_args = Vec::with_capacity(1 + python_args.as_ref().map_or(0, Vec::len));
    cmd_args.push(temp_script.to_string_lossy().to_string());
    if let Some(args) = python_args {
        cmd_args.extend(args);
    }

    let started = Instant::now();
    let output = match run_command_with_timeout(python, &cmd_args, Duration::from_millis(timeout)) {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_file(&temp_script);
            return Err(error);
        }
    };
    let _ = fs::remove_file(&temp_script);

    let duration_ms = started.elapsed().as_millis() as u64;
    let stdout_raw = String::from_utf8_lossy(&output.stdout).to_string();
    let structured_output = extract_structured_output(&stdout_raw);
    let stderr_raw = String::from_utf8_lossy(&output.stderr).to_string();
    let stdout = truncate_text(&stdout_raw, max_output_chars);
    let stderr = truncate_text(&stderr_raw, max_output_chars);
    let exit_code = output.status.code().unwrap_or(-1);

    if !output.status.success() {
        let detail = if stderr.is_empty() {
            if stdout.is_empty() {
                format!("Python execution failed with code {}", exit_code)
            } else {
                format!("Python execution failed with code {}\nSTDOUT:\n{}", exit_code, stdout)
            }
        } else {
            format!("Python execution failed with code {}\nSTDERR:\n{}", exit_code, stderr)
        };
        return Err(detail);
    }

    let mut result = json!({
        "ok": true,
        "python": python,
        "exit_code": exit_code,
        "duration_ms": duration_ms,
        "stdout": stdout,
        "stderr": stderr,
    });

    if let Some(value) = structured_output {
        result["structured_output"] = value;
    }

    Ok(result)
}

fn extract_structured_output(raw: &str) -> Option<Value> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        return Some(value);
    }

    let code_block_re = Regex::new(r"(?is)```(?:json)?\s*([\s\S]*?)\s*```").ok()?;
    if let Some(caps) = code_block_re.captures(raw) {
        let block = caps.get(1).map(|m| m.as_str().trim());
        if let Some(value_str) = block {
            if let Ok(value) = serde_json::from_str::<Value>(value_str) {
                return Some(value);
            }
        }
    }

    None
}

#[tauri::command]
pub fn run_python_code(
    code: String,
    timeout_ms: Option<i64>,
    max_output_chars: Option<usize>,
    python_args: Option<Vec<String>>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    run_python_code_internal(&code, timeout_ms, max_output_chars, python_args)
}

#[tauri::command]
pub fn get_quick_action_settings(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<QuickActionSettings, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault
        .get_quick_action_settings()
        .map(|settings| {
            let mut normalized = settings;
            normalized.translate_hotkey = normalize_hotkey(&normalized.translate_hotkey, "Option+D");
            normalized.ocr_hotkey = normalize_hotkey(&normalized.ocr_hotkey, "Option+S");
            normalized
        })
        .or_else(|_| Ok(default_quick_settings()))
}

#[tauri::command]
pub fn set_quick_action_settings(
    settings: QuickActionSettings,
    master_password: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<QuickActionSettings, String> {
    let next = {
        let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
        if !vault.authenticate(&master_password) {
            return Err("Invalid master password".to_string());
        }
        vault.set_quick_action_settings(settings)?
    };

    register_quick_hotkeys_internal(&app, state.inner(), &next)?;
    update_quick_runtime_hotkeys(state.inner(), &next)?;
    Ok(next)
}

#[tauri::command]
pub fn register_quick_hotkeys(
    master_password: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let settings = {
        let vault = state.vault.lock().map_err(|e| e.to_string())?;
        if !vault.authenticate(&master_password) {
            return Err("Invalid master password".to_string());
        }
        vault
            .get_quick_action_settings()
            .unwrap_or_else(|_| default_quick_settings())
    };

    register_quick_hotkeys_internal(&app, state.inner(), &settings)?;
    update_quick_runtime_hotkeys(state.inner(), &settings)?;
    Ok(true)
}

#[tauri::command]
pub async fn trigger_quick_translate(
    text: Option<String>,
    master_password: String,
    app: tauri::AppHandle,
    preferred_translate_provider: Option<String>,
    state: State<'_, AppState>,
) -> Result<QuickActionResult, String> {
    {
        let vault = state.vault.lock().map_err(|e| e.to_string())?;
        if !vault.authenticate(&master_password) {
            return Err("Invalid master password".to_string());
        }
    }
    let result = run_quick_translate_pipeline(app, text, preferred_translate_provider).await;
    Ok(result)
}

#[tauri::command]
pub async fn trigger_quick_ocr(
    master_password: String,
    app: tauri::AppHandle,
    preferred_ocr_provider: Option<String>,
    preferred_translate_provider: Option<String>,
    state: State<'_, AppState>,
) -> Result<QuickActionResult, String> {
    {
        let vault = state.vault.lock().map_err(|e| e.to_string())?;
        if !vault.authenticate(&master_password) {
            return Err("Invalid master password".to_string());
        }
    }
    let result = run_quick_ocr_pipeline(
        app,
        preferred_ocr_provider,
        preferred_translate_provider,
    )
    .await;
    Ok(result)
}

#[tauri::command]
pub async fn retry_last_quick_action(
    app: tauri::AppHandle,
    preferred_translate_provider: Option<String>,
    preferred_ocr_provider: Option<String>,
    state: State<'_, AppState>,
) -> Result<QuickActionResult, String> {
    let snapshot = {
        let runtime = state.quick_runtime.lock().map_err(|e| e.to_string())?;
        (
            runtime.last_action_type.clone(),
            runtime.last_source_text.clone(),
            runtime.last_ocr_text.clone(),
            runtime.last_translate_provider.clone(),
            runtime.last_ocr_provider.clone(),
        )
    };

    let (
        action_type,
        last_source_text,
        _last_ocr_text,
        last_translate_provider,
        last_ocr_provider,
    ) = snapshot;
    let selected_translate_provider = preferred_translate_provider
        .or(last_translate_provider)
        .filter(|item| !item.trim().is_empty());
    let selected_ocr_provider = preferred_ocr_provider
        .or(last_ocr_provider)
        .filter(|item| !item.trim().is_empty());

    let result = match action_type.as_deref() {
        Some("ocr_translate") => {
            run_quick_ocr_pipeline(app.clone(), selected_ocr_provider, selected_translate_provider).await
        }
        Some("translate") => {
            if let Some(source_text) = last_source_text.clone().filter(|text| !text.trim().is_empty()) {
                run_quick_translate_core(
                    app.clone(),
                    "translate",
                    source_text,
                    None,
                    selected_translate_provider,
                    None,
                )
                .await
            } else {
                run_quick_translate_pipeline(app.clone(), None, None).await
            }
        }
        _ => run_quick_translate_pipeline(app.clone(), None, None).await,
    };
    Ok(result)
}

#[tauri::command]
pub fn hide_quick_result_panel(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window(QUICK_RESULT_WINDOW_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(true)
}

#[tauri::command]
pub fn get_last_quick_action_result(state: State<'_, AppState>) -> Result<Option<QuickActionResult>, String> {
    let runtime = state.quick_runtime.lock().map_err(|e| e.to_string())?;
    Ok(runtime.last_result.clone())
}

#[tauri::command]
pub fn get_quick_action_auto_close_seconds(state: State<'_, AppState>) -> Result<i64, String> {
    let settings = {
        let vault = state.vault.lock().map_err(|e| e.to_string())?;
        vault
            .get_quick_action_settings()
            .unwrap_or_else(|_| default_quick_settings())
    };
    Ok(settings.auto_close_seconds.clamp(3, 120))
}

#[tauri::command]
pub fn get_quick_action_history(
    limit: Option<i64>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Vec<QuickActionHistoryRecord>, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.get_quick_action_history(limit.unwrap_or(30))
}

#[tauri::command]
pub fn get_quick_hotkey_diagnostics(
    master_password: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<QuickHotkeyDiagnostics, String> {
    let settings = {
        let vault = state.vault.lock().map_err(|e| e.to_string())?;
        if !vault.authenticate(&master_password) {
            return Err("Invalid master password".to_string());
        }
        vault
            .get_quick_action_settings()
            .unwrap_or_else(|_| default_quick_settings())
    };

    let (last_trigger_shortcut, last_trigger_at, last_register_at, last_register_error) = {
        let runtime = state.quick_runtime.lock().map_err(|e| e.to_string())?;
        (
            runtime.last_trigger_shortcut.clone(),
            runtime.last_trigger_at.clone(),
            runtime.last_register_at.clone(),
            runtime.last_register_error.clone(),
        )
    };

    let translate_raw = normalize_hotkey(&settings.translate_hotkey, "Option+D");
    let ocr_raw = normalize_hotkey(&settings.ocr_hotkey, "Option+S");

    let (translate_registered, translate_parse_error) = match Shortcut::from_str(&translate_raw) {
        Ok(shortcut) => (app.global_shortcut().is_registered(shortcut), None),
        Err(error) => (false, Some(error.to_string())),
    };
    let (ocr_registered, ocr_parse_error) = match Shortcut::from_str(&ocr_raw) {
        Ok(shortcut) => (app.global_shortcut().is_registered(shortcut), None),
        Err(error) => (false, Some(error.to_string())),
    };

    Ok(QuickHotkeyDiagnostics {
        translate_hotkey: translate_raw,
        ocr_hotkey: ocr_raw,
        translate_registered,
        ocr_registered,
        translate_parse_error,
        ocr_parse_error,
        last_trigger_shortcut,
        last_trigger_at,
        last_register_at,
        last_register_error,
    })
}

#[tauri::command]
pub fn get_quick_provider_options(state: State<'_, AppState>) -> Result<QuickProviderOptions, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    let providers = vault.get_providers();
    let mut translate = Vec::new();
    let mut ocr = Vec::new();

    for provider in providers.iter() {
        if !provider.is_active {
            continue;
        }
        if TRANSLATION_PROVIDERS.contains(&provider.provider.as_str()) {
        if !translate.iter().any(|item: &QuickProviderOption| item.provider == provider.provider) {
                translate.push(QuickProviderOption {
                    provider: provider.provider.clone(),
                    label: provider.label.clone(),
                });
            }
            continue;
        }
        if OCR_PROVIDERS.contains(&provider.provider.as_str()) {
        if !ocr.iter().any(|item: &QuickProviderOption| item.provider == provider.provider) {
                ocr.push(QuickProviderOption {
                    provider: provider.provider.clone(),
                    label: provider.label.clone(),
                });
            }
        }
    }

    for provider_id in TRANSLATION_PROVIDERS {
        if translate.iter().any(|item| item.provider == *provider_id) {
            continue;
        }
        if let Some(provider) = vault.get_provider_config(provider_id) {
            if provider.is_active {
                translate.push(QuickProviderOption {
                    provider: provider.provider.clone(),
                    label: provider.label.clone(),
                });
            }
        }
    }

    for provider_id in OCR_PROVIDERS {
        if ocr.iter().any(|item| item.provider == *provider_id) {
            continue;
        }
        if let Some(provider) = vault.get_provider_config(provider_id) {
            if provider.is_active {
                ocr.push(QuickProviderOption {
                    provider: provider.provider.clone(),
                    label: provider.label.clone(),
                });
            }
        }
    }

    translate.sort_by(|a, b| a.label.cmp(&b.label));
    ocr.sort_by(|a, b| a.label.cmp(&b.label));

    Ok(QuickProviderOptions { translate, ocr })
}

#[tauri::command]
pub fn get_macos_permission_status() -> Result<MacosPermissionStatus, String> {
    #[cfg(target_os = "macos")]
    {
        let accessibility_granted = unsafe { AXIsProcessTrusted() };
        let automation_probe = Command::new("osascript")
            .arg("-e")
            .arg(r#"tell application "System Events" to get name of first process"#)
            .output()
            .map_err(|e| format!("Failed to probe automation permission: {}", e))?;
        let automation_error = if automation_probe.status.success() {
            None
        } else {
            let detail = String::from_utf8_lossy(&automation_probe.stderr)
                .trim()
                .to_string();
            Some(if detail.is_empty() {
                "System Events automation is not authorized".to_string()
            } else {
                detail
            })
        };
        let automation_granted = automation_error.is_none();

        return Ok(MacosPermissionStatus {
            is_macos: true,
            accessibility_granted,
            automation_granted,
            selection_capture_ready: accessibility_granted && automation_granted,
            automation_error,
            guidance: "系统设置 -> 隐私与安全性 -> 辅助功能（MyKey）与 自动化（MyKey -> System Events）".to_string(),
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(MacosPermissionStatus {
            is_macos: false,
            accessibility_granted: false,
            automation_granted: false,
            selection_capture_ready: false,
            automation_error: None,
            guidance: "当前系统不是 macOS，无需检查该权限".to_string(),
        })
    }
}

#[tauri::command]
pub fn open_macos_accessibility_settings() -> Result<bool, String> {
    open_macos_settings_url("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
}

#[tauri::command]
pub fn open_macos_automation_settings() -> Result<bool, String> {
    open_macos_settings_url("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
}

#[tauri::command]
pub fn open_macos_screen_capture_settings() -> Result<bool, String> {
    open_macos_settings_url("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
}

pub fn dispatch_quick_shortcut(app: &tauri::AppHandle, shortcut: &Shortcut) {
    let state = app.state::<AppState>();
    let (translate_hotkey, ocr_hotkey) = {
        let mut runtime = match state.quick_runtime.lock() {
            Ok(value) => value,
            Err(_) => return,
        };
        runtime.last_trigger_shortcut = Some(shortcut.to_string());
        runtime.last_trigger_at = Some(quick_now());
        (runtime.translate_hotkey.clone(), runtime.ocr_hotkey.clone())
    };

    let translate = match Shortcut::from_str(&translate_hotkey) {
        Ok(value) => value,
        Err(_) => return,
    };
    let ocr = match Shortcut::from_str(&ocr_hotkey) {
        Ok(value) => value,
        Err(_) => return,
    };
    let app_handle = app.clone();

    if shortcut.id() == translate.id() {
        tauri::async_runtime::spawn(async move {
            let _ = run_quick_translate_pipeline(app_handle, None, None).await;
        });
    } else if shortcut.id() == ocr.id() {
        tauri::async_runtime::spawn(async move {
            let _ = run_quick_ocr_pipeline(app_handle, None, None).await;
        });
    }
}

pub fn register_quick_hotkeys_on_startup(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let settings = resolve_quick_settings(state.inner());
    register_quick_hotkeys_internal(app, state.inner(), &settings)?;
    update_quick_runtime_hotkeys(state.inner(), &settings)?;
    Ok(())
}

fn update_quick_runtime_hotkeys(state: &AppState, settings: &QuickActionSettings) -> Result<(), String> {
    let mut runtime = state.quick_runtime.lock().map_err(|e| e.to_string())?;
    runtime.translate_hotkey = normalize_hotkey(&settings.translate_hotkey, "Option+D");
    runtime.ocr_hotkey = normalize_hotkey(&settings.ocr_hotkey, "Option+S");
    Ok(())
}

fn set_quick_register_status(state: &AppState, error: Option<String>) {
    if let Ok(mut runtime) = state.quick_runtime.lock() {
        runtime.last_register_at = Some(quick_now());
        runtime.last_register_error = error;
    }
}

fn register_quick_hotkeys_internal(
    app: &tauri::AppHandle,
    state: &AppState,
    settings: &QuickActionSettings,
) -> Result<(), String> {
    let mut shortcuts = vec![
        normalize_hotkey(&settings.translate_hotkey, "Option+D"),
        normalize_hotkey(&settings.ocr_hotkey, "Option+S"),
    ];
    shortcuts.dedup();

    if let Err(error) = app.global_shortcut().unregister_all() {
        let message = error.to_string();
        set_quick_register_status(state, Some(message.clone()));
        return Err(message);
    }
    for accelerator in shortcuts {
        let shortcut = Shortcut::from_str(&accelerator)
            .map_err(|e| {
                let msg = format!("Invalid hotkey '{}': {}", accelerator, e);
                set_quick_register_status(state, Some(msg.clone()));
                msg
            })?;
        if let Err(error) = app.global_shortcut().register(shortcut) {
            let msg = format!("Failed to register '{}': {}", accelerator, error);
            set_quick_register_status(state, Some(msg.clone()));
            return Err(msg);
        }
    }
    update_quick_runtime_hotkeys(state, settings)?;
    set_quick_register_status(state, None);
    Ok(())
}

fn resolve_quick_settings(state: &AppState) -> QuickActionSettings {
    match state.vault.lock() {
        Ok(vault) => vault
            .get_quick_action_settings()
            .unwrap_or_else(|_| default_quick_settings()),
        Err(_) => default_quick_settings(),
    }
}

async fn run_quick_translate_pipeline(
    app: tauri::AppHandle,
    text: Option<String>,
    preferred_translate_provider: Option<String>,
) -> QuickActionResult {
    let started = std::time::Instant::now();
    let source_text = match text
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        Some(value) => value,
        None => match capture_selected_text_with_fallback() {
            Ok(value) => value,
            Err(error) => {
                let result = build_quick_error_result(
                    "translate",
                    "selection",
                    None,
                    None,
                    "capture_failed",
                    error,
                    started.elapsed().as_millis() as i64,
                    None,
                    None,
                );
                persist_and_emit_quick_result(&app, &result);
                return result;
            }
        },
    };

    let result =
        run_quick_translate_core(
            app.clone(),
            "translate",
            source_text,
            None,
            preferred_translate_provider,
            None,
        )
        .await;
    result
}

async fn run_quick_translate_core(
    app: tauri::AppHandle,
    action_type: &str,
    source_text: String,
    ocr_text: Option<String>,
    preferred_translate_provider: Option<String>,
    ocr_provider: Option<String>,
) -> QuickActionResult {
    let started = std::time::Instant::now();
    let state = app.state::<AppState>();
    let settings = resolve_quick_settings(state.inner());
    let (source_text, ocr_text) = if action_type == "ocr_translate" {
        let normalized_source = sanitize_ocr_text(&source_text);
        let normalized_ocr = ocr_text
            .as_ref()
            .map(|text| sanitize_ocr_text(text))
            .filter(|text| !text.trim().is_empty());
        (normalized_source, normalized_ocr)
    } else {
        (source_text, ocr_text)
    };

    if action_type == "ocr_translate" && source_text.trim().is_empty() {
        let result = build_quick_error_result(
            "ocr_translate",
            "ocr",
            None,
            None,
            "ocr_empty",
            "OCR did not detect any usable text".to_string(),
            started.elapsed().as_millis() as i64,
            None,
            ocr_provider.clone(),
        );
        persist_and_emit_quick_result(&app, &result);
        return result;
    }

    let (translate_provider, translate_api_key, translate_provider_id) = {
        let vault = match state.vault.lock() {
            Ok(value) => value,
            Err(error) => {
                let result = build_quick_error_result(
                    action_type,
                    "translation",
                    Some(source_text),
                    ocr_text,
                    "vault_lock_failed",
                    error.to_string(),
                    started.elapsed().as_millis() as i64,
                    None,
                    ocr_provider.clone(),
                );
                persist_and_emit_quick_result(&app, &result);
                return result;
            }
        };
        let request_translate_provider = preferred_translate_provider
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| settings.default_translate_provider.clone());
        let provider = match resolve_quick_provider(
            &vault,
            &request_translate_provider,
            TRANSLATION_PROVIDERS,
            "google-translate",
        ) {
            Ok(value) => value,
            Err(error) => {
                let result = build_quick_error_result(
                    action_type,
                    "translation",
                    Some(source_text),
                    ocr_text,
                    "provider_not_found",
                    error,
                    started.elapsed().as_millis() as i64,
                    None,
                    ocr_provider.clone(),
                );
                persist_and_emit_quick_result(&app, &result);
                return result;
            }
        };
        let auth = resolve_provider_auth(&vault, &provider);
        (provider.clone(), auth, provider.provider.clone())
    };

    let translated = match translate_text_with_provider(
        &translate_provider,
        &translate_api_key,
        &settings,
        &source_text,
    )
    .await
    {
        Ok(result_text) => Ok((translate_provider_id.clone(), result_text)),
        Err(error) => {
            let (fallback, fallback_errors) = try_translate_fallbacks(
                state.inner(),
                &settings,
                &source_text,
                &translate_provider_id,
                &TRANSLATION_PROVIDERS,
            )
            .await;
            match fallback {
                Some((provider_id, translated)) => Ok((provider_id, translated)),
                None => {
                    let mut detail = error;
                    if !fallback_errors.is_empty() {
                        detail = format!("{}; {}", detail, fallback_errors.join(" ; "));
                    }
                    Err(build_quick_error_result(
                        action_type,
                        &translate_provider_id,
                        Some(source_text),
                        ocr_text,
                        "translate_failed",
                        detail,
                        started.elapsed().as_millis() as i64,
                        Some(translate_provider_id.clone()),
                        ocr_provider,
                    ))
                }
            }
        }
    };

    let result = match translated {
        Ok((provider_id, result_text)) => QuickActionResult {
            action_type: action_type.to_string(),
            source_text: Some(source_text),
            ocr_text,
            result_text: Some(result_text),
            provider: provider_id.clone(),
            translate_provider: Some(provider_id),
            ocr_provider,
            latency_ms: started.elapsed().as_millis() as i64,
            status: "success".to_string(),
            error_code: None,
            error_message: None,
            created_at: quick_now(),
        },
        Err(result) => result,
    };
    persist_and_emit_quick_result(&app, &result);
    result
}

async fn run_quick_ocr_pipeline(
    app: tauri::AppHandle,
    preferred_ocr_provider: Option<String>,
    preferred_translate_provider: Option<String>,
) -> QuickActionResult {
    let started = std::time::Instant::now();
    let capture_path = match capture_interactive_screenshot() {
        Ok(path) => path,
        Err(error) => {
            let result = build_quick_error_result(
                "ocr_translate",
                "screenshot",
                None,
                None,
                "capture_failed",
                error,
                started.elapsed().as_millis() as i64,
                None,
                None,
            );
            persist_and_emit_quick_result(&app, &result);
            return result;
        }
    };

    let state = app.state::<AppState>();
    let settings = resolve_quick_settings(state.inner());
    let request_ocr_provider = preferred_ocr_provider
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| settings.default_ocr_provider.clone());
    let (ocr_provider, ocr_api_key) = {
        let vault = match state.vault.lock() {
            Ok(value) => value,
            Err(error) => {
                let result = build_quick_error_result(
                    "ocr_translate",
                    "ocr",
                    None,
                    None,
                    "vault_lock_failed",
                    error.to_string(),
                    started.elapsed().as_millis() as i64,
                    None,
                    None,
                );
                persist_and_emit_quick_result(&app, &result);
                return result;
            }
        };
        let provider = match resolve_quick_provider(
            &vault,
            &request_ocr_provider,
            OCR_PROVIDERS,
            "apple-ocr",
        ) {
            Ok(value) => value,
            Err(error) => {
                let result = build_quick_error_result(
                    "ocr_translate",
                    "ocr",
                    None,
                    None,
                    "provider_not_found",
                    error,
                    started.elapsed().as_millis() as i64,
                    None,
                    Some(request_ocr_provider),
                );
                persist_and_emit_quick_result(&app, &result);
                return result;
            }
        };
        let auth = resolve_provider_auth(&vault, &provider);
        (provider, auth)
    };

    let fallback_provider_order = ["apple-ocr", "paddleocr", "ocr-space"];
    let mut ocr_provider_id = ocr_provider.provider.clone();
    let mut ocr_text = match run_ocr_with_provider(&ocr_provider, &ocr_api_key, &capture_path).await {
        Ok(text) => sanitize_ocr_text(&text),
        Err(error) => {
            let (fallback, fallback_errors) = try_ocr_fallbacks(
                state.inner(),
                &capture_path,
                &ocr_provider_id,
                &fallback_provider_order,
            )
            .await;
            if let Some((provider_id, text)) = fallback {
                ocr_provider_id = provider_id;
                text
            } else {
                let mut detail = format!("{} failed: {}", ocr_provider.provider, error);
                if !fallback_errors.is_empty() {
                    detail.push_str(" ; ");
                    detail.push_str(&fallback_errors.join(" ; "));
                }
                let result = build_quick_error_result(
                    "ocr_translate",
                    &ocr_provider_id,
                    None,
                    None,
                    "ocr_failed",
                    detail,
                    started.elapsed().as_millis() as i64,
                    None,
                    Some(ocr_provider_id.clone()),
                );
                persist_and_emit_quick_result(&app, &result);
                let _ = fs::remove_file(&capture_path);
                return result;
            }
        }
    };

    if ocr_text.trim().is_empty() {
        let (fallback, fallback_errors) = try_ocr_fallbacks(
            state.inner(),
            &capture_path,
            &ocr_provider_id,
            &fallback_provider_order,
        )
        .await;
        if let Some((_provider_id, text)) = fallback {
            ocr_text = text;
        } else {
            let detail = if fallback_errors.is_empty() {
                "OCR did not detect any text".to_string()
            } else {
                format!(
                    "OCR did not detect any text ; {}",
                    fallback_errors.join(" ; ")
                )
            };
            let result = build_quick_error_result(
                "ocr_translate",
                &ocr_provider_id,
                None,
                None,
                "ocr_empty",
                detail,
                started.elapsed().as_millis() as i64,
                None,
                Some(ocr_provider_id.clone()),
            );
            persist_and_emit_quick_result(&app, &result);
            let _ = fs::remove_file(&capture_path);
            return result;
        }
    }
    let _ = fs::remove_file(&capture_path);

    run_quick_translate_core(
        app,
        "ocr_translate",
        ocr_text.clone(),
        Some(ocr_text),
        preferred_translate_provider,
        Some(ocr_provider_id),
    )
    .await
}

fn persist_and_emit_quick_result(app: &tauri::AppHandle, result: &QuickActionResult) {
    let state = app.state::<AppState>();
    if let Ok(vault) = state.vault.lock() {
        let _ = vault.append_quick_action_history(result);
    }
    if let Ok(mut runtime) = state.quick_runtime.lock() {
        runtime.last_action_type = Some(result.action_type.clone());
        runtime.last_source_text = result.source_text.clone();
        runtime.last_ocr_text = result.ocr_text.clone();
        runtime.last_translate_provider = result.translate_provider.clone();
        runtime.last_ocr_provider = result.ocr_provider.clone();
        runtime.last_result = Some(result.clone());
    }
    let _ = ensure_quick_result_window(app);
    if let Some(window) = app.get_webview_window(QUICK_RESULT_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.emit(QUICK_RESULT_EVENT, result);
    }
}

fn ensure_quick_result_window(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window(QUICK_RESULT_WINDOW_LABEL).is_some() {
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        app,
        QUICK_RESULT_WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html#/quick-result".into()),
    )
    .title("MyKey Quick Result")
    .inner_size(560.0, 420.0)
    .min_inner_size(440.0, 320.0)
    .visible(false)
    .always_on_top(true)
    .decorations(true)
    .skip_taskbar(true)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn run_command_with_timeout(
    command: &str,
    args: &[String],
    timeout: Duration,
) -> Result<Output, String> {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start {}: {}", command, e))?;
    let started = std::time::Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|e| format!("Failed to read {} output: {}", command, e));
            }
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "{} timed out after {}s",
                        command,
                        timeout.as_secs()
                    ));
                }
                thread::sleep(Duration::from_millis(80));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Failed while waiting {}: {}", command, error));
            }
        }
    }
}

fn resolve_quick_provider(
    vault: &crate::vault::Vault,
    preferred: &str,
    category_defaults: &[&str],
    fallback: &str,
) -> Result<ProviderConfig, String> {
    if let Some(config) = vault.get_provider_config(preferred) {
        return Ok(config);
    }
    for provider in category_defaults {
        if let Some(config) = vault.get_provider_config(provider) {
            return Ok(config);
        }
    }
    if let Some(config) = vault.get_provider_config(fallback) {
        return Ok(config);
    }
    vault
        .get_providers()
        .into_iter()
        .next()
        .ok_or_else(|| "No provider configured".to_string())
}

fn capture_selected_text_with_fallback() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let original_clipboard = read_clipboard_text().ok();
        let copy_error = trigger_copy_shortcut().err();
        let mut selected = String::new();
        if copy_error.is_none() {
            for _ in 0..6 {
                thread::sleep(Duration::from_millis(50));
                if let Ok(candidate) = read_clipboard_text() {
                    let candidate_trimmed = candidate.trim().to_string();
                    if candidate_trimmed.is_empty() {
                        continue;
                    }
                    if original_clipboard
                        .as_ref()
                        .map(|item| item.trim() != candidate_trimmed)
                        .unwrap_or(true)
                    {
                        selected = candidate_trimmed;
                        break;
                    }
                }
            }
        }
        if selected.is_empty() {
            selected = original_clipboard
                .as_ref()
                .map(|value| value.trim().to_string())
                .unwrap_or_default();
        }
        if let Some(original) = original_clipboard.as_ref() {
            let _ = write_clipboard_text(original);
        }
        if selected.is_empty() && copy_error.is_some() {
            return Err(format!(
                "{}；已尝试回退剪贴板但为空。{}",
                copy_error.unwrap_or_default(),
                selection_permission_hint()
            ));
        }
        if selected.is_empty() {
            return Err("No selected text detected. Please select text and try again.".to_string());
        }
        Ok(selected)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Quick selection capture currently supports macOS only".to_string())
    }
}

#[cfg(target_os = "macos")]
fn trigger_copy_shortcut() -> Result<(), String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(r#"tell application "System Events" to keystroke "c" using command down"#)
        .output()
        .map_err(|e| format!("Failed to execute copy shortcut: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "Failed to capture selected text. {}",
                selection_permission_hint()
            )
        } else {
            format!(
                "Failed to capture selected text: {}. {}",
                stderr,
                selection_permission_hint()
            )
        });
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn selection_permission_hint() -> &'static str {
    "请在“系统设置 -> 隐私与安全性 -> 辅助功能”中给 MyKey 授权，并在“自动化”中允许 MyKey 控制“System Events”"
}

#[cfg(target_os = "macos")]
fn read_clipboard_text() -> Result<String, String> {
    let output = Command::new("pbpaste")
        .output()
        .map_err(|e| format!("Failed to read clipboard: {}", e))?;
    if !output.status.success() {
        return Err("Failed to read clipboard".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(target_os = "macos")]
fn write_clipboard_text(content: &str) -> Result<(), String> {
    let mut process = Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to write clipboard: {}", e))?;
    if let Some(stdin) = process.stdin.as_mut() {
        stdin
            .write_all(content.as_bytes())
            .map_err(|e| format!("Failed to write clipboard stdin: {}", e))?;
    }
    let status = process.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Failed to write clipboard".to_string());
    }
    Ok(())
}

fn capture_interactive_screenshot() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let path = std::env::temp_dir().join(format!(
            "mykey-quick-{}.png",
            uuid::Uuid::new_v4()
        ));
        let status = Command::new("screencapture")
            .arg("-i")
            .arg("-x")
            .arg(&path)
            .status()
            .map_err(|e| format!("Failed to execute screencapture: {}", e))?;
        if !status.success() {
            return Err("Screenshot capture canceled or failed".to_string());
        }
        if !path.exists() {
            return Err("Screenshot capture was canceled".to_string());
        }
        Ok(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Quick screenshot OCR currently supports macOS only".to_string())
    }
}

async fn translate_text_with_provider(
    provider: &ProviderConfig,
    api_key: &str,
    settings: &QuickActionSettings,
    text: &str,
) -> Result<String, String> {
    match provider.provider.as_str() {
        "apple-translate" => translate_with_apple_shortcut(text, settings),
        "deepl" => translate_with_deepl(provider, api_key, settings, text).await,
        "google-translate" | "google-translate-free" => {
            translate_with_google(provider, api_key, settings, text).await
        }
        _ => translate_with_openai_compatible(provider, api_key, settings, text).await,
    }
}

fn translate_with_apple_shortcut(
    text: &str,
    _settings: &QuickActionSettings,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let input_path = std::env::temp_dir().join(format!(
            "mykey-translate-input-{}.txt",
            uuid::Uuid::new_v4()
        ));
        let output_path = std::env::temp_dir().join(format!(
            "mykey-translate-output-{}.txt",
            uuid::Uuid::new_v4()
        ));
        fs::write(&input_path, text).map_err(|e| e.to_string())?;

        let shortcut_candidates = ["Bob.Translate.v2", "Bob.Translate.v1"];
        let mut last_error = "Unable to run Apple Translate shortcut".to_string();
        for shortcut in shortcut_candidates {
            let args = vec![
                "run".to_string(),
                shortcut.to_string(),
                "--input-path".to_string(),
                input_path.to_string_lossy().to_string(),
                "--output-path".to_string(),
                output_path.to_string_lossy().to_string(),
                "--output-type".to_string(),
                "public.plain-text".to_string(),
            ];
            let output = run_command_with_timeout("shortcuts", &args, Duration::from_secs(25));

            match output {
                Ok(result) if result.status.success() => {
                    let stdout_text = String::from_utf8_lossy(&result.stdout).trim().to_string();
                    let from_file = fs::read_to_string(&output_path)
                        .unwrap_or_default()
                        .trim()
                        .to_string();
                    let translated = if !from_file.is_empty() {
                        from_file
                    } else {
                        stdout_text
                    };
                    let _ = fs::remove_file(&input_path);
                    let _ = fs::remove_file(&output_path);
                    if translated.is_empty() {
                        last_error = format!(
                            "Apple Translate returned empty text. Verify shortcut {} output.",
                            shortcut
                        );
                        continue;
                    }
                    return Ok(translated);
                }
                Ok(result) => {
                    let stderr_text = String::from_utf8_lossy(&result.stderr).trim().to_string();
                    last_error = if stderr_text.is_empty() {
                        format!("Shortcut {} failed", shortcut)
                    } else {
                        format!("Shortcut {} failed: {}", shortcut, stderr_text)
                    };
                }
                Err(err) => {
                    last_error = format!("Failed to run shortcuts CLI: {}", err);
                }
            }
        }

        let _ = fs::remove_file(&input_path);
        let _ = fs::remove_file(&output_path);
        Err(format!(
            "{}. 请确认已安装 Bob.Translate.v2 快捷指令，并在 macOS“隐私与安全性”中授权自动化。",
            last_error
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = _settings;
        let _ = text;
        Err("Apple Translate provider only supports macOS".to_string())
    }
}

async fn translate_with_deepl(
    provider: &ProviderConfig,
    api_key: &str,
    settings: &QuickActionSettings,
    text: &str,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("DeepL API key is required".to_string());
    }
    let mut endpoint = resolve_quick_endpoint(provider);
    if endpoint.is_empty() {
        endpoint = "https://api-free.deepl.com/v2".to_string();
    }
    let url = if endpoint.contains("/translate") {
        endpoint
    } else {
        format!("{}/translate", endpoint.trim_end_matches('/'))
    };

    let mut payload: Vec<(&str, String)> = vec![
        ("text", text.to_string()),
        (
            "target_lang",
            normalize_deepl_lang(&settings.target_lang, "ZH"),
        ),
    ];
    let source_lang = normalize_deepl_lang(&settings.source_lang, "");
    if !source_lang.is_empty() {
        payload.push(("source_lang", source_lang));
    }

    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?
        .post(&url)
        .header("Authorization", format!("DeepL-Auth-Key {}", api_key.trim()))
        .form(&payload)
        .send()
        .await
        .map_err(|e| format!("DeepL request failed: {}", e))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
    if !status.is_success() {
        let detail = extract_error_message(&parsed).unwrap_or_else(|| truncate_text(&body, 160));
        return Err(format!("DeepL HTTP {}: {}", status.as_u16(), detail));
    }

    let translated = parsed
        .get("translations")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("text"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if translated.is_empty() {
        return Err("DeepL returned empty translation".to_string());
    }
    Ok(translated)
}

async fn translate_with_google(
    provider: &ProviderConfig,
    api_key: &str,
    settings: &QuickActionSettings,
    text: &str,
) -> Result<String, String> {
    if provider.provider == "google-translate-free" || api_key.trim().is_empty() {
        let source = normalize_google_lang(&settings.source_lang, "auto");
        let target = normalize_google_lang(&settings.target_lang, "zh-CN");
        let response = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?
            .get("https://translate.googleapis.com/translate_a/single")
            .query(&[
                ("client", "gtx"),
                ("sl", source.as_str()),
                ("tl", target.as_str()),
                ("dt", "t"),
                ("q", text),
            ])
            .send()
            .await
            .map_err(|e| format!("Google Translate free request failed: {}", e))?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("Google Translate free HTTP {}", status.as_u16()));
        }
        let parsed = serde_json::from_str::<Value>(&body).map_err(|e| e.to_string())?;
        let translated = parsed
            .as_array()
            .and_then(|root| root.first())
            .and_then(|first| first.as_array())
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        row.as_array()
                            .and_then(|parts| parts.first())
                            .and_then(|value| value.as_str())
                    })
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();
        let normalized = decode_html_entities(translated.trim());
        if normalized.is_empty() {
            return Err("Google Translate free returned empty translation".to_string());
        }
        return Ok(normalized);
    }

    let mut endpoint = resolve_quick_endpoint(provider);
    if endpoint.is_empty() {
        endpoint = "https://translation.googleapis.com/language/translate/v2".to_string();
    }
    let url = if endpoint.contains("/language/translate/v2") {
        endpoint
    } else {
        format!(
            "{}/language/translate/v2",
            endpoint.trim_end_matches('/')
        )
    };
    let source = normalize_google_lang(&settings.source_lang, "auto");
    let target = normalize_google_lang(&settings.target_lang, "zh-CN");
    let mut payload: Vec<(&str, String)> = vec![
        ("q", text.to_string()),
        ("target", target),
        ("format", "text".to_string()),
    ];
    if source != "auto" {
        payload.push(("source", source));
    }

    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?
        .post(&url)
        .query(&[("key", api_key.trim())])
        .form(&payload)
        .send()
        .await
        .map_err(|e| format!("Google Translate request failed: {}", e))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
    if !status.is_success() {
        let detail = extract_error_message(&parsed).unwrap_or_else(|| truncate_text(&body, 160));
        return Err(format!("Google Translate HTTP {}: {}", status.as_u16(), detail));
    }
    let translated = parsed
        .get("data")
        .and_then(|value| value.get("translations"))
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("translatedText"))
        .and_then(|value| value.as_str())
        .map(decode_html_entities)
        .unwrap_or_default();
    if translated.trim().is_empty() {
        return Err("Google Translate returned empty text".to_string());
    }
    Ok(translated.trim().to_string())
}

async fn translate_with_openai_compatible(
    provider: &ProviderConfig,
    api_key: &str,
    settings: &QuickActionSettings,
    text: &str,
) -> Result<String, String> {
    let endpoint = resolve_quick_endpoint(provider);
    if endpoint.trim().is_empty() {
        return Err(format!("Provider {} has no endpoint configured", provider.provider));
    }
    let url = if endpoint.ends_with("/chat/completions") {
        endpoint
    } else if endpoint.ends_with("/v1") {
        format!("{}/chat/completions", endpoint.trim_end_matches('/'))
    } else {
        format!("{}/v1/chat/completions", endpoint.trim_end_matches('/'))
    };
    let model = if !provider.details.main_model.trim().is_empty() {
        provider.details.main_model.trim().to_string()
    } else if let Some(first_model) = provider.models.first() {
        first_model.to_string()
    } else {
        "gpt-4o-mini".to_string()
    };

    let primary_headers = provider
        .endpoints
        .iter()
        .find(|endpoint| endpoint.is_primary)
        .and_then(|endpoint| endpoint.headers.as_deref());
    let mut headers = parse_headers(primary_headers);
    if !api_key.trim().is_empty() {
        if !headers.contains_key(AUTHORIZATION) {
            let bearer = format!("Bearer {}", api_key.trim());
            if let Ok(value) = HeaderValue::from_str(&bearer) {
                headers.insert(AUTHORIZATION, value);
            }
        }
        if !headers.contains_key("x-api-key") {
            if let Ok(value) = HeaderValue::from_str(api_key.trim()) {
                headers.insert("x-api-key", value);
            }
        }
    }
    if !headers.contains_key("content-type") {
        headers.insert("content-type", HeaderValue::from_static("application/json"));
    }
    let system_prompt = format!(
        "You are a precise translator. Source language hint: {}. Target language: {}. Output translation only.",
        settings.source_lang, settings.target_lang
    );
    let payload = json!({
        "model": model,
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": system_prompt
            },
            {
                "role": "user",
                "content": text
            }
        ]
    });
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?
        .post(&url)
        .headers(headers)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Provider request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
    if !status.is_success() {
        let detail = extract_error_message(&parsed).unwrap_or_else(|| truncate_text(&body, 160));
        return Err(format!("Provider HTTP {}: {}", status.as_u16(), detail));
    }

    if let Some(content) = parsed
        .get("choices")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("message"))
        .and_then(|item| item.get("content"))
        .and_then(|value| value.as_str())
    {
        let trimmed = content.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    if let Some(text) = extract_codex_text(&parsed) {
        if !text.trim().is_empty() {
            return Ok(text.trim().to_string());
        }
    }
    Err("Provider returned empty translation".to_string())
}

async fn run_ocr_with_provider(
    provider: &ProviderConfig,
    api_key: &str,
    image_path: &Path,
) -> Result<String, String> {
    match provider.provider.as_str() {
        "apple-ocr" => ocr_with_apple_vision(image_path),
        "ocr-space" => ocr_with_ocr_space(provider, api_key, image_path).await,
        "paddleocr" => ocr_with_paddleocr(provider, api_key, image_path).await,
        _ => ocr_with_apple_vision(image_path),
    }
}

fn ocr_with_apple_vision(image_path: &Path) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let swift_script = r#"import Foundation
import Vision
import AppKit

let arguments = CommandLine.arguments
guard arguments.count > 1 else {
  FileHandle.standardError.write(Data("Missing image path\n".utf8))
  exit(2)
}
let imagePath = arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard let nsImage = NSImage(contentsOf: imageURL),
      let tiff = nsImage.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let cgImage = bitmap.cgImage else {
  FileHandle.standardError.write(Data("Failed to load image\n".utf8))
  exit(3)
}

func recognize(level: VNRequestTextRecognitionLevel, correction: Bool) throws -> [String] {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = level
  request.usesLanguageCorrection = correction
  request.minimumTextHeight = 0.008
  request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US", "ja-JP"]
  if #available(macOS 13.0, *) {
    request.automaticallyDetectsLanguage = true
  }
  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  try handler.perform([request])

  let observations = request.results as? [VNRecognizedTextObservation] ?? []
  let sorted = observations.sorted { lhs, rhs in
    let yDelta = abs(lhs.boundingBox.origin.y - rhs.boundingBox.origin.y)
    if yDelta > 0.02 {
      return lhs.boundingBox.origin.y > rhs.boundingBox.origin.y
    }
    return lhs.boundingBox.origin.x < rhs.boundingBox.origin.x
  }
  return sorted.compactMap { obs -> String? in
    obs.topCandidates(1).first?.string
  }
}

do {
  var lines = try recognize(level: .accurate, correction: true)
  if lines.isEmpty {
    lines = try recognize(level: .fast, correction: false)
  }
  let output = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
  FileHandle.standardOutput.write(Data(output.utf8))
} catch {
  FileHandle.standardError.write(Data("Vision request failed: \(error.localizedDescription)\n".utf8))
  exit(4)
}
"#;

        let script_path = std::env::temp_dir().join(format!(
            "mykey-ocr-{}.swift",
            uuid::Uuid::new_v4()
        ));
        fs::write(&script_path, swift_script).map_err(|e| e.to_string())?;
        let args = vec![
            script_path.to_string_lossy().to_string(),
            image_path.to_string_lossy().to_string(),
        ];
        let output = run_command_with_timeout("swift", &args, Duration::from_secs(20))
            .map_err(|e| format!("Failed to run swift OCR: {}", e))?;
        let _ = fs::remove_file(&script_path);
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                "Apple OCR failed".to_string()
            } else {
                format!("Apple OCR failed: {}", stderr)
            });
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            return Err("Apple OCR returned empty text (try larger area or higher contrast)".to_string());
        }
        Ok(text)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = image_path;
        Err("Apple OCR provider only supports macOS".to_string())
    }
}

async fn ocr_with_ocr_space(
    provider: &ProviderConfig,
    api_key: &str,
    image_path: &Path,
) -> Result<String, String> {
    let mut endpoint = resolve_quick_endpoint(provider);
    if endpoint.trim().is_empty() {
        endpoint = "https://api.ocr.space".to_string();
    }
    let url = if endpoint.contains("/parse/image") {
        endpoint
    } else {
        format!("{}/parse/image", endpoint.trim_end_matches('/'))
    };

    let bytes = fs::read(image_path).map_err(|e| e.to_string())?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name("capture.png")
        .mime_str("image/png")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("isOverlayRequired", "false")
        .text("OCREngine", "2")
        .part("file", part);

    let key = if api_key.trim().is_empty() {
        "helloworld".to_string()
    } else {
        api_key.trim().to_string()
    };
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?
        .post(&url)
        .header("apikey", key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("OCR.Space request failed: {}", e))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!("OCR.Space HTTP {}: {}", status.as_u16(), truncate_text(&body, 180)));
    }
    if parsed
        .get("IsErroredOnProcessing")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        let error_text = parsed
            .get("ErrorMessage")
            .map(|value| {
                if let Some(array) = value.as_array() {
                    array
                        .iter()
                        .filter_map(|item| item.as_str())
                        .collect::<Vec<_>>()
                        .join("; ")
                } else {
                    value.as_str().unwrap_or_default().to_string()
                }
            })
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "OCR.Space processing error".to_string());
        return Err(error_text);
    }
    let text = parsed
        .get("ParsedResults")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("ParsedText"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if text.is_empty() {
        return Err("OCR.Space returned empty text".to_string());
    }
    Ok(text)
}

fn extract_paddleocr_texts(payload: &Value) -> Vec<String> {
    let mut dedup = HashSet::new();
    let mut push_line = |line: String, out: &mut Vec<String>| {
        if !line.is_empty() && dedup.insert(line.clone()) {
            out.push(line);
        }
    };

    if let Some(layout_items) = payload
        .get("result")
        .and_then(|value| value.get("layoutParsingResults"))
        .and_then(|value| value.as_array())
    {
        let mut lines = Vec::new();
        for item in layout_items {
            let markdown_text = item
                .get("markdown")
                .and_then(|value| value.get("text"))
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            let markdown_text = sanitize_ocr_text(&markdown_text);
            if !markdown_text.is_empty() {
                push_line(markdown_text, &mut lines);
            }

            // Some Paddle layout responses put OCR text in prunedResult blocks instead of markdown.text.
            for text in extract_texts_from_json(item) {
                push_line(text, &mut lines);
            }
        }
        if !lines.is_empty() {
            return lines;
        }
    }

    let mut lines = Vec::new();
    let maybe_results = payload
        .get("results")
        .or_else(|| payload.get("result"))
        .or_else(|| payload.get("data"));

    let Some(results) = maybe_results else {
        return lines;
    };

    if let Some(items) = results.as_array() {
        for item in items {
            if let Some(rows) = item.as_array() {
                for row in rows {
                    if let Some(text) = row.get("text").and_then(|value| value.as_str()) {
                        let text = sanitize_ocr_text(text);
                        if !text.is_empty() {
                            push_line(text, &mut lines);
                        }
                    }
                }
            } else if let Some(text) = item.get("text").and_then(|value| value.as_str()) {
                let text = sanitize_ocr_text(text);
                if !text.is_empty() {
                    push_line(text, &mut lines);
                }
            }
            for text in extract_texts_from_json(item) {
                push_line(text, &mut lines);
            }
        }
    }

    if lines.is_empty() {
        for text in extract_texts_from_json(payload) {
            push_line(text, &mut lines);
        }
    }

    lines
}

fn extract_texts_from_json(root: &Value) -> Vec<String> {
    const TEXT_KEYS: &[&str] = &[
        "text",
        "content",
        "ocrText",
        "ocr_text",
        "caption",
        "title",
        "paragraph",
        "sentence",
    ];
    let mut out = Vec::new();
    let mut stack: Vec<&Value> = vec![root];
    while let Some(node) = stack.pop() {
        match node {
            Value::String(text) => {
                let cleaned = sanitize_ocr_text(text);
                if !cleaned.is_empty() {
                    out.push(cleaned);
                }
            }
            Value::Array(items) => {
                for item in items {
                    stack.push(item);
                }
            }
            Value::Object(map) => {
                for (key, value) in map {
                    if TEXT_KEYS.iter().any(|candidate| candidate.eq_ignore_ascii_case(key)) {
                        match value {
                            Value::String(text) => {
                                let cleaned = sanitize_ocr_text(text);
                                if !cleaned.is_empty() {
                                    out.push(cleaned);
                                }
                            }
                            _ => stack.push(value),
                        }
                    } else if matches!(value, Value::Array(_) | Value::Object(_)) {
                        stack.push(value);
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn sanitize_ocr_text(input: &str) -> String {
    let mut text = decode_html_entities(input).replace('\r', "\n");

    let patterns = [
        r"(?is)<img[^>]*>",
        r"(?is)!\[[^\]]*\]\([^)]+\)",
        r"(?is)</?div[^>]*>",
    ];
    for pattern in patterns {
        if let Ok(regex) = Regex::new(pattern) {
            text = regex.replace_all(&text, " ").into_owned();
        }
    }
    if let Ok(html_tag_regex) = Regex::new(r"(?is)<[^>]+>") {
        text = html_tag_regex.replace_all(&text, " ").into_owned();
    }

    let mut lines = Vec::new();
    for raw_line in text.lines() {
        let compact = raw_line.split_whitespace().collect::<Vec<_>>().join(" ");
        if compact.is_empty() {
            continue;
        }
        if is_image_placeholder_line(&compact) {
            continue;
        }
        if is_layout_artifact_line(&compact) {
            continue;
        }
        lines.push(compact);
    }

    lines.join("\n").trim().to_string()
}

fn is_image_placeholder_line(line: &str) -> bool {
    let lower = line.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return true;
    }
    if lower == "image" || lower == "图像" {
        return true;
    }
    lower.contains("img_in_image_box") || lower.starts_with("imgs/")
}

fn is_layout_artifact_line(line: &str) -> bool {
    let token = line.trim().to_ascii_lowercase();
    if token.is_empty() {
        return true;
    }
    if token.contains(' ') {
        return false;
    }
    if !token
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch == '_' || ch == '-')
    {
        return false;
    }

    let exact_labels = [
        "aside_text",
        "header",
        "header_image",
        "footer",
        "footer_image",
        "footnote",
        "number",
    ];
    if exact_labels.iter().any(|label| *label == token) {
        return true;
    }

    token.ends_with("_text") || token.ends_with("_image")
}

fn collect_ocr_fallback_candidates(
    state: &AppState,
    skip_provider: &str,
    preferred_order: &[&str],
) -> Vec<(ProviderConfig, String)> {
    let vault = match state.vault.lock() {
        Ok(vault) => vault,
        Err(_) => return Vec::new(),
    };

    preferred_order
        .iter()
        .filter_map(|provider_id| {
            if *provider_id == skip_provider {
                return None;
            }
            vault.get_provider_config(provider_id).map(|provider| {
                let key = resolve_provider_auth(&vault, &provider);
                (provider, key)
            })
        })
        .collect()
}

async fn try_ocr_fallbacks(
    state: &AppState,
    capture_path: &Path,
    skip_provider: &str,
    preferred_order: &[&str],
) -> (Option<(String, String)>, Vec<String>) {
    let candidates = collect_ocr_fallback_candidates(state, skip_provider, preferred_order);
    let mut fallback_errors = Vec::new();

    for (fallback_provider, fallback_key) in candidates {
        match run_ocr_with_provider(&fallback_provider, &fallback_key, capture_path).await {
            Ok(text) => {
                let cleaned = sanitize_ocr_text(&text);
                if !cleaned.is_empty() {
                    return (
                        Some((fallback_provider.provider.clone(), cleaned)),
                        fallback_errors,
                    );
                }
                fallback_errors.push(format!(
                    "{} fallback returned no usable text",
                    fallback_provider.provider
                ));
            }
            Err(error) => {
                fallback_errors.push(format!(
                    "{} fallback failed: {}",
                    fallback_provider.provider, error
                ));
            }
        }
    }

    (None, fallback_errors)
}

fn collect_translate_fallback_candidates(
    state: &AppState,
    skip_provider: &str,
    preferred_order: &[&str],
) -> Vec<(ProviderConfig, String)> {
    let vault = match state.vault.lock() {
        Ok(vault) => vault,
        Err(_) => return Vec::new(),
    };

    preferred_order
        .iter()
        .filter_map(|provider_id| {
            if *provider_id == skip_provider {
                return None;
            }
            vault.get_provider_config(provider_id).map(|provider| {
                let key = resolve_provider_auth(&vault, &provider);
                (provider, key)
            })
        })
        .collect()
}

async fn try_translate_fallbacks(
    state: &AppState,
    settings: &QuickActionSettings,
    text: &str,
    skip_provider: &str,
    preferred_order: &[&str],
) -> (Option<(String, String)>, Vec<String>) {
    let candidates = collect_translate_fallback_candidates(state, skip_provider, preferred_order);
    let mut fallback_errors = Vec::new();

    for (fallback_provider, fallback_key) in candidates {
        match translate_text_with_provider(&fallback_provider, &fallback_key, settings, text).await {
            Ok(text) => {
                if !text.trim().is_empty() {
                    return (Some((fallback_provider.provider.clone(), text)), fallback_errors);
                }
                fallback_errors.push(format!(
                    "{} fallback returned no usable text",
                    fallback_provider.provider
                ));
            }
            Err(error) => {
                fallback_errors.push(format!(
                    "{} fallback failed: {}",
                    fallback_provider.provider, error
                ));
            }
        }
    }

    (None, fallback_errors)
}

async fn ocr_with_paddleocr(
    provider: &ProviderConfig,
    api_key: &str,
    image_path: &Path,
) -> Result<String, String> {
    let mut endpoint = resolve_quick_endpoint(provider);
    if endpoint.trim().is_empty() || endpoint.contains("127.0.0.1:8868") {
        endpoint = "https://39p4je2aq9v4jezd.aistudio-app.com/layout-parsing".to_string();
    }

    if api_key.trim().is_empty() {
        return Err("PaddleOCR token is required (set provider API Key / PADDLEOCR_TOKEN)".to_string());
    }

    let base = endpoint.trim_end_matches('/').to_string();
    let mut candidates = Vec::new();
    if base.ends_with("/layout-parsing") {
        candidates.push(base.clone());
    } else {
        candidates.push(base.clone());
        candidates.push(format!("{}/layout-parsing", base));
    }

    let image_bytes = fs::read(image_path).map_err(|e| e.to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(image_bytes);
    let file_type = image_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .map(|ext| if ext == "pdf" { 0 } else { 1 })
        .unwrap_or(1);
    let payload_candidates = vec![
        json!({
            "file": encoded,
            "fileType": file_type,
            "useDocOrientationClassify": false,
            "useDocUnwarping": false,
            "useChartRecognition": false
        }),
        json!({
            "file": encoded,
            "fileType": file_type
        }),
    ];

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;

    let mut last_error = String::new();
    for url in candidates {
        for payload in &payload_candidates {
            let response = client
                .post(&url)
                .header("Authorization", format!("token {}", api_key.trim()))
                .header("Content-Type", "application/json")
                .json(payload)
                .send()
                .await;

            let response = match response {
                Ok(value) => value,
                Err(error) => {
                    last_error = format!("PaddleOCR request failed for {}: {}", url, error);
                    continue;
                }
            };

            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if !status.is_success() {
                last_error = format!(
                    "PaddleOCR HTTP {} at {}: {}",
                    status.as_u16(),
                    url,
                    truncate_text(&body, 160)
                );
                continue;
            }

            let parsed = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
            let lines = extract_paddleocr_texts(&parsed);
            if lines.is_empty() {
                last_error = format!(
                    "PaddleOCR returned empty results at {}: {}",
                    url,
                    truncate_text(&body, 160)
                );
                continue;
            }
            return Ok(lines.join("\n"));
        }
    }

    if last_error.is_empty() {
        Err("PaddleOCR returned empty response".to_string())
    } else {
        Err(last_error)
    }
}

#[tauri::command]
pub fn mykey_capabilities() -> Result<Vec<MykeyCapability>, String> {
    Ok(vec![
        MykeyCapability {
            id: "health.ping".to_string(),
            description: "Quick ping endpoint for agent health".to_string(),
            requires_master_password: false,
            mutating: false,
            params: vec![],
        },
        MykeyCapability {
            id: "capabilities.list".to_string(),
            description: "List all available mykey agent commands".to_string(),
            requires_master_password: false,
            mutating: false,
            params: vec![],
        },
        MykeyCapability {
            id: "python.run".to_string(),
            description: "Run a local Python snippet and return stdout/stderr".to_string(),
            requires_master_password: true,
            mutating: true,
            params: vec![
                "code:string".to_string(),
                "timeout_ms:number|null".to_string(),
                "max_output_chars:number|null".to_string(),
                "python_args:string[]|null".to_string(),
            ],
        },
        MykeyCapability {
            id: "gateway.status".to_string(),
            description: "Read gateway service status, policy and 60m traffic metrics".to_string(),
            requires_master_password: true,
            mutating: false,
            params: vec![],
        },
        MykeyCapability {
            id: "gateway.circuit_breaker.set".to_string(),
            description: "Enable or disable gateway global circuit breaker".to_string(),
            requires_master_password: true,
            mutating: true,
            params: vec!["enabled:boolean".to_string()],
        },
        MykeyCapability {
            id: "gateway.daily_budget.set".to_string(),
            description: "Set gateway daily budget; null clears it".to_string(),
            requires_master_password: true,
            mutating: true,
            params: vec!["daily_budget_usd:number|null".to_string()],
        },
        MykeyCapability {
            id: "routes.list".to_string(),
            description: "List all app -> provider routes".to_string(),
            requires_master_password: true,
            mutating: false,
            params: vec![],
        },
        MykeyCapability {
            id: "gateway.models.list".to_string(),
            description: "List resolved gateway app/provider/model catalog".to_string(),
            requires_master_password: true,
            mutating: false,
            params: vec![],
        },
        MykeyCapability {
            id: "gateway.traffic.metrics".to_string(),
            description: "Read gateway traffic metrics including model-level ranking".to_string(),
            requires_master_password: true,
            mutating: false,
            params: vec!["window_minutes:number".to_string()],
        },
        MykeyCapability {
            id: "gateway.open_responses.get".to_string(),
            description: "读取 Codex 对话是否启用 Open Responses 协议".to_string(),
            requires_master_password: true,
            mutating: false,
            params: vec![],
        },
        MykeyCapability {
            id: "gateway.open_responses.set".to_string(),
            description: "设置 Codex 对话是否启用 Open Responses 协议".to_string(),
            requires_master_password: true,
            mutating: true,
            params: vec!["enabled:boolean".to_string()],
        },
        MykeyCapability {
            id: "routes.set".to_string(),
            description: "Set route mapping for one app".to_string(),
            requires_master_password: true,
            mutating: true,
            params: vec![
                "app_type:string".to_string(),
                "provider:string".to_string(),
                "model?:string".to_string(),
            ],
        },
        MykeyCapability {
            id: "providers.list".to_string(),
            description: "List provider configs".to_string(),
            requires_master_password: true,
            mutating: false,
            params: vec![],
        },
        MykeyCapability {
            id: "projects.list".to_string(),
            description: "List managed projects".to_string(),
            requires_master_password: true,
            mutating: false,
            params: vec![],
        },
        MykeyCapability {
            id: "projects.add".to_string(),
            description: "Add managed project".to_string(),
            requires_master_password: true,
            mutating: true,
            params: vec![
                "name:string".to_string(),
                "path:string".to_string(),
                "credential_id?:string".to_string(),
            ],
        },
        MykeyCapability {
            id: "projects.delete".to_string(),
            description: "Delete managed project by id".to_string(),
            requires_master_password: true,
            mutating: true,
            params: vec!["id:string".to_string()],
        },
        MykeyCapability {
            id: "projects.clear".to_string(),
            description: "Clear all project data for reset/testing".to_string(),
            requires_master_password: true,
            mutating: true,
            params: vec![],
        },
    ])
}

#[tauri::command]
pub fn mykey_command(
    command: String,
    args: Option<Value>,
    master_password: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let cmd = command.trim().to_lowercase();
    if cmd.is_empty() {
        return Err("command is empty".to_string());
    }
    if cmd == "health.ping" {
        return Ok(json!({
            "ok": true,
            "service": "mykey-agent",
            "command": "health.ping",
        }));
    }
    if cmd == "capabilities.list" {
        return Ok(json!({ "capabilities": mykey_capabilities()? }));
    }

    let args = as_object_args(args)?;
    let password = master_password
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "master_password is required".to_string())?;
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&password) {
        return Err("Invalid master password".to_string());
    }

    match cmd.as_str() {
        "gateway.status" => {
            let settings = vault.get_global_settings()?;
            let policy = vault.get_gateway_policy_settings()?;
            let traffic = vault.get_gateway_traffic_metrics(60)?;
            let service = settings
                .services
                .iter()
                .find(|item| item.service_name == "gateway")
                .cloned();
            Ok(json!({
                "gateway_service": service,
                "policy": policy,
                "traffic_60m": traffic,
            }))
        }
        "python.run" => {
            let code = required_string_arg(&args, "code")?;
            let timeout_ms = optional_i64_arg(&args, "timeout_ms")?;
            let max_output_chars = optional_usize_arg(&args, "max_output_chars")?;
            let python_args = optional_string_vec_arg(&args, "python_args")?;
            run_python_code_internal(&code, timeout_ms, max_output_chars, python_args)
        }
        "gateway.circuit_breaker.set" => {
            let enabled = args
                .get("enabled")
                .and_then(|v| v.as_bool())
                .ok_or_else(|| "Missing required boolean arg: enabled".to_string())?;
            vault.set_gateway_circuit_breaker(enabled)?;
            Ok(json!({ "ok": true, "enabled": enabled }))
        }
        "gateway.daily_budget.set" => {
            let budget = match args.get("daily_budget_usd") {
                Some(Value::Null) | None => None,
                Some(value) => value.as_f64(),
            };
            if args.contains_key("daily_budget_usd")
                && !matches!(args.get("daily_budget_usd"), Some(Value::Null))
                && budget.is_none()
            {
                return Err("daily_budget_usd must be number or null".to_string());
            }
            vault.set_gateway_daily_budget(budget)?;
            Ok(json!({ "ok": true, "daily_budget_usd": budget }))
        }
        "gateway.open_responses.get" => {
            let enabled = vault.gateway_open_responses_enabled()?;
            Ok(json!({ "open_responses": enabled }))
        }
        "gateway.open_responses.set" => {
            let enabled = args
                .get("enabled")
                .and_then(|v| v.as_bool())
                .ok_or_else(|| "Missing required boolean arg: enabled".to_string())?;
            vault.set_gateway_open_responses(enabled)?;
            Ok(json!({ "ok": true, "open_responses": enabled }))
        }
        "routes.list" => {
            let routes = vault.get_app_routes()?;
            Ok(json!({ "routes": routes }))
        }
        "routes.set" => {
            let app_type = required_string_arg(&args, "app_type")?;
            let provider = required_string_arg(&args, "provider")?;
            let model = optional_string_arg(&args, "model");
            let route = vault.set_app_route(&app_type, &provider, model)?;
            Ok(json!({ "route": route }))
        }
        "providers.list" => {
            let providers = vault.get_providers();
            Ok(json!({ "providers": providers }))
        }
        "projects.list" => {
            let projects = vault.get_projects()?;
            Ok(json!({ "projects": projects }))
        }
        "projects.add" => {
            let name = required_string_arg(&args, "name")?;
            let path = required_string_arg(&args, "path")?;
            let credential_id = optional_string_arg(&args, "credential_id");
            let project = vault.add_project(name, path, credential_id)?;
            Ok(json!({ "project": project }))
        }
        "projects.delete" => {
            let id = required_string_arg(&args, "id")?;
            vault.delete_project(&id)?;
            Ok(json!({ "ok": true, "id": id }))
        }
        "projects.clear" => {
            vault.clear_project_data()?;
            Ok(json!({ "ok": true }))
        }
        _ => Err(format!("Unknown mykey command: {}", command)),
    }
}

#[tauri::command]
pub fn parse_env_file(
    content: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Vec<ParsedKey>, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;

    // Verify password
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    Ok(parse_env_content(&content, None))
}

#[tauri::command]
pub fn scan_env_dir(
    root_path: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Vec<ParsedKey>, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;

    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    let normalized_root = normalize_root_path(&root_path);
    let root = Path::new(&normalized_root);
    if !root.exists() {
        return Err(format!("Directory not found: {}", normalized_root));
    }
    if !root.is_dir() {
        return Err(format!("Path is not a directory: {}", normalized_root));
    }

    let scan = scan_env_sources(&normalized_root, None);
    Ok(scan.parsed_keys)
}

#[tauri::command]
pub fn scan_shipkey_dir(
    root_path: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<ShipkeyScanReport, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    let normalized_root = normalize_root_path(&root_path);
    let root = Path::new(&normalized_root);
    if !root.exists() {
        return Err(format!("Directory not found: {}", normalized_root));
    }
    if !root.is_dir() {
        return Err(format!("Path is not a directory: {}", normalized_root));
    }

    build_shipkey_scan_report(&normalized_root)
}

#[tauri::command]
pub fn generate_mykey_sync_config(
    root_path: String,
    output_path: Option<String>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<MykeySyncGenerateResult, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    let normalized_root = normalize_root_path(&root_path);
    let root = Path::new(&normalized_root);
    if !root.exists() {
        return Err(format!("Directory not found: {}", normalized_root));
    }
    if !root.is_dir() {
        return Err(format!("Path is not a directory: {}", normalized_root));
    }

    let report = build_shipkey_scan_report(&normalized_root)?;
    let project_name = detect_project_name(root).unwrap_or_else(|| {
        root.file_name()
            .and_then(|v| v.to_str())
            .filter(|v| !v.trim().is_empty())
            .unwrap_or("project")
            .to_string()
    });

    let workflow_secret_set: HashSet<String> = report.workflow_secrets.iter().cloned().collect();
    let mut secret_rows = Vec::new();
    let mut providers = HashSet::new();
    for item in &report.parsed_keys {
        let Some(env_key) = item.variable.as_deref() else {
            continue;
        };
        providers.insert(item.provider.clone());
        secret_rows.push(serde_json::json!({
            "key": env_key,
            "provider": item.provider,
            "source": item.source,
            "in_workflow": workflow_secret_set.contains(env_key),
        }));
    }

    let git_repo = detect_git_repo_slug(root);
    let github_targets = if !report.workflow_secrets.is_empty() {
        if let Some(repo) = git_repo {
            serde_json::json!({ repo: report.workflow_secrets.clone() })
        } else {
            serde_json::json!({})
        }
    } else {
        serde_json::json!({})
    };

    let mut dev_vars_keys: HashSet<String> = HashSet::new();
    for item in &report.parsed_keys {
        if item
            .source
            .as_deref()
            .is_some_and(|source| source.contains(".dev.vars"))
        {
            if let Some(key) = item.variable.as_ref() {
                dev_vars_keys.insert(key.clone());
            }
        }
    }
    let mut dev_var_list = dev_vars_keys.into_iter().collect::<Vec<String>>();
    dev_var_list.sort();

    let cloudflare_targets = if !report.wrangler_projects.is_empty() && !dev_var_list.is_empty() {
        let mut map = serde_json::Map::new();
        for project in &report.wrangler_projects {
            map.insert(project.clone(), serde_json::json!(dev_var_list));
        }
        Value::Object(map)
    } else {
        serde_json::json!({})
    };

    let mut providers_list = providers.into_iter().collect::<Vec<String>>();
    providers_list.sort();

    let content = serde_json::json!({
        "schema": "mykey.sync/v1",
        "project": {
            "name": project_name,
            "root": normalized_root,
        },
        "generated_at": chrono::Local::now().to_rfc3339(),
        "scan": {
            "env_files": report.env_files,
            "env_vars": report.env_vars,
            "workflow_files": report.workflow_files,
            "workflow_secrets": report.workflow_secrets,
            "missing_workflow_secrets": report.missing_workflow_secrets,
            "wrangler_file": report.wrangler_file,
            "wrangler_projects": report.wrangler_projects,
            "wrangler_bindings": report.wrangler_bindings,
            "used_shipkey_config": report.used_shipkey_config,
        },
        "providers": providers_list,
        "secrets": secret_rows,
        "targets": {
            "github": github_targets,
            "cloudflare": cloudflare_targets,
        },
    });

    let destination = match output_path {
        Some(path) if !path.trim().is_empty() => {
            let normalized = normalize_root_path(&path);
            let path = PathBuf::from(normalized);
            if path.is_absolute() {
                path
            } else {
                root.join(path)
            }
        }
        _ => root.join("mykey.sync.json"),
    };

    let pretty = serde_json::to_string_pretty(&content).map_err(|e| e.to_string())?;
    std::fs::write(&destination, format!("{pretty}\n")).map_err(|e| e.to_string())?;

    let github_target_count = content
        .get("targets")
        .and_then(|v| v.get("github"))
        .and_then(|v| v.as_object())
        .map(|v| v.len())
        .unwrap_or(0);
    let cloudflare_target_count = content
        .get("targets")
        .and_then(|v| v.get("cloudflare"))
        .and_then(|v| v.as_object())
        .map(|v| v.len())
        .unwrap_or(0);

    Ok(MykeySyncGenerateResult {
        output_path: destination.to_string_lossy().to_string(),
        project_name,
        secret_count: report.parsed_keys.len(),
        github_target_count,
        cloudflare_target_count,
        report,
    })
}

#[tauri::command]
pub fn backup_scanned_projects_to_onepassword(
    vault_name: Option<String>,
    env: Option<String>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<OnePasswordSyncSummary, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    let projects = vault.get_projects()?;
    drop(vault);

    let vault_name = vault_name
        .unwrap_or_else(|| "mykey".to_string())
        .trim()
        .to_string();
    let env = env.unwrap_or_else(|| "dev".to_string()).trim().to_string();
    if vault_name.is_empty() {
        return Err("Vault name cannot be empty".to_string());
    }
    if env.is_empty() {
        return Err("Environment cannot be empty".to_string());
    }

    ensure_onepassword_ready()?;
    ensure_onepassword_vault(&vault_name)?;

    let mut summary = OnePasswordSyncSummary {
        vault: vault_name.clone(),
        env: env.clone(),
        total_projects: projects.len(),
        processed_projects: 0,
        skipped_projects: 0,
        total_keys: 0,
        success_keys: 0,
        failed_keys: 0,
        results: Vec::new(),
    };

    for project in projects {
        let path = PathBuf::from(normalize_root_path(&project.path));
        if !path.exists() || !path.is_dir() {
            summary.skipped_projects += 1;
            summary.results.push(OnePasswordProjectSyncResult {
                project_id: project.id,
                project_name: project.name,
                project_path: project.path,
                detected_keys: 0,
                success_keys: 0,
                failed_keys: 0,
                restored_file: None,
                message: Some("Project path not found, skipped".to_string()),
            });
            continue;
        }

        let project_name = detect_project_name(&path).unwrap_or_else(|| project.name.clone());
        let entries = scan_project_secret_entries(&path);

        let mut success = 0usize;
        let mut failed = 0usize;
        for entry in &entries {
            let result = onepassword_write_secret(
                &vault_name,
                &entry.provider,
                &project_name,
                &env,
                &entry.key,
                &entry.value,
            );
            if result.is_ok() {
                success += 1;
            } else {
                failed += 1;
            }
        }

        summary.processed_projects += 1;
        summary.total_keys += entries.len();
        summary.success_keys += success;
        summary.failed_keys += failed;
        summary.results.push(OnePasswordProjectSyncResult {
            project_id: project.id,
            project_name,
            project_path: path.to_string_lossy().to_string(),
            detected_keys: entries.len(),
            success_keys: success,
            failed_keys: failed,
            restored_file: None,
            message: if failed > 0 {
                Some("Some keys failed to write to 1Password".to_string())
            } else {
                None
            },
        });
    }

    Ok(summary)
}

#[tauri::command]
pub fn restore_scanned_projects_from_onepassword(
    vault_name: Option<String>,
    env: Option<String>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<OnePasswordSyncSummary, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    let projects = vault.get_projects()?;
    drop(vault);

    let vault_name = vault_name
        .unwrap_or_else(|| "mykey".to_string())
        .trim()
        .to_string();
    let env = env.unwrap_or_else(|| "dev".to_string()).trim().to_string();
    if vault_name.is_empty() {
        return Err("Vault name cannot be empty".to_string());
    }
    if env.is_empty() {
        return Err("Environment cannot be empty".to_string());
    }

    ensure_onepassword_ready()?;
    let entries_by_project = onepassword_collect_project_entries(&vault_name, &env)?;

    let mut summary = OnePasswordSyncSummary {
        vault: vault_name,
        env: env.clone(),
        total_projects: projects.len(),
        processed_projects: 0,
        skipped_projects: 0,
        total_keys: 0,
        success_keys: 0,
        failed_keys: 0,
        results: Vec::new(),
    };

    for project in projects {
        let path = PathBuf::from(normalize_root_path(&project.path));
        if !path.exists() || !path.is_dir() {
            summary.skipped_projects += 1;
            summary.results.push(OnePasswordProjectSyncResult {
                project_id: project.id,
                project_name: project.name,
                project_path: project.path,
                detected_keys: 0,
                success_keys: 0,
                failed_keys: 0,
                restored_file: None,
                message: Some("Project path not found, skipped".to_string()),
            });
            continue;
        }

        let project_name = detect_project_name(&path).unwrap_or_else(|| project.name.clone());
        let entries = entries_by_project
            .get(&project_name)
            .cloned()
            .unwrap_or_default();

        let restore_path = if entries.is_empty() {
            None
        } else {
            Some(write_project_env_file(&path, &entries)?)
        };

        summary.processed_projects += 1;
        summary.total_keys += entries.len();
        summary.success_keys += entries.len();
        summary.results.push(OnePasswordProjectSyncResult {
            project_id: project.id,
            project_name,
            project_path: path.to_string_lossy().to_string(),
            detected_keys: entries.len(),
            success_keys: entries.len(),
            failed_keys: 0,
            restored_file: restore_path,
            message: if entries.is_empty() {
                Some(format!("No entries found in vault for env {}", env))
            } else {
                None
            },
        });
    }

    Ok(summary)
}

fn is_env_file(file_name: &str) -> bool {
    file_name == ".env"
        || (file_name.starts_with(".env.") && file_name.len() > 5)
        || file_name == ".envrc"
        || file_name == ".dev.vars"
        || (file_name.starts_with(".dev.vars.") && file_name.len() > 10)
}

fn is_template_file(file_name: &str) -> bool {
    file_name.contains(".example") || file_name.contains(".template")
}

#[tauri::command]
pub fn get_providers(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Vec<ProviderConfig>, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;

    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    Ok(vault.get_providers())
}

#[tauri::command]
pub fn upsert_provider(
    provider: String,
    label: String,
    api_key: String,
    base_url: String,
    models: Vec<String>,
    details: Option<ProviderDetails>,
    endpoints: Option<Vec<ProviderEndpointInput>>,
    env_vars: Option<Vec<ProviderEnvVarInput>>,
    app_bindings: Option<Vec<ProviderAppBindingInput>>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<ProviderConfig, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;

    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    vault.upsert_provider(
        provider,
        label,
        api_key,
        base_url,
        models,
        details,
        endpoints,
        env_vars,
        app_bindings,
    )
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GatewayModelCatalogItem {
    pub app_type: String,
    pub provider: String,
    pub model: String,
}

#[tauri::command]
pub fn list_gateway_model_catalog(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Vec<GatewayModelCatalogItem>, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    let routes = vault.get_app_routes()?;
    let mut seen = HashSet::new();
    let mut catalog = Vec::new();

    for route in routes {
        let Some(provider) = vault.get_provider_config(&route.provider) else {
            continue;
        };

        let mut models = Vec::new();
        if let Some(model) = route.model.as_deref() {
            models.push(model.trim().to_string());
        }
        models.extend(provider.models.iter().map(|model| model.trim().to_string()));
        models.push(provider.details.main_model.clone());
        models.push(provider.details.reasoning_model.clone());
        models.push(provider.details.default_haiku_model.clone());
        models.push(provider.details.default_sonnet_model.clone());
        models.push(provider.details.default_opus_model.clone());

        for model in models {
            let model = model.trim().to_string();
            if model.is_empty() {
                continue;
            }
            let key = format!("{}:{}:{}", route.app_type, route.provider, model);
            if !seen.insert(key) {
                continue;
            }
            catalog.push(GatewayModelCatalogItem {
                app_type: route.app_type.clone(),
                provider: route.provider.clone(),
                model,
            });
        }
    }

    catalog.sort_by(|a, b| {
        a.app_type
            .cmp(&b.app_type)
            .then(a.provider.cmp(&b.provider))
            .then(a.model.cmp(&b.model))
    });

    Ok(catalog)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EndpointSpeedTestResult {
    pub requested_url: String,
    pub tested_url: Option<String>,
    pub success: bool,
    pub status_code: Option<u16>,
    pub latency_ms: Option<i64>,
    pub error: Option<String>,
}

fn parse_headers(raw: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    let Some(input) = raw else {
        return headers;
    };

    for part in input
        .split('\n')
        .flat_map(|line| line.split(','))
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Some((key, value)) = part.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        let Ok(name) = HeaderName::from_str(key) else {
            continue;
        };
        let Ok(val) = HeaderValue::from_str(value) else {
            continue;
        };
        headers.insert(name, val);
    }

    headers
}

fn command_exists(command: &str) -> bool {
    Command::new("which")
        .arg(command)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn build_local_provider_probe(
    requested_url: &str,
    tested_url: &str,
    checks: &[(&str, bool)],
) -> EndpointSpeedTestResult {
    let missing: Vec<&str> = checks
        .iter()
        .filter_map(|(name, ok)| if *ok { None } else { Some(*name) })
        .collect();

    if missing.is_empty() {
        EndpointSpeedTestResult {
            requested_url: requested_url.to_string(),
            tested_url: Some(tested_url.to_string()),
            success: true,
            status_code: Some(200),
            latency_ms: Some(0),
            error: None,
        }
    } else {
        EndpointSpeedTestResult {
            requested_url: requested_url.to_string(),
            tested_url: Some(tested_url.to_string()),
            success: false,
            status_code: None,
            latency_ms: None,
            error: Some(format!("Missing local command(s): {}", missing.join(", "))),
        }
    }
}

fn test_apple_local_provider(base: &str, requested_url: &str) -> Option<EndpointSpeedTestResult> {
    if !base.starts_with("apple://") {
        return None;
    }

    if !cfg!(target_os = "macos") {
        return Some(EndpointSpeedTestResult {
            requested_url: requested_url.to_string(),
            tested_url: Some(base.to_string()),
            success: false,
            status_code: None,
            latency_ms: None,
            error: Some("Apple local provider only supports macOS".to_string()),
        });
    }

    if base.starts_with("apple://translate") {
        return Some(build_local_provider_probe(
            requested_url,
            "apple://translate",
            &[
                ("shortcuts", command_exists("shortcuts")),
                ("osascript", command_exists("osascript")),
            ],
        ));
    }

    if base.starts_with("apple://ocr") {
        return Some(build_local_provider_probe(
            requested_url,
            "apple://ocr",
            &[
                ("screencapture", command_exists("screencapture")),
                ("swift", command_exists("swift")),
            ],
        ));
    }

    Some(EndpointSpeedTestResult {
        requested_url: requested_url.to_string(),
        tested_url: Some(base.to_string()),
        success: false,
        status_code: None,
        latency_ms: None,
        error: Some("Unknown apple local provider endpoint".to_string()),
    })
}

fn truncate_text(input: &str, max_chars: usize) -> String {
    let trimmed = input.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut result = String::new();
    for (idx, ch) in trimmed.chars().enumerate() {
        if idx >= max_chars {
            break;
        }
        result.push(ch);
    }
    format!("{}...", result)
}

fn extract_error_message(value: &Value) -> Option<String> {
    value
        .get("error")
        .and_then(|item| {
            item.get("message")
                .or_else(|| item.get("error"))
                .or_else(|| item.get("code"))
        })
        .and_then(|item| item.as_str())
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .or_else(|| {
            value
                .get("message")
                .or_else(|| value.get("error"))
                .and_then(|item| item.as_str())
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
        })
}

fn extract_codex_text(value: &Value) -> Option<String> {
    if let Some(text) = value.get("output_text").and_then(|item| item.as_str()) {
        let text = text.trim();
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }

    if let Some(text) = value
        .get("response")
        .and_then(|item| item.get("output_text"))
        .and_then(|item| item.as_str())
    {
        let text = text.trim();
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }

    if let Some(output_items) = value.get("output").and_then(|item| item.as_array()) {
        let mut chunks: Vec<String> = Vec::new();
        for output_item in output_items {
            if let Some(contents) = output_item.get("content").and_then(|item| item.as_array()) {
                for content in contents {
                    if let Some(text) = content.get("text").and_then(|item| item.as_str()) {
                        let text = text.trim();
                        if !text.is_empty() {
                            chunks.push(text.to_string());
                        }
                    }
                    if let Some(summary_items) = content.get("summary").and_then(|item| item.as_array()) {
                        for summary in summary_items {
                            if let Some(text) = summary.get("text").and_then(|item| item.as_str()) {
                                let text = text.trim();
                                if !text.is_empty() {
                                    chunks.push(text.to_string());
                                }
                            }
                        }
                    }
                    if let Some(summary) = content.get("summary").and_then(|item| item.as_str()) {
                        let summary = summary.trim();
                        if !summary.is_empty() {
                            chunks.push(summary.to_string());
                        }
                    }
                }
            }
            if let Some(summary_items) = output_item.get("summary").and_then(|item| item.as_array()) {
                for summary in summary_items {
                    if let Some(text) = summary.get("text").and_then(|item| item.as_str()) {
                        let text = text.trim();
                        if !text.is_empty() {
                            chunks.push(text.to_string());
                        }
                    }
                }
            }
            if let Some(summary) = output_item.get("summary").and_then(|item| item.as_str()) {
                let summary = summary.trim();
                if !summary.is_empty() {
                    chunks.push(summary.to_string());
                }
            }
            if let Some(reasoning) = output_item.get("reasoning").and_then(|item| item.as_str()) {
                let reasoning = reasoning.trim();
                if !reasoning.is_empty() {
                    chunks.push(reasoning.to_string());
                }
            }
        }
        if !chunks.is_empty() {
            return Some(chunks.join("\n"));
        }
    }

    if let Some(choices) = value.get("choices").and_then(|item| item.as_array()) {
        if let Some(first) = choices.first() {
            if let Some(text) = first
                .get("message")
                .and_then(|item| item.get("content"))
                .and_then(|item| item.as_str())
            {
                let text = text.trim();
                if !text.is_empty() {
                    return Some(text.to_string());
                }
            }
        }
    }

    None
}

fn extract_codex_stream_text(value: &Value) -> Option<String> {
    if let Some(text) = value.get("output_text").and_then(|item| item.as_str()) {
        let text = text.trim();
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }

    if let Some(type_name) = value.get("type").and_then(|item| item.as_str()) {
        let contains_delta = type_name.contains("delta");
        let output_text = if contains_delta {
            value
                .get("delta")
                .or_else(|| value.get("output_delta"))
                .and_then(|item| item.get("text"))
                .and_then(|item| item.as_str())
        } else {
            None
        };
        if let Some(text) = output_text {
            let text = text.trim();
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }

    if let Some(delta) = value.get("delta").and_then(|item| item.get("content")).and_then(|item| item.as_array()) {
        let mut lines: Vec<String> = Vec::new();
        for item in delta {
            if let Some(text) = item
                .get("text")
                .and_then(|value| value.as_str())
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
            {
                lines.push(text.to_string());
            }
        }
        if !lines.is_empty() {
            return Some(lines.join(""));
        }
    }

    if let Some(summary_items) = value.get("summary").and_then(|item| item.as_array()) {
        let mut lines: Vec<String> = Vec::new();
        for item in summary_items {
            if let Some(text) = item
                .get("text")
                .and_then(|value| value.as_str())
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
            {
                lines.push(text.to_string());
            }
        }
        if !lines.is_empty() {
            return Some(lines.join(""));
        }
    }

    if let Some(summary) = value.get("summary").and_then(|item| item.as_str()) {
        let summary = summary.trim();
        if !summary.is_empty() {
            return Some(summary.to_string());
        }
    }

    if let Some(reasoning) = value
        .get("reasoning")
        .and_then(|item| item.as_str())
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
    {
        return Some(reasoning.to_string());
    }

    None
}

fn parse_streamed_responses(raw: &str) -> String {
    let mut chunks: Vec<String> = Vec::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("data:") {
            continue;
        }
        let data = trimmed.trim_start_matches("data:").trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let parsed = match serde_json::from_str::<Value>(data) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if let Some(chunk) = extract_codex_stream_text(&parsed) {
            chunks.push(chunk);
        }
    }

    if chunks.is_empty() {
        String::new()
    } else {
        chunks.join("")
    }
}

#[tauri::command]
pub async fn clippy_codex_chat(
    question: String,
    system_prompt: Option<String>,
    model: Option<String>,
    open_responses: Option<bool>,
    stream: Option<bool>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let user_question = question.trim();
    if user_question.is_empty() {
        return Err("Question is empty".to_string());
    }

    let (gateway_enabled, gateway_base_url, gateway_api_key) = {
        let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
        if !vault.authenticate(&master_password) {
            return Err("Invalid master password".to_string());
        }
        let settings = vault.get_global_settings()?;
        let enabled = settings
            .services
            .iter()
            .find(|item| item.service_name == "gateway")
            .map(|item| item.enabled)
            .unwrap_or(true);
        let creds = vault.get_gateway_access_credentials("codex")?;
        let open_responses = vault.gateway_open_responses_enabled()?;
        (enabled, creds.base_url, creds.api_key, open_responses)
    };

    if !gateway_enabled {
        return Err("Gateway 服务未启用，请在全局设置中启用".to_string());
    }

    crate::gateway::sync_gateway_runtime(state.inner())?;

    let use_open_responses = open_responses.unwrap_or(gateway_open_responses);
    let gateway_endpoint = if use_open_responses {
        format!("{}/responses/compact", gateway_base_url.trim_end_matches('/'))
    } else {
        format!("{}/responses", gateway_base_url.trim_end_matches('/'))
    };
    let model_name = model
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .unwrap_or_else(|| "gpt-5-codex".to_string());
    let stream_mode = stream.unwrap_or(false);
    let effective_stream = if use_open_responses { false } else { stream_mode };
    let system = system_prompt
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .unwrap_or_else(|| "你是 MyKey 内置 Clippy 助手，请用中文简洁回答。".to_string());

    let payload = json!({
        "model": model_name,
        "stream": effective_stream,
        "instructions": system,
        "input": [
            {
                "role": "user",
                "content": [
                    { "type": "input_text", "text": user_question }
                ]
            }
        ]
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(&gateway_endpoint)
        .bearer_auth(gateway_api_key)
        .header("content-type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("无法连接 Gateway：{}", e))?;

    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(&raw).ok();

    if !status.is_success() {
        let detail = parsed
            .as_ref()
            .and_then(extract_error_message)
            .unwrap_or_else(|| truncate_text(&raw, 220));
        return Err(format!(
            "Codex 代理请求失败（HTTP {}）：{}",
            status.as_u16(),
            detail
        ));
    }

    if effective_stream {
        let stream_text = parse_streamed_responses(&raw);
        if !stream_text.is_empty() {
            return Ok(stream_text);
        }
    }

    if let Some(parsed_value) = parsed.as_ref() {
        if let Some(text) = extract_codex_text(parsed_value) {
            return Ok(text);
        }
    }

    let fallback = truncate_text(&raw, 400);
    if fallback.is_empty() {
        return Err("Codex 返回为空".to_string());
    }

    Ok(fallback)
}

#[tauri::command]
pub async fn quick_clippy_assist(
    translated_text: String,
    source_text: Option<String>,
    action_type: Option<String>,
    system_prompt: Option<String>,
    model: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let translated_text = translated_text.trim().to_string();
    if translated_text.is_empty() {
        return Err("No text to analyze".to_string());
    }

    let source = source_text
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    let action = action_type
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "ocr_translate".to_string());

    let request_prompt = if source.is_empty() {
        format!(
            "以下是快速翻译结果：\n{}\n\n请给出 1-3 条可直接执行的中文优化建议，重点关注语法准确性、词汇自然度与可读性。每条建议尽量简洁，最长不超过 20 个字。",
            translated_text
        )
    } else {
        format!(
            "动作类型：{}\n原文：{}\n译文：{}\n\n请给出 1-3 条可直接执行的中文优化建议，重点检查：\n1) 是否准确保留原意；2) 是否流畅自然；3) 是否更符合中文表达习惯。\n请只给建议，不要输出额外解释。",
            action,
            source,
            translated_text
        )
    };

    let (gateway_enabled, gateway_base_url, gateway_api_key, gateway_open_responses) = {
        let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
        let settings = vault.get_global_settings()?;
        let enabled = settings
            .services
            .iter()
            .find(|item| item.service_name == "gateway")
            .map(|item| item.enabled)
            .unwrap_or(true);
        let creds = vault.get_gateway_access_credentials("codex")?;
        let gateway_open_responses = vault.gateway_open_responses_enabled()?;
        (enabled, creds.base_url, creds.api_key, gateway_open_responses)
    };

    if !gateway_enabled {
        return Err("Gateway 服务未启用，请在全局设置中启用".to_string());
    }

    crate::gateway::sync_gateway_runtime(state.inner())?;

    let gateway_endpoint = if gateway_open_responses {
        format!("{}/responses/compact", gateway_base_url.trim_end_matches('/'))
    } else {
        format!("{}/responses", gateway_base_url.trim_end_matches('/'))
    };
    let model_name = model
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .unwrap_or_else(|| "gpt-5-codex".to_string());
    let system = system_prompt
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .unwrap_or_else(|| {
            "你是译文优化助手，只输出中文建议，保持简洁且可执行。".to_string()
        });

    let payload = json!({
        "model": model_name,
        "stream": false,
        "instructions": system,
        "input": [
            {
                "role": "user",
                "content": [
                    { "type": "input_text", "text": request_prompt }
                ]
            }
        ]
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(&gateway_endpoint)
        .bearer_auth(gateway_api_key)
        .header("content-type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("无法连接 Gateway：{}", e))?;

    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(&raw).ok();

    if !status.is_success() {
        let detail = parsed
            .as_ref()
            .and_then(extract_error_message)
            .unwrap_or_else(|| truncate_text(&raw, 220));
        return Err(format!(
            "Codex 代理请求失败（HTTP {}）：{}",
            status.as_u16(),
            detail
        ));
    }

    if let Some(parsed_value) = parsed.as_ref() {
        if let Some(text) = extract_codex_text(parsed_value) {
            return Ok(text);
        }
    }

    let fallback = truncate_text(&raw, 400);
    if fallback.is_empty() {
        return Err("Codex 返回为空".to_string());
    }

    Ok(fallback)
}

#[tauri::command]
pub async fn test_provider_endpoint(
    url: String,
    api_key: Option<String>,
    headers: Option<String>,
    timeout_ms: Option<i64>,
) -> Result<EndpointSpeedTestResult, String> {
    let base = url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Ok(EndpointSpeedTestResult {
            requested_url: url,
            tested_url: None,
            success: false,
            status_code: None,
            latency_ms: None,
            error: Some("Endpoint is empty".to_string()),
        });
    }

    if let Some(local_probe) = test_apple_local_provider(&base, &url) {
        return Ok(local_probe);
    }

    let timeout = timeout_ms.unwrap_or(8000).clamp(1000, 60_000) as u64;
    let mut request_headers = parse_headers(headers.as_deref());

    if let Some(key) = api_key
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
    {
        if !request_headers.contains_key(AUTHORIZATION) {
            let bearer = format!("Bearer {}", key);
            if let Ok(value) = HeaderValue::from_str(&bearer) {
                request_headers.insert(AUTHORIZATION, value);
            }
        }
        if !request_headers.contains_key("x-api-key") {
            if let Ok(value) = HeaderValue::from_str(&key) {
                request_headers.insert("x-api-key", value);
            }
        }
    }

    let mut candidates: Vec<(String, bool)> = vec![(format!("{}/models", base), false)];
    if !base.ends_with("/v1") {
        candidates.push((format!("{}/v1/models", base), false));
    }
    // Fallback probe for non-model providers (translation/search/ocr), which may not expose /models.
    candidates.push((base.clone(), true));

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout))
        .build()
        .map_err(|e| e.to_string())?;

    let mut last_error: Option<String> = None;

    for (target, allow_client_error) in candidates {
        let start = std::time::Instant::now();
        let response = client
            .get(&target)
            .headers(request_headers.clone())
            .send()
            .await;

        match response {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let latency = start.elapsed().as_millis() as i64;
                if resp.status().is_success() {
                    return Ok(EndpointSpeedTestResult {
                        requested_url: url,
                        tested_url: Some(target),
                        success: true,
                        status_code: Some(status),
                        latency_ms: Some(latency),
                        error: None,
                    });
                }
                if allow_client_error && resp.status().is_client_error() {
                    return Ok(EndpointSpeedTestResult {
                        requested_url: url,
                        tested_url: Some(target),
                        success: true,
                        status_code: Some(status),
                        latency_ms: Some(latency),
                        error: None,
                    });
                }
                last_error = Some(format!("HTTP {}", status));
            }
            Err(err) => {
                last_error = Some(err.to_string());
            }
        }
    }

    Ok(EndpointSpeedTestResult {
        requested_url: url,
        tested_url: None,
        success: false,
        status_code: None,
        latency_ms: None,
        error: last_error.or_else(|| Some("Endpoint test failed".to_string())),
    })
}

#[tauri::command]
pub fn set_provider_active(
    provider: String,
    is_active: bool,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<ProviderConfig, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;

    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    vault.set_provider_active(&provider, is_active)
}

#[tauri::command]
pub fn delete_provider(
    provider: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;

    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    vault.delete_provider(&provider)?;
    Ok(true)
}

#[tauri::command]
pub fn get_prompts(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Vec<PromptTemplate>, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;

    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    Ok(vault.get_prompts())
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ProviderUsageStatus {
    pub provider_id: String,
    pub enabled: bool,
    pub error: Option<String>,
    pub snapshot: Option<usage::UsageSnapshot>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UsageTrendPoint {
    pub captured_at: String,
    pub cost: Option<f64>,
    pub quota_percent: Option<f64>,
}

#[tauri::command]
pub async fn usage_refresh_all(
    state: State<'_, AppState>,
) -> Result<Vec<ProviderUsageStatus>, String> {
    Ok(usage::refresh_all_providers(&state).await)
}

#[tauri::command]
pub fn usage_get_summary(state: State<'_, AppState>) -> Result<Vec<ProviderUsageStatus>, String> {
    let settings = {
        let vault = state.vault.lock().map_err(|e| e.to_string())?;
        vault.get_usage_provider_settings()?
    };

    {
        let usage_state = state.usage.lock().map_err(|e| e.to_string())?;
        if usage_state.snapshots.is_empty() {
            drop(usage_state);
            let snapshots = {
                let vault = state.vault.lock().map_err(|e| e.to_string())?;
                vault.load_latest_usage_snapshots().unwrap_or_default()
            };
            let mut usage_state = state.usage.lock().map_err(|e| e.to_string())?;
            usage_state.update(snapshots);
        }
    }

    let usage_state = state.usage.lock().map_err(|e| e.to_string())?;
    let mut statuses = Vec::new();
    for provider in usage::KNOWN_PROVIDERS {
        let enabled = settings.get(provider).copied().unwrap_or(true);
        statuses.push(ProviderUsageStatus {
            provider_id: provider.to_string(),
            enabled,
            error: usage_state.get_error(provider),
            snapshot: usage_state.get(provider),
        });
    }
    Ok(statuses)
}

#[tauri::command]
pub fn usage_get_provider(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<Option<usage::UsageSnapshot>, String> {
    let usage_state = state.usage.lock().map_err(|e| e.to_string())?;
    Ok(usage_state.get(&provider_id))
}

#[tauri::command]
pub fn usage_get_trend(
    provider_id: String,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<UsageTrendPoint>, String> {
    let limit = limit.unwrap_or(30).clamp(5, 240);
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    let points = vault.load_usage_trend(&provider_id, limit)?;
    Ok(points
        .into_iter()
        .map(|(captured_at, cost, quota_percent)| UsageTrendPoint {
            captured_at,
            cost,
            quota_percent,
        })
        .collect())
}

#[tauri::command]
pub fn usage_set_provider_enabled(
    provider_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    vault.set_usage_provider_enabled(&provider_id, enabled)?;
    Ok(true)
}

#[tauri::command]
pub fn get_global_settings(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<GlobalSettingsPayload, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    let payload = vault.get_global_settings()?;
    drop(vault);
    let _ = crate::gateway::sync_gateway_runtime(state.inner());
    Ok(payload)
}

#[tauri::command]
pub fn set_global_debug_mode(
    enabled: bool,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.set_global_debug_mode(enabled)?;
    Ok(true)
}

#[tauri::command]
pub fn set_global_integration_enabled(
    app_type: String,
    enabled: bool,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.set_global_integration_enabled(&app_type, enabled)?;
    Ok(true)
}

#[tauri::command]
pub fn set_global_service_enabled(
    service_name: String,
    enabled: bool,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.set_global_service_enabled(&service_name, enabled)?;
    drop(vault);
    if service_name == "gateway" {
        crate::gateway::sync_gateway_runtime(state.inner())?;
    }
    Ok(true)
}

#[tauri::command]
pub fn set_global_service_auto_start(
    service_name: String,
    auto_start: bool,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.set_global_service_auto_start(&service_name, auto_start)?;
    Ok(true)
}

#[tauri::command]
pub fn set_global_service_port(
    service_name: String,
    port: i64,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.set_global_service_port(&service_name, port)?;
    drop(vault);
    if service_name == "gateway" {
        crate::gateway::sync_gateway_runtime(state.inner())?;
    }
    Ok(true)
}

#[tauri::command]
pub fn get_gateway_policy_settings(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<GatewayPolicySettings, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.get_gateway_policy_settings()
}

#[tauri::command]
pub fn set_gateway_circuit_breaker(
    enabled: bool,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.set_gateway_circuit_breaker(enabled)?;
    Ok(true)
}

#[tauri::command]
pub fn set_gateway_daily_budget(
    daily_budget_usd: Option<f64>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.set_gateway_daily_budget(daily_budget_usd)?;
    Ok(true)
}

#[tauri::command]
pub fn get_gateway_request_logs(
    limit: Option<i64>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Vec<GatewayRequestLog>, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    let limit = limit.unwrap_or(100).clamp(1, 500);
    vault.get_gateway_request_logs(limit)
}

#[tauri::command]
pub fn get_gateway_traffic_metrics(
    window_minutes: Option<i64>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<GatewayTrafficMetrics, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    let window = window_minutes.unwrap_or(60).clamp(5, 24 * 60);
    vault.get_gateway_traffic_metrics(window)
}

#[tauri::command]
pub fn get_app_routes(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Vec<AppRoute>, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.get_app_routes()
}

#[tauri::command]
pub fn set_app_route(
    app_type: String,
    provider: String,
    model: Option<String>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<AppRoute, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.set_app_route(&app_type, &provider, model)
}

#[tauri::command]
pub fn detect_app_route_from_live_config(
    app_type: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Option<AppRoute>, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.detect_app_route_from_live_config(&app_type)
}

#[tauri::command]
pub fn get_opencode_config_snapshot(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<OpencodeConfigSnapshot, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.get_opencode_config_snapshot()
}

#[tauri::command]
pub fn save_opencode_config_snapshot(
    config: Value,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.save_opencode_config_snapshot(config)
}

#[tauri::command]
pub fn get_integration_config_snapshot(
    app_type: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<IntegrationConfigSnapshot, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.get_integration_config_snapshot(&app_type)
}

#[tauri::command]
pub fn save_integration_config_snapshot(
    app_type: String,
    config: Value,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.save_integration_config_snapshot(&app_type, config)
}

#[tauri::command]
pub fn get_claude_tool_manager_mcps(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Vec<ExternalLibraryMcp>, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.get_claude_tool_manager_mcps()
}

#[tauri::command]
pub fn get_claude_tool_manager_skills(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Vec<ExternalLibrarySkill>, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.get_claude_tool_manager_skills()
}

#[tauri::command]
pub fn get_gateway_access_credentials(
    app_type: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<GatewayAccessCredentials, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.get_gateway_access_credentials(&app_type)
}

#[tauri::command]
pub fn backup_now(
    target_dir: Option<String>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.create_backup(target_dir)
}

#[tauri::command]
pub fn restore_backup(
    backup_path: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.restore_from_backup(backup_path)?;
    Ok(true)
}

#[tauri::command]
pub fn delete_backup(
    backup_path: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.delete_backup_file(backup_path)
}

fn open_macos_settings_url(url: &str) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("/usr/bin/open")
            .arg(url)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("Failed to open macOS settings url: {}", url));
        }
        Ok(true)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("This command is only supported on macOS".to_string())
    }
}

#[tauri::command]
pub fn open_path(path: String) -> Result<bool, String> {
    let target = Path::new(path.trim());
    if !target.exists() {
        return Err(format!("Path not found: {}", target.display()));
    }

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut command = Command::new("/usr/bin/open");
        command.arg(target);
        command
    };

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut command = Command::new("explorer");
        command.arg(target);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut command = Command::new("xdg-open");
        command.arg(target);
        command
    };

    let status = cmd.status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("Failed to open path: {}", target.display()));
    }
    Ok(true)
}

#[tauri::command]
pub fn add_project(
    name: String,
    path: String,
    credential_id: Option<String>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.add_project(name, path, credential_id)
}

#[tauri::command]
pub fn get_projects(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Vec<Project>, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.get_projects()
}

#[tauri::command]
pub fn update_project(
    id: String,
    name: String,
    path: String,
    credential_id: Option<String>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.update_project(id, name, path, credential_id)
}

#[tauri::command]
pub fn delete_project(
    id: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.delete_project(&id)?;
    Ok(true)
}

#[tauri::command]
pub fn auto_scan_projects(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Vec<Project>, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    let mut existing_paths: HashSet<String> = vault
        .get_projects()?
        .iter()
        .map(|project| normalize_path_for_compare(&project.path))
        .collect();

    let candidates = collect_project_candidates_from_claude_json();
    let mut added = Vec::new();

    for candidate in candidates {
        let normalized = normalize_path_for_compare(&candidate);
        let path_to_check = if candidate.starts_with("C:") || candidate.starts_with("c:") {
            candidate.clone()
        } else {
            normalized.clone()
        };

        let project_dir = Path::new(&path_to_check);
        if !project_dir.exists() || !project_dir.is_dir() {
            continue;
        }
        if existing_paths.contains(&normalized) {
            continue;
        }

        let name = Path::new(&candidate)
            .file_name()
            .and_then(|v| v.to_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "Project".to_string());

        let project = vault.add_project(name, normalized.clone(), None)?;
        added.push(project);
        existing_paths.insert(normalized);
    }

    Ok(added)
}

#[tauri::command]
pub fn clear_project_data(
    master_password: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }
    vault.clear_project_data()
}

#[tauri::command]
pub fn upsert_prompt(
    id: Option<String>,
    title: String,
    content: String,
    model: String,
    variables: Vec<String>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<PromptTemplate, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;

    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    vault.upsert_prompt(id, title, content, model, variables)
}

#[tauri::command]
pub fn delete_prompt(
    id: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;

    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    vault.delete_prompt(&id)?;
    Ok(true)
}

fn parse_env_content(content: &str, source: Option<String>) -> Vec<ParsedKey> {
    let mut parsed_keys = Vec::new();
    let mut seen_keys: HashSet<String> = HashSet::new();

    for line in content.lines() {
        if let Some((var_name, value)) = parse_env_line(line) {
            if is_dynamic_env_reference(&value) {
                continue;
            }
            if let Some(provider) = detect_provider(&var_name, &value) {
                let label = provider_label(provider);
                if seen_keys.insert(value.clone()) {
                    parsed_keys.push(ParsedKey {
                        provider: provider.to_string(),
                        name: format!("{} ({})", label, var_name),
                        key: value,
                        source: source.clone(),
                        variable: Some(var_name),
                    });
                }
            }
        }
    }

    parsed_keys
}

fn scan_env_sources(root_path: &str, variable_filter: Option<&HashSet<String>>) -> EnvScanResult {
    let mut result = EnvScanResult::default();
    let mut seen_values: HashSet<String> = HashSet::new();

    let walker = WalkDir::new(root_path).into_iter().filter_entry(|entry| {
        if !entry.file_type().is_dir() {
            return true;
        }
        !should_skip_scan_dir(&entry.file_name().to_string_lossy().to_lowercase())
    });

    for entry in walker {
        let entry = match entry {
            Ok(value) => value,
            Err(_) => continue,
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let file_name = entry.file_name().to_string_lossy();
        if !is_env_file(&file_name) {
            continue;
        }

        result.total_files += 1;
        let is_template = is_template_file(&file_name);
        let content = match std::fs::read_to_string(entry.path()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let relative_path = entry.path().strip_prefix(root_path).unwrap_or(entry.path());
        let source = relative_path.to_string_lossy().to_string();

        for line in content.lines() {
            let Some((var_name, value)) = parse_env_line(line) else {
                continue;
            };

            result.total_vars += 1;
            result.discovered_vars.insert(var_name.clone());
            if is_dynamic_env_reference(&value) {
                continue;
            }

            if is_template {
                continue;
            }
            if variable_filter.is_some_and(|allowed| !allowed.contains(&var_name)) {
                continue;
            }

            let provider = detect_provider(&var_name, &value).or_else(|| {
                if variable_filter.is_some() {
                    Some("general")
                } else {
                    None
                }
            });

            if let Some(provider) = provider {
                if seen_values.insert(value.clone()) {
                    result.parsed_keys.push(ParsedKey {
                        provider: provider.to_string(),
                        name: format!("{} ({})", provider_label(provider), var_name),
                        key: value,
                        source: Some(source.clone()),
                        variable: Some(var_name),
                    });
                }
            }
        }
    }

    result
}

fn scan_workflow_secrets(root_path: &str) -> WorkflowScanResult {
    let workflow_dir = Path::new(root_path).join(".github").join("workflows");
    let mut result = WorkflowScanResult::default();
    let mut secrets: HashSet<String> = HashSet::new();
    let secret_re = Regex::new(r"\$\{\{\s*secrets\.([A-Z_][A-Z0-9_]*)\s*\}\}").ok();

    let entries = match std::fs::read_dir(&workflow_dir) {
        Ok(value) => value,
        Err(_) => return result,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let ext = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_lowercase());
        if !matches!(ext.as_deref(), Some("yml") | Some("yaml")) {
            continue;
        }

        let content = match std::fs::read_to_string(&path) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let mut found = false;
        if let Some(re) = secret_re.as_ref() {
            for captures in re.captures_iter(&content) {
                if let Some(secret) = captures.get(1).map(|value| value.as_str().to_string()) {
                    secrets.insert(secret);
                    found = true;
                }
            }
        }

        if found {
            let relative = path
                .strip_prefix(root_path)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            result.files.push(relative);
        }
    }

    result.files.sort();
    result.secrets = secrets.into_iter().collect();
    result.secrets.sort();
    result
}

fn scan_wrangler(root_path: &str) -> WranglerScanResult {
    const CANDIDATES: [&str; 3] = ["wrangler.toml", "wrangler.jsonc", "wrangler.json"];
    const KNOWN_BINDINGS: [&str; 8] = [
        "kv_namespaces",
        "r2_buckets",
        "d1_databases",
        "queues",
        "analytics_engine_datasets",
        "ai",
        "durable_objects",
        "routes",
    ];

    let name_re = Regex::new(r#"(?m)^name\s*=\s*"([^"]+)""#).ok();
    let section_re = Regex::new(r#"(?m)^\[\[(\w+)\]\]"#).ok();
    let route_re = Regex::new(r#"(?m)^routes?\s*="#).ok();
    let mut result = WranglerScanResult::default();

    for candidate in CANDIDATES {
        let path = Path::new(root_path).join(candidate);
        let content = match std::fs::read_to_string(&path) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let mut projects = Vec::new();
        let mut bindings = Vec::new();

        if candidate == "wrangler.toml" {
            if let Some(re) = name_re.as_ref() {
                if let Some(name) = re
                    .captures(&content)
                    .and_then(|captures| captures.get(1))
                    .map(|value| value.as_str().to_string())
                {
                    projects.push(name);
                }
            }

            if let Some(re) = section_re.as_ref() {
                for captures in re.captures_iter(&content) {
                    if let Some(section) = captures.get(1).map(|value| value.as_str()) {
                        if KNOWN_BINDINGS.contains(&section)
                            && !bindings.contains(&section.to_string())
                        {
                            bindings.push(section.to_string());
                        }
                    }
                }
            }

            if route_re.as_ref().is_some_and(|re| re.is_match(&content))
                && !bindings.contains(&"routes".to_string())
            {
                bindings.push("routes".to_string());
            }
        } else {
            let parsed = json5::from_str::<Value>(&content);
            if let Ok(json) = parsed {
                if let Some(name) = json.get("name").and_then(|v| v.as_str()) {
                    projects.push(name.to_string());
                }
                if let Some(obj) = json.as_object() {
                    for key in obj.keys() {
                        if KNOWN_BINDINGS.contains(&key.as_str()) && !bindings.contains(key) {
                            bindings.push(key.clone());
                        }
                    }
                }
                if (json.get("route").is_some() || json.get("routes").is_some())
                    && !bindings.contains(&"routes".to_string())
                {
                    bindings.push("routes".to_string());
                }
            }
        }

        if !projects.is_empty() {
            projects.sort();
            bindings.sort();
            result.file = Some(candidate.to_string());
            result.projects = projects;
            result.bindings = bindings;
            return result;
        }
    }

    result
}

fn scan_package_dependencies(root_path: &str) -> Vec<String> {
    let mut dependencies: HashSet<String> = HashSet::new();
    let walker = WalkDir::new(root_path).into_iter().filter_entry(|entry| {
        if !entry.file_type().is_dir() {
            return true;
        }
        !should_skip_scan_dir(&entry.file_name().to_string_lossy().to_lowercase())
    });

    for entry in walker {
        let entry = match entry {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        if entry.file_name().to_string_lossy() != "package.json" {
            continue;
        }

        let content = match std::fs::read_to_string(entry.path()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let parsed = match serde_json::from_str::<Value>(&content) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if let Some(map) = parsed
            .get("dependencies")
            .and_then(|value| value.as_object())
        {
            for key in map.keys() {
                dependencies.insert(key.clone());
            }
        }
        if let Some(map) = parsed
            .get("devDependencies")
            .and_then(|value| value.as_object())
        {
            for key in map.keys() {
                dependencies.insert(key.clone());
            }
        }
    }

    let mut list = dependencies.into_iter().collect::<Vec<String>>();
    list.sort();
    list
}

fn load_shipkey_fields(root_path: &str) -> Vec<String> {
    let path = Path::new(root_path).join("shipkey.json");
    let content = match std::fs::read_to_string(path) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    let parsed = match serde_json::from_str::<Value>(&content) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    let providers = match parsed.get("providers").and_then(|value| value.as_object()) {
        Some(value) => value,
        None => return Vec::new(),
    };

    let mut fields: HashSet<String> = HashSet::new();
    for provider in providers.values() {
        if let Some(list) = provider.get("fields").and_then(|value| value.as_array()) {
            for field in list {
                if let Some(name) = field.as_str() {
                    let cleaned = name.trim();
                    if !cleaned.is_empty() {
                        fields.insert(cleaned.to_string());
                    }
                }
            }
        }
    }

    let mut list = fields.into_iter().collect::<Vec<String>>();
    list.sort();
    list
}

fn parse_env_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }

    let without_export = trimmed.strip_prefix("export ").unwrap_or(trimmed);
    let mut parts = without_export.splitn(2, '=');
    let key = parts.next()?.trim().to_string();
    let value_raw = parts.next()?.trim();
    if key.is_empty() {
        return None;
    }

    let value_stripped = strip_inline_comment(value_raw);
    let cleaned = value_stripped.trim().trim_matches('"').trim_matches('\'');
    if cleaned.is_empty() {
        return None;
    }

    Some((key, cleaned.to_string()))
}

fn strip_inline_comment(value: &str) -> &str {
    let mut in_single = false;
    let mut in_double = false;
    for (index, ch) in value.char_indices() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '#' if !in_single && !in_double => return &value[..index],
            _ => {}
        }
    }
    value
}

fn should_skip_scan_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".git" | "dist" | "build" | ".next" | ".turbo" | ".cache"
    )
}

fn is_dynamic_env_reference(value: &str) -> bool {
    value.starts_with("$(")
        || value.starts_with("${")
        || value.starts_with("op://")
        || value.contains("$(op ")
}

fn detect_provider(var_name: &str, value: &str) -> Option<&'static str> {
    let value_lower = value.to_lowercase();
    let name_lower = var_name.to_lowercase();

    let openai_re = Regex::new(r"^sk-proj-").ok();
    let anthropic_re = Regex::new(r"^sk-ant-").ok();
    let gemini_re = Regex::new(r"^AIzaSy").ok();
    let openrouter_re = Regex::new(r"^sk-or-").ok();
    let groq_re = Regex::new(r"^gsk_").ok();

    if openai_re.as_ref().is_some_and(|re| re.is_match(value)) {
        return Some("openai");
    }
    if anthropic_re.as_ref().is_some_and(|re| re.is_match(value)) {
        return Some("anthropic");
    }
    if gemini_re.as_ref().is_some_and(|re| re.is_match(value)) {
        return Some("gemini");
    }
    if openrouter_re.as_ref().is_some_and(|re| re.is_match(value)) {
        return Some("openrouter");
    }
    if groq_re.as_ref().is_some_and(|re| re.is_match(value)) {
        return Some("groq");
    }

    if name_lower.contains("openai") {
        return Some("openai");
    }
    if name_lower.contains("openrouter") {
        return Some("openrouter");
    }
    if name_lower.contains("anthropic") || name_lower.contains("claude") {
        return Some("anthropic");
    }
    if name_lower.contains("google_translate") || name_lower.contains("google-translate") {
        return Some("google-translate");
    }
    if name_lower.contains("deepl") {
        return Some("deepl");
    }
    if name_lower.contains("azure_translator")
        || name_lower.contains("microsoft_translator")
        || name_lower.contains("microsoft_translate")
    {
        return Some("microsoft-translate");
    }
    if name_lower.contains("gemini") || name_lower.contains("google") {
        return Some("gemini");
    }
    if name_lower.contains("deepseek") {
        return Some("deepseek");
    }
    if name_lower.contains("mistral") {
        return Some("mistral");
    }
    if name_lower.contains("together") {
        return Some("together");
    }
    if name_lower.contains("xai") {
        return Some("xai");
    }
    if name_lower.contains("perplexity") {
        return Some("perplexity");
    }
    if name_lower.contains("groq") {
        return Some("groq");
    }
    if name_lower.contains("qwen") {
        return Some("qwen");
    }
    if name_lower.contains("glm") {
        return Some("glm");
    }
    if name_lower.contains("ollama") {
        return Some("ollama");
    }
    if name_lower.contains("kimi") {
        return Some("kimi");
    }
    if name_lower.contains("volc") {
        return Some("volcengine");
    }
    if name_lower.contains("opencode") {
        return Some("opencode");
    }
    if name_lower.contains("openclaw") {
        return Some("openclaw");
    }
    if name_lower.contains("cloudflare") {
        return Some("cloudflare");
    }
    if name_lower.starts_with("aws") {
        return Some("aws");
    }
    if name_lower.contains("github") {
        return Some("github");
    }
    if name_lower.contains("stripe") {
        return Some("stripe");
    }
    if name_lower.contains("supabase") {
        return Some("supabase");
    }
    if name_lower.contains("upstash") {
        return Some("upstash");
    }
    if name_lower.contains("turso") {
        return Some("turso");
    }
    if name_lower.contains("neon") {
        return Some("neon");
    }
    if name_lower.contains("redis") {
        return Some("redis");
    }
    if name_lower.contains("database") || name_lower.starts_with("db_") {
        return Some("database");
    }
    if name_lower.contains("vercel") {
        return Some("vercel");
    }
    if name_lower.contains("twilio") {
        return Some("twilio");
    }
    if name_lower.contains("sendgrid") {
        return Some("sendgrid");
    }
    if name_lower.contains("resend") {
        return Some("resend");
    }
    if name_lower.contains("discord") {
        return Some("discord");
    }
    if name_lower.contains("slack") {
        return Some("slack");
    }
    if name_lower.contains("huggingface") || name_lower.starts_with("hf_") {
        return Some("huggingface");
    }
    if name_lower.contains("replicate") {
        return Some("replicate");
    }
    if name_lower.contains("fal") {
        return Some("fal");
    }
    if name_lower.contains("sentry") {
        return Some("sentry");
    }
    if name_lower.contains("npm") {
        return Some("npm");
    }
    if name_lower.contains("clerk") {
        return Some("clerk");
    }
    if name_lower.contains("auth0") {
        return Some("auth0");
    }
    if name_lower.contains("reddit") {
        return Some("reddit");
    }
    if name_lower.contains("producthunt") || name_lower.contains("product_hunt") {
        return Some("producthunt");
    }
    if name_lower.contains("ampcode")
        || name_lower == "amp_api_key"
        || name_lower == "amp_cli_path"
        || name_lower.starts_with("amp_")
    {
        return Some("amp");
    }

    if value_lower.starts_with("sk-") {
        return Some("openai");
    }

    None
}

fn provider_label(provider: &str) -> &'static str {
    match provider {
        "openai" => "OpenAI",
        "anthropic" => "Anthropic",
        "gemini" => "Gemini",
        "azure-openai" => "Azure OpenAI",
        "deepseek" => "DeepSeek",
        "google-ai" => "Google AI",
        "groq" => "Groq",
        "mistral" => "Mistral",
        "ollama" => "Ollama",
        "openrouter" => "OpenRouter",
        "perplexity" => "Perplexity",
        "together" => "Together",
        "xai" => "xAI",
        "deepl" => "DeepL",
        "google-translate" => "Google Translate",
        "google-translate-free" => "Google Translate (Free)",
        "microsoft-translate" => "Microsoft Translator",
        "apple-translate" => "Apple Translate (macOS)",
        "volcengine" => "Volcengine",
        "glm" => "GLM",
        "qwen" => "Qwen",
        "minimax" => "MiniMax",
        "kimi" => "Kimi",
        "opencode" => "OpenCode",
        "openclaw" => "OpenClaw",
        "amp" => "Amp",
        "cloudflare" => "Cloudflare",
        "aws" => "AWS",
        "github" => "GitHub",
        "stripe" => "Stripe",
        "supabase" => "Supabase",
        "upstash" => "Upstash",
        "turso" => "Turso",
        "neon" => "Neon",
        "database" => "Database",
        "redis" => "Redis",
        "vercel" => "Vercel",
        "twilio" => "Twilio",
        "sendgrid" => "SendGrid",
        "resend" => "Resend",
        "discord" => "Discord",
        "slack" => "Slack",
        "huggingface" => "Hugging Face",
        "replicate" => "Replicate",
        "fal" => "fal.ai",
        "sentry" => "Sentry",
        "npm" => "npm",
        "clerk" => "Clerk",
        "auth0" => "Auth0",
        "reddit" => "Reddit",
        "producthunt" => "Product Hunt",
        "general" => "General",
        _ => "Provider",
    }
}

fn normalize_root_path(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed == "~" || trimmed.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            if trimmed == "~" {
                return home.to_string_lossy().to_string();
            }
            let suffix = trimmed.trim_start_matches("~/");
            return home.join(suffix).to_string_lossy().to_string();
        }
    }
    trimmed.to_string()
}

fn normalize_path_for_compare(input: &str) -> String {
    let expanded = normalize_root_path(input).replace('\\', "/");
    if expanded.len() <= 1 {
        return expanded;
    }
    expanded.trim_end_matches('/').to_string()
}

fn collect_project_candidates_from_claude_json() -> Vec<String> {
    let mut candidates = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return candidates;
    };

    let claude_json_path = home.join(".claude.json");
    if !claude_json_path.exists() {
        return candidates;
    }

    let content = match std::fs::read_to_string(&claude_json_path) {
        Ok(value) => value,
        Err(_) => return candidates,
    };

    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(_) => return candidates,
    };

    if let Some(projects_obj) = json.get("projects").and_then(|v| v.as_object()) {
        let mut seen: HashSet<String> = HashSet::new();
        for path in projects_obj.keys() {
            let normalized = normalize_path_for_compare(path);
            if seen.insert(normalized.clone()) {
                candidates.push(normalized);
            }
        }
    }

    candidates
}

fn build_shipkey_scan_report(root: &str) -> Result<ShipkeyScanReport, String> {
    let shipkey_fields = load_shipkey_fields(root);
    let shipkey_filter = if shipkey_fields.is_empty() {
        None
    } else {
        Some(shipkey_fields.iter().cloned().collect::<HashSet<String>>())
    };

    let env_scan = scan_env_sources(root, shipkey_filter.as_ref());
    let workflow = scan_workflow_secrets(root);
    let wrangler = scan_wrangler(root);
    let dependencies = scan_package_dependencies(root);

    let missing_workflow_secrets = workflow
        .secrets
        .iter()
        .filter(|key| !env_scan.discovered_vars.contains(*key))
        .cloned()
        .collect::<Vec<String>>();

    Ok(ShipkeyScanReport {
        parsed_keys: env_scan.parsed_keys,
        env_files: env_scan.total_files,
        env_vars: env_scan.total_vars,
        workflow_files: workflow.files,
        workflow_secrets: workflow.secrets,
        missing_workflow_secrets,
        wrangler_file: wrangler.file,
        wrangler_projects: wrangler.projects,
        wrangler_bindings: wrangler.bindings,
        package_dependencies: dependencies,
        shipkey_fields: shipkey_fields.clone(),
        used_shipkey_config: !shipkey_fields.is_empty(),
    })
}

#[derive(Clone)]
struct ProjectSecretEntry {
    key: String,
    value: String,
    provider: String,
}

fn scan_project_secret_entries(project_root: &Path) -> Vec<ProjectSecretEntry> {
    let root = project_root.to_string_lossy().to_string();
    let env_scan = scan_env_sources(&root, None);
    let mut seen = HashSet::new();
    let mut items = Vec::new();

    for parsed in env_scan.parsed_keys {
        let Some(key) = parsed.variable else {
            continue;
        };
        let dedupe_key = format!("{}::{}", key, parsed.source.clone().unwrap_or_default());
        if !seen.insert(dedupe_key) {
            continue;
        }
        items.push(ProjectSecretEntry {
            key,
            value: parsed.key,
            provider: parsed.provider,
        });
    }

    items.sort_by(|a, b| a.key.cmp(&b.key));
    items
}

fn detect_project_name(root: &Path) -> Option<String> {
    let package_json = root.join("package.json");
    let content = std::fs::read_to_string(package_json).ok()?;
    let json = serde_json::from_str::<Value>(&content).ok()?;
    json.get("name")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn detect_git_repo_slug(root: &Path) -> Option<String> {
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() {
        return None;
    }

    let ssh_re = Regex::new(r"^git@github\.com:(.+?)\.git$").ok()?;
    if let Some(captures) = ssh_re.captures(&url) {
        return captures.get(1).map(|m| m.as_str().to_string());
    }

    let https_re = Regex::new(r"^https://github\.com/(.+?)(?:\.git)?$").ok()?;
    https_re
        .captures(&url)
        .and_then(|captures| captures.get(1))
        .map(|m| m.as_str().to_string())
}

fn ensure_onepassword_ready() -> Result<(), String> {
    let version = Command::new("op")
        .arg("--version")
        .output()
        .map_err(|e| format!("1Password CLI not found: {}", e))?;
    if !version.status.success() {
        return Err("1Password CLI is not available".to_string());
    }

    let service_account_ready = std::env::var("OP_SERVICE_ACCOUNT_TOKEN")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let connect_ready = std::env::var("OP_CONNECT_HOST")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
        && std::env::var("OP_CONNECT_TOKEN")
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
    if service_account_ready || connect_ready {
        return Ok(());
    }

    let account = Command::new("op")
        .args(["account", "list", "--format=json"])
        .output()
        .map_err(|e| format!("Failed to check 1Password login status: {}", e))?;
    if !account.status.success() {
        let stderr = String::from_utf8_lossy(&account.stderr);
        return Err(format!("1Password is not ready: {}", stderr.trim()));
    }
    let accounts = serde_json::from_slice::<Value>(&account.stdout)
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    if accounts.is_empty() {
        return Err(
            "1Password CLI has no signed-in account. Please sign in (desktop integration or `op account add`) and try again."
                .to_string(),
        );
    }
    Ok(())
}

fn ensure_onepassword_vault(vault_name: &str) -> Result<(), String> {
    let get_output = Command::new("op")
        .args(["vault", "get", vault_name])
        .output()
        .map_err(|e| e.to_string())?;
    if get_output.status.success() {
        return Ok(());
    }

    let create_output = Command::new("op")
        .args(["vault", "create", vault_name, "--icon", "vault-door"])
        .output()
        .map_err(|e| e.to_string())?;
    if create_output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&create_output.stderr)
            .trim()
            .to_string())
    }
}

fn onepassword_write_secret(
    vault_name: &str,
    provider: &str,
    project: &str,
    env: &str,
    field: &str,
    value: &str,
) -> Result<(), String> {
    let section = format!("{}-{}", project, env);
    let field_expr = format!("{}.{}[password]={}", section, field, value);

    let edit_output = Command::new("op")
        .args(["item", "edit", provider, "--vault", vault_name, &field_expr])
        .output()
        .map_err(|e| e.to_string())?;
    if edit_output.status.success() {
        return Ok(());
    }

    let create_output = Command::new("op")
        .args([
            "item",
            "create",
            "--vault",
            vault_name,
            "--category",
            "API Credential",
            "--title",
            provider,
            &field_expr,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if create_output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&create_output.stderr)
            .trim()
            .to_string())
    }
}

fn onepassword_collect_project_entries(
    vault_name: &str,
    env: &str,
) -> Result<HashMap<String, Vec<(String, String)>>, String> {
    let list_output = Command::new("op")
        .args(["item", "list", "--vault", vault_name, "--format", "json"])
        .output()
        .map_err(|e| e.to_string())?;
    if !list_output.status.success() {
        return Err(String::from_utf8_lossy(&list_output.stderr)
            .trim()
            .to_string());
    }

    let items_json = String::from_utf8_lossy(&list_output.stdout).to_string();
    let items = serde_json::from_str::<Value>(&items_json).map_err(|e| e.to_string())?;
    let Some(item_list) = items.as_array() else {
        return Ok(HashMap::new());
    };

    let mut result: HashMap<String, Vec<(String, String)>> = HashMap::new();

    for item in item_list {
        let Some(item_id) = item.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let detail_output = Command::new("op")
            .args([
                "item", "get", item_id, "--vault", vault_name, "--format", "json",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !detail_output.status.success() {
            continue;
        }

        let detail_json = String::from_utf8_lossy(&detail_output.stdout).to_string();
        let detail = match serde_json::from_str::<Value>(&detail_json) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(fields) = detail.get("fields").and_then(|v| v.as_array()) else {
            continue;
        };

        for field in fields {
            let section = field
                .get("section")
                .and_then(|s| s.get("label"))
                .and_then(|v| v.as_str());
            let label = field.get("label").and_then(|v| v.as_str());
            let Some(section) = section else { continue };
            let Some(label) = label else { continue };

            let suffix = format!("-{}", env);
            if !section.ends_with(&suffix) {
                continue;
            }
            let project = section.trim_end_matches(&suffix).to_string();
            if project.is_empty() {
                continue;
            }

            let uri = format!("op://{}/{}/{}/{}", vault_name, item_id, section, label);
            let value_output = Command::new("op")
                .args(["read", &uri])
                .output()
                .map_err(|e| e.to_string())?;
            if !value_output.status.success() {
                continue;
            }
            let value = String::from_utf8_lossy(&value_output.stdout)
                .trim()
                .to_string();
            if value.is_empty() {
                continue;
            }
            result
                .entry(project)
                .or_default()
                .push((label.to_string(), value));
        }
    }

    for entries in result.values_mut() {
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        entries.dedup_by(|a, b| a.0 == b.0);
    }

    Ok(result)
}

fn write_project_env_file(
    project_path: &Path,
    entries: &[(String, String)],
) -> Result<String, String> {
    let target = if project_path.join("wrangler.toml").exists()
        || project_path.join("wrangler.json").exists()
        || project_path.join("wrangler.jsonc").exists()
    {
        project_path.join(".dev.vars")
    } else {
        project_path.join(".env.local")
    };

    let existing = std::fs::read_to_string(&target).unwrap_or_default();
    let mut lines = if existing.is_empty() {
        Vec::new()
    } else {
        existing
            .lines()
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
    };

    for (key, value) in entries {
        let formatted = format!("{}={}", key, format_env_value(value));
        if let Some(index) = lines
            .iter()
            .position(|line| line.starts_with(&format!("{key}=")))
        {
            lines[index] = formatted;
        } else {
            lines.push(formatted);
        }
    }

    let mut content = lines.join("\n");
    if !content.ends_with('\n') {
        content.push('\n');
    }
    std::fs::write(&target, content).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

fn format_env_value(value: &str) -> String {
    if value.contains(' ') || value.contains('#') || value.contains('"') {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        value.to_string()
    }
}
