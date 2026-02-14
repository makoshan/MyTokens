use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::WebviewUrl;
use tauri::WebviewWindowBuilder;
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_log::{Target, TargetKind};

mod commands;
mod gateway;
mod provider_defaults;
pub mod stt;
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

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn toggle_voice_input(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let next = {
        let mut vault = match state.vault.lock() {
            Ok(v) => v,
            Err(_) => return,
        };
        let mut settings = vault.get_voice_input_settings().ok().unwrap_or_default();
        settings.voice_input_enabled = !settings.voice_input_enabled;
        let next = match vault.set_voice_input_settings(settings) {
            Ok(v) => v,
            Err(_) => return,
        };
        next
    };

    if next.voice_input_enabled && commands::is_supported_voice_trigger_mode(&next.voice_trigger_mode) {
        state.voice_runtime.stop_listener();
        let trigger = commands::normalize_voice_trigger_mode(&next.voice_trigger_mode)
            .unwrap_or_else(|| "fn_hold".to_string());
        let _ = state.voice_runtime.start_hold_listener(
            app.clone(),
            trigger,
            next.voice_hold_ms,
            next.voice_min_record_ms,
            next.voice_hands_free_enabled,
        );
    } else {
        state.voice_runtime.stop_listener();
    }
}

fn cycle_claude_code_model(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let mut vault = match state.vault.lock() {
        Ok(v) => v,
        Err(_) => return,
    };
    let routes = match vault.get_app_routes() {
        Ok(v) => v,
        Err(_) => return,
    };
    let current = routes
        .iter()
        .find(|r| r.app_type == "claude-code")
        .cloned();
    let provider = current
        .as_ref()
        .map(|r| r.provider.as_str())
        .unwrap_or("anthropic");
    let current_model = current.as_ref().and_then(|r| r.model.clone());

    let provider_cfg = match vault.get_provider_config(provider) {
        Some(v) => v,
        None => return,
    };
    let mut candidates: Vec<String> = provider_cfg
        .models
        .iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect();
    candidates.dedup();
    if candidates.is_empty() {
        return;
    }

    let next_model = match current_model.as_deref() {
        None => candidates.first().cloned(),
        Some(cur) => {
            let idx = candidates.iter().position(|v| v == cur).unwrap_or(usize::MAX);
            if idx == usize::MAX {
                candidates.first().cloned()
            } else {
                candidates.get((idx + 1) % candidates.len()).cloned()
            }
        }
    };
    let Some(next_model) = next_model else {
        return;
    };
    let _ = vault.set_app_route("claude-code", provider, Some(next_model));
}

fn setup_tray(app: &tauri::App) -> Result<(), tauri::Error> {
    let handle = app.handle();
    let show = MenuItem::with_id(handle, "tray_show", "显示 MyKey", true, None::<&str>)?;
    let hide = MenuItem::with_id(handle, "tray_hide", "隐藏 MyKey", true, None::<&str>)?;
    let toggle_voice =
        MenuItem::with_id(handle, "tray_toggle_voice", "开关语音输入", true, None::<&str>)?;
    let cycle_claude =
        MenuItem::with_id(handle, "tray_cycle_claude", "Claude Code: 切换模型", true, None::<&str>)?;
    let quit = MenuItem::with_id(handle, "tray_quit", "退出", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(handle)?;
    let sep2 = PredefinedMenuItem::separator(handle)?;

    let menu = Menu::with_items(
        handle,
        &[&show, &hide, &sep1, &toggle_voice, &cycle_claude, &sep2, &quit],
    )?;

    TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event: tauri::menu::MenuEvent| {
            match event.id().as_ref() {
                "tray_show" => show_main_window(app),
                "tray_hide" => hide_main_window(app),
                "tray_toggle_voice" => toggle_voice_input(app),
                "tray_cycle_claude" => cycle_claude_code_model(app),
                "tray_quit" => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
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
pub struct VoiceInputHistoryRecord {
    pub id: String,
    pub session_id: Option<String>,
    pub trigger_mode: String,
    pub raw_text: Option<String>,
    pub final_text: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub language: Option<String>,
    pub latency_ms: Option<i64>,
    pub pasted: bool,
    pub cancelled: bool,
    pub error: Option<String>,
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
            // Always enable file logs so users can debug permission/hotkey issues without DevTools.
            // macOS default: ~/Library/Logs/{bundleIdentifier}/mykey.log
            let log_dir = app.path().app_log_dir().ok();
            let mut log_builder = tauri_plugin_log::Builder::default();
            log_builder = log_builder.level(if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            });
            if let Some(dir) = log_dir {
                log_builder = log_builder.clear_targets().targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::Folder {
                        path: dir,
                        file_name: Some("mykey".into()),
                    }),
                ]);
            }
            app.handle().plugin(log_builder.build())?;
            app.handle().plugin(tauri_plugin_dialog::init())?;
            #[cfg(target_os = "macos")]
            {
                // Required for PanelBuilder on macOS; registers WebviewPanelManager state.
                app.handle().plugin(tauri_nspanel::init())?;
            }
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
            setup_tray(app)?;
            ensure_quick_result_window(app)?;
            // Voice overlay window is a small always-on-top indicator for voice input recording/transcription.
            let _ = voice_input::ensure_voice_overlay_window(app.handle());
            // Start voice input listener early so it keeps working even when the main window is hidden.
            {
                let state = app.handle().state::<AppState>();
                let vault_arc = Arc::clone(&state.vault);
                let voice_runtime = Arc::clone(&state.voice_runtime);
                drop(state);

                let settings = match vault_arc.lock() {
                    Ok(vault) => vault.get_voice_input_settings().ok(),
                    Err(_) => None,
                };

                if let Some(settings) = settings {
                    if settings.voice_input_enabled {
                        let trigger = match settings
                            .voice_trigger_mode
                            .trim()
                            .to_ascii_lowercase()
                            .as_str()
                        {
                            "fn_hold" => "fn_hold".to_string(),
                            "option_hold" => "option_hold".to_string(),
                            "fn_option_hold" | "fn_or_option_hold" => "fn_option_hold".to_string(),
                            _ => "fn_hold".to_string(),
                        };
                        let _ = voice_runtime.start_hold_listener(
                            app.handle().clone(),
                            trigger,
                            settings.voice_hold_ms,
                            settings.voice_min_record_ms,
                            settings.voice_hands_free_enabled,
                        );
                    }
                }
            }
            let _ = commands::register_quick_hotkeys_on_startup(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // On macOS we treat closing the main window as "hide" so the app can keep running
            // (quick actions, voice input, etc).
            #[cfg(target_os = "macos")]
            {
                if window.label() != "main" {
                    return;
                }
                let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                    return;
                };
                api.prevent_close();
                let _ = window.hide();
            }
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
            commands::get_recent_debug_logs,
            commands::get_voice_input_settings,
            commands::set_voice_input_settings,
            commands::initialize_voice_input_listener,
            commands::voice_input_frontend_cancel,
            commands::voice_input_transcribe,
            commands::get_voice_input_diagnostics,
            commands::get_voice_input_history,
            commands::delete_voice_input_history,
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
