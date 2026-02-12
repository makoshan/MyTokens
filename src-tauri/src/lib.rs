use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;

mod commands;
mod gateway;
mod provider_defaults;
mod secret_store;
mod usage;
mod vault;

use vault::Vault;

pub struct AppState {
    vault: Mutex<Vault>,
    usage: Mutex<usage::UsageState>,
    gateway: Mutex<gateway::GatewayRuntime>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Credential {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub key: String,
    pub created_at: String,
    pub is_active: bool,
    pub source: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderConfig {
    pub provider: String,
    pub label: String,
    pub api_key: String,
    pub base_url: String,
    pub updated_at: String,
    pub is_active: bool,
    pub models: Vec<String>,
    pub endpoints: Vec<ProviderEndpoint>,
    pub env_vars: Vec<ProviderEnvVar>,
    pub app_bindings: Vec<ProviderAppBinding>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PromptTemplate {
    pub id: String,
    pub title: String,
    pub content: String,
    pub model: String,
    pub variables: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderEndpoint {
    pub id: String,
    pub provider: String,
    pub base_url: String,
    pub headers: Option<String>,
    pub timeout_ms: Option<i64>,
    pub proxy_url: Option<String>,
    pub is_primary: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderModel {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub alias: Option<String>,
    pub context_window: Option<i64>,
    pub input_price: Option<f64>,
    pub output_price: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderEnvVar {
    pub id: String,
    pub provider: String,
    pub key: String,
    pub value: String,
    pub is_secret: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderAppBinding {
    pub id: String,
    pub provider: String,
    pub app_type: String,
    pub config_path: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppIntegration {
    pub id: String,
    pub app_type: String,
    pub detected: bool,
    pub enabled: bool,
    pub config_path: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppRoute {
    pub app_type: String,
    pub provider: String,
    pub model: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OpencodeConfigSnapshot {
    pub config_path: String,
    pub config: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IntegrationConfigSnapshot {
    pub app_type: String,
    pub config_path: String,
    pub config: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExternalLibraryMcp {
    pub name: String,
    pub mcp_type: String,
    pub description: Option<String>,
    pub command: Option<String>,
    pub url: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExternalLibrarySkill {
    pub name: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServiceConfig {
    pub service_name: String,
    pub enabled: bool,
    pub auto_start: bool,
    pub port: Option<i64>,
    pub running: bool,
    pub health: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GlobalSettingsPayload {
    pub debug_mode: bool,
    pub log_level: String,
    pub integrations: Vec<AppIntegration>,
    pub services: Vec<ServiceConfig>,
    pub database_path: String,
    pub logs_path: String,
    pub last_backup_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub credential_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let vault = Vault::new();
    let app_state = AppState {
        vault: Mutex::new(vault),
        usage: Mutex::new(usage::UsageState::default()),
        gateway: Mutex::new(gateway::GatewayRuntime::default()),
    };

    tauri::Builder::default()
        .manage(app_state)
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            app.handle().plugin(tauri_plugin_dialog::init())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::set_master_password,
            commands::authenticate,
            commands::is_password_set,
            commands::add_credential,
            commands::get_credentials,
            commands::update_credential,
            commands::delete_credential,
            commands::get_credential_project_labels,
            commands::set_credential_project_label,
            commands::parse_env_file,
            commands::scan_env_dir,
            commands::get_providers,
            commands::upsert_provider,
            commands::set_provider_active,
            commands::delete_provider,
            commands::get_prompts,
            commands::upsert_prompt,
            commands::delete_prompt,
            commands::usage_refresh_all,
            commands::usage_get_summary,
            commands::usage_get_provider,
            commands::usage_get_trend,
            commands::usage_set_provider_enabled,
            commands::get_global_settings,
            commands::set_global_debug_mode,
            commands::set_global_integration_enabled,
            commands::set_global_service_enabled,
            commands::set_global_service_auto_start,
            commands::set_global_service_port,
            commands::get_app_routes,
            commands::set_app_route,
            commands::get_opencode_config_snapshot,
            commands::save_opencode_config_snapshot,
            commands::get_integration_config_snapshot,
            commands::save_integration_config_snapshot,
            commands::get_claude_tool_manager_mcps,
            commands::get_claude_tool_manager_skills,
            commands::backup_now,
            commands::open_path,
            commands::add_project,
            commands::get_projects,
            commands::delete_project,
            commands::update_project,
            commands::auto_scan_projects,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
