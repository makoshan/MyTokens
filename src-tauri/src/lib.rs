use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri::WebviewUrl;
use tauri::WebviewWindowBuilder;
use tauri_plugin_global_shortcut::ShortcutState;

mod commands;
mod gateway;
mod provider_defaults;
mod secret_store;
mod usage;
mod vault;
mod voice_input;

use vault::Vault;

pub struct AppState {
    vault: Arc<Mutex<Vault>>,
    usage: Arc<Mutex<usage::UsageState>>,
    gateway: Arc<Mutex<gateway::GatewayRuntime>>,
    quick_runtime: Arc<Mutex<QuickRuntimeState>>,
    voice_runtime: Arc<voice_input::VoiceInputRuntime>,
}

#[derive(Debug, Clone)]
pub struct QuickRuntimeState {
    pub translate_hotkey: String,
    pub ocr_hotkey: String,
    pub last_action_type: Option<String>,
    pub last_source_text: Option<String>,
    pub last_ocr_text: Option<String>,
    pub last_result: Option<QuickActionResult>,
    pub last_translate_provider: Option<String>,
    pub last_ocr_provider: Option<String>,
    pub last_trigger_shortcut: Option<String>,
    pub last_trigger_at: Option<String>,
    pub last_register_at: Option<String>,
    pub last_register_error: Option<String>,
}

impl Default for QuickRuntimeState {
    fn default() -> Self {
        Self {
            translate_hotkey: "Option+D".to_string(),
            ocr_hotkey: "Option+S".to_string(),
            last_action_type: None,
            last_source_text: None,
            last_ocr_text: None,
            last_result: None,
            last_translate_provider: None,
            last_ocr_provider: None,
            last_trigger_shortcut: None,
            last_trigger_at: None,
            last_register_at: None,
            last_register_error: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QuickActionSettings {
    pub translate_hotkey: String,
    pub ocr_hotkey: String,
    pub default_translate_provider: String,
    pub default_ocr_provider: String,
    pub source_lang: String,
    pub target_lang: String,
    pub auto_close_seconds: i64,
    pub updated_at: String,
}

impl Default for QuickActionSettings {
    fn default() -> Self {
        Self {
            translate_hotkey: "Option+D".to_string(),
            ocr_hotkey: "Option+S".to_string(),
            default_translate_provider: "google-translate".to_string(),
            default_ocr_provider: "apple-ocr".to_string(),
            source_lang: "auto".to_string(),
            target_lang: "zh-Hans".to_string(),
            auto_close_seconds: 15,
            updated_at: String::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QuickActionResult {
    pub action_type: String,
    pub source_text: Option<String>,
    pub ocr_text: Option<String>,
    pub result_text: Option<String>,
    pub provider: String,
    pub translate_provider: Option<String>,
    pub ocr_provider: Option<String>,
    pub latency_ms: i64,
    pub status: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QuickActionHistoryRecord {
    pub id: String,
    pub action_type: String,
    pub source_text: Option<String>,
    pub ocr_text: Option<String>,
    pub result_text: Option<String>,
    pub provider: String,
    pub latency_ms: i64,
    pub status: String,
    pub error_code: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GatewayAccessCredentials {
    pub app_type: String,
    pub base_url: String,
    pub api_key: String,
    pub provider: String,
    pub model: Option<String>,
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
    pub details: ProviderDetails,
    pub endpoints: Vec<ProviderEndpoint>,
    pub env_vars: Vec<ProviderEnvVar>,
    pub app_bindings: Vec<ProviderAppBinding>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderDetails {
    pub website_url: String,
    pub notes: String,
    pub main_model: String,
    pub reasoning_model: String,
    pub default_haiku_model: String,
    pub default_sonnet_model: String,
    pub default_opus_model: String,
    pub settings_json: String,
    pub use_common_config: bool,
    pub test_config_enabled: bool,
    pub test_model: String,
    pub test_timeout_secs: Option<i64>,
    pub test_prompt: String,
    pub test_degraded_threshold_ms: Option<i64>,
    pub test_max_retries: Option<i64>,
    pub proxy_config_enabled: bool,
    pub proxy_url: String,
    pub proxy_username: String,
    pub proxy_password: String,
}

impl Default for ProviderDetails {
    fn default() -> Self {
        Self {
            website_url: String::new(),
            notes: String::new(),
            main_model: String::new(),
            reasoning_model: String::new(),
            default_haiku_model: String::new(),
            default_sonnet_model: String::new(),
            default_opus_model: String::new(),
            settings_json: "{\n  \"env\": {},\n  \"includeCoAuthoredBy\": false\n}".to_string(),
            use_common_config: false,
            test_config_enabled: false,
            test_model: String::new(),
            test_timeout_secs: None,
            test_prompt: String::new(),
            test_degraded_threshold_ms: None,
            test_max_retries: None,
            proxy_config_enabled: false,
            proxy_url: String::new(),
            proxy_username: String::new(),
            proxy_password: String::new(),
        }
    }
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
pub struct ProviderEndpointInput {
    pub id: Option<String>,
    pub base_url: String,
    pub headers: Option<String>,
    pub timeout_ms: Option<i64>,
    pub proxy_url: Option<String>,
    pub is_primary: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderEnvVarInput {
    pub id: Option<String>,
    pub key: String,
    pub value: String,
    pub is_secret: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderAppBindingInput {
    pub id: Option<String>,
    pub app_type: String,
    pub config_path: String,
    pub enabled: bool,
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
pub struct GatewayPolicySettings {
    pub circuit_breaker_enabled: bool,
    pub daily_budget_usd: Option<f64>,
    pub today_request_count: i64,
    pub today_cost_usd: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GatewayRequestLog {
    pub id: String,
    pub created_at: String,
    pub app_type: String,
    pub provider: String,
    pub model: Option<String>,
    pub endpoint: String,
    pub status_code: i64,
    pub latency_ms: i64,
    pub blocked_reason: Option<String>,
    pub error_code: Option<String>,
    pub estimated_cost_usd: Option<f64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub user_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GatewayTrafficGroup {
    pub key: String,
    pub requests: i64,
    pub success_requests: i64,
    pub error_requests: i64,
    pub blocked_requests: i64,
    pub estimated_cost_usd: f64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_tokens: i64,
    pub avg_latency_ms: Option<f64>,
    pub p95_latency_ms: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GatewayErrorSummary {
    pub code: String,
    pub requests: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GatewayTrafficPoint {
    pub minute: String,
    pub requests: i64,
    pub error_requests: i64,
    pub total_tokens: i64,
    pub avg_latency_ms: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GatewayTrafficMetrics {
    pub window_minutes: i64,
    pub total_requests: i64,
    pub success_requests: i64,
    pub client_error_requests: i64,
    pub server_error_requests: i64,
    pub blocked_requests: i64,
    pub requests_per_minute: f64,
    pub avg_latency_ms: Option<f64>,
    pub p95_latency_ms: Option<i64>,
    pub estimated_cost_usd: f64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_tokens: i64,
    pub by_app: Vec<GatewayTrafficGroup>,
    pub by_provider: Vec<GatewayTrafficGroup>,
    pub by_model: Vec<GatewayTrafficGroup>,
    pub by_user: Vec<GatewayTrafficGroup>,
    pub top_errors: Vec<GatewayErrorSummary>,
    pub timeline: Vec<GatewayTrafficPoint>,
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
        vault: Arc::new(Mutex::new(vault)),
        usage: Arc::new(Mutex::new(usage::UsageState::default())),
        gateway: Arc::new(Mutex::new(gateway::GatewayRuntime::default())),
        quick_runtime: Arc::new(Mutex::new(QuickRuntimeState::default())),
        voice_runtime: Arc::new(voice_input::VoiceInputRuntime::default()),
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
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, shortcut, event| {
                        if event.state != ShortcutState::Pressed {
                            return;
                        }
                        commands::dispatch_quick_shortcut(app, &shortcut);
                    })
                    .build(),
            )?;
            ensure_quick_result_window(app)?;
            // Voice overlay window is a small always-on-top indicator for voice input recording/transcription.
            let _ = voice_input::ensure_voice_overlay_window(app.handle());
            let _ = commands::register_quick_hotkeys_on_startup(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::set_master_password,
            commands::authenticate,
            commands::is_password_set,
            commands::mykey_capabilities,
            commands::mykey_command,
            commands::add_credential,
            commands::get_credentials,
            commands::update_credential,
            commands::delete_credential,
            commands::get_credential_project_labels,
            commands::set_credential_project_label,
            commands::parse_env_file,
            commands::scan_env_dir,
            commands::scan_shipkey_dir,
            commands::generate_mykey_sync_config,
            commands::backup_scanned_projects_to_onepassword,
            commands::restore_scanned_projects_from_onepassword,
            commands::get_providers,
            commands::upsert_provider,
            commands::set_provider_active,
            commands::delete_provider,
            commands::test_provider_endpoint,
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
            commands::get_gateway_policy_settings,
            commands::set_gateway_circuit_breaker,
            commands::set_gateway_daily_budget,
            commands::get_gateway_request_logs,
            commands::get_gateway_traffic_metrics,
            commands::list_gateway_model_catalog,
            commands::get_app_routes,
            commands::set_app_route,
            commands::detect_app_route_from_live_config,
            commands::get_opencode_config_snapshot,
            commands::save_opencode_config_snapshot,
            commands::get_integration_config_snapshot,
            commands::save_integration_config_snapshot,
            commands::get_claude_tool_manager_mcps,
            commands::get_claude_tool_manager_skills,
            commands::get_gateway_access_credentials,
            commands::run_python_code,
            commands::clippy_codex_chat,
            commands::backup_now,
            commands::restore_backup,
            commands::delete_backup,
            commands::open_path,
            commands::get_quick_action_settings,
            commands::set_quick_action_settings,
            commands::register_quick_hotkeys,
            commands::trigger_quick_translate,
            commands::trigger_quick_ocr,
            commands::retry_last_quick_action,
            commands::get_quick_provider_options,
            commands::quick_clippy_assist,
            commands::hide_quick_result_panel,
            commands::get_last_quick_action_result,
            commands::get_quick_action_auto_close_seconds,
            commands::get_quick_action_history,
            commands::get_quick_hotkey_diagnostics,
            commands::get_macos_permission_status,
            commands::open_macos_accessibility_settings,
            commands::open_macos_automation_settings,
            commands::open_macos_screen_capture_settings,
            commands::open_macos_input_monitoring_settings,
            commands::open_macos_keyboard_settings,
            commands::get_voice_input_settings,
            commands::set_voice_input_settings,
            commands::initialize_voice_input_listener,
            commands::voice_input_transcribe,
            commands::get_voice_input_diagnostics,
            commands::add_project,
            commands::get_projects,
            commands::delete_project,
            commands::update_project,
            commands::auto_scan_projects,
            commands::clear_project_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn ensure_quick_result_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if app.get_webview_window("quick-result").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        "quick-result",
        WebviewUrl::App("index.html#/quick-result".into()),
    )
    .title("MyKey Quick Result")
    .inner_size(560.0, 420.0)
    .min_inner_size(440.0, 320.0)
    .visible(false)
    .resizable(true)
    .always_on_top(true)
    .decorations(true)
    .skip_taskbar(true)
    .build()?;
    Ok(())
}
