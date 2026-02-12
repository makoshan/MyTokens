use crate::{
    usage, AppRoute, AppState, Credential, ExternalLibraryMcp, ExternalLibrarySkill,
    GatewayAccessCredentials, GatewayPolicySettings, GatewayRequestLog, GlobalSettingsPayload,
    IntegrationConfigSnapshot, OpencodeConfigSnapshot, Project, PromptTemplate, ProviderConfig,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;
use tauri::State;
use walkdir::WalkDir;

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

    let mut parsed_keys = Vec::new();
    let mut seen_keys: HashSet<String> = HashSet::new();

    let walker = WalkDir::new(&normalized_root)
        .into_iter()
        .filter_entry(|entry| {
            if !entry.file_type().is_dir() {
                return true;
            }
            let name = entry.file_name().to_string_lossy().to_lowercase();
            name != "node_modules"
                && name != ".git"
                && name != "dist"
                && name != "build"
                && name != ".next"
                && name != ".turbo"
                && name != ".cache"
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
        if !is_env_file(&file_name) || is_template_file(&file_name) {
            continue;
        }

        let content = match std::fs::read_to_string(entry.path()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let relative_path = entry
            .path()
            .strip_prefix(&normalized_root)
            .unwrap_or(entry.path());
        let source = relative_path.to_string_lossy().to_string();
        for item in parse_env_content(&content, Some(source.clone())) {
            if seen_keys.insert(item.key.clone()) {
                parsed_keys.push(item);
            }
        }
    }

    Ok(parsed_keys)
}

fn is_env_file(file_name: &str) -> bool {
    file_name == ".env"
        || (file_name.starts_with(".env.") && file_name.len() > 5)
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
    api_key: String,
    base_url: String,
    models: Vec<String>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<ProviderConfig, String> {
    let mut vault = state.vault.lock().map_err(|e| e.to_string())?;

    if !vault.authenticate(&master_password) {
        return Err("Invalid master password".to_string());
    }

    vault.upsert_provider(provider, api_key, base_url, models)
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
    if name_lower.contains("anthropic") || name_lower.contains("claude") {
        return Some("anthropic");
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
    if name_lower.contains("openrouter") {
        return Some("openrouter");
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
        "volcengine" => "Volcengine",
        "glm" => "GLM",
        "qwen" => "Qwen",
        "minimax" => "MiniMax",
        "kimi" => "Kimi",
        "opencode" => "OpenCode",
        "openclaw" => "OpenClaw",
        "amp" => "Amp",
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
