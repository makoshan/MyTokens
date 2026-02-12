use crate::{
    usage, AppRoute, AppState, Credential, ExternalLibraryMcp, ExternalLibrarySkill,
    GatewayAccessCredentials, GatewayPolicySettings, GatewayRequestLog, GatewayTrafficMetrics,
    GlobalSettingsPayload, IntegrationConfigSnapshot, OpencodeConfigSnapshot, Project,
    PromptTemplate,
    ProviderAppBindingInput, ProviderConfig, ProviderDetails, ProviderEndpointInput,
    ProviderEnvVarInput,
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::str::FromStr;
use std::time::Duration;
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

fn as_object_args(args: Option<Value>) -> Result<serde_json::Map<String, Value>, String> {
    match args {
        None => Ok(serde_json::Map::new()),
        Some(Value::Object(map)) => Ok(map),
        Some(_) => Err("args must be a JSON object".to_string()),
    }
}

fn required_string_arg(
    args: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, String> {
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
            let Some(contents) = output_item.get("content").and_then(|item| item.as_array()) else {
                continue;
            };
            for content in contents {
                if let Some(text) = content.get("text").and_then(|item| item.as_str()) {
                    let text = text.trim();
                    if !text.is_empty() {
                        chunks.push(text.to_string());
                    }
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

#[tauri::command]
pub async fn clippy_codex_chat(
    question: String,
    system_prompt: Option<String>,
    model: Option<String>,
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
        (enabled, creds.base_url, creds.api_key)
    };

    if !gateway_enabled {
        return Err("Gateway 服务未启用，请在全局设置中启用".to_string());
    }

    crate::gateway::sync_gateway_runtime(state.inner())?;

    let gateway_endpoint = format!("{}/responses", gateway_base_url.trim_end_matches('/'));
    let model_name = model
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .unwrap_or_else(|| "gpt-5-codex".to_string());
    let system = system_prompt
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .unwrap_or_else(|| "你是 MyKey 内置 Clippy 助手，请用中文简洁回答。".to_string());

    let payload = json!({
        "model": model_name,
        "stream": false,
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

    let mut candidates = vec![format!("{}/models", base)];
    if !base.ends_with("/v1") {
        candidates.push(format!("{}/v1/models", base));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout))
        .build()
        .map_err(|e| e.to_string())?;

    let mut last_error: Option<String> = None;

    for target in candidates {
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
        Err(String::from_utf8_lossy(&create_output.stderr).trim().to_string())
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
        Err(String::from_utf8_lossy(&create_output.stderr).trim().to_string())
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
        return Err(String::from_utf8_lossy(&list_output.stderr).trim().to_string());
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
            .args(["item", "get", item_id, "--vault", vault_name, "--format", "json"])
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
            let value = String::from_utf8_lossy(&value_output.stdout).trim().to_string();
            if value.is_empty() {
                continue;
            }
            result.entry(project).or_default().push((label.to_string(), value));
        }
    }

    for entries in result.values_mut() {
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        entries.dedup_by(|a, b| a.0 == b.0);
    }

    Ok(result)
}

fn write_project_env_file(project_path: &Path, entries: &[(String, String)]) -> Result<String, String> {
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
        existing.lines().map(|line| line.to_string()).collect::<Vec<_>>()
    };

    for (key, value) in entries {
        let formatted = format!("{}={}", key, format_env_value(value));
        if let Some(index) = lines.iter().position(|line| line.starts_with(&format!("{key}="))) {
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
