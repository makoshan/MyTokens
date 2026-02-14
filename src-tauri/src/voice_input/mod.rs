use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, CollectionBehavior, PanelBuilder, PanelLevel};

pub const VOICE_INPUT_EVENT_START: &str = "voice_input_start";
pub const VOICE_INPUT_EVENT_STOP: &str = "voice_input_stop";
pub const VOICE_INPUT_EVENT_CANCEL: &str = "voice_input_cancel";

pub const VOICE_OVERLAY_EVENT: &str = "voice_overlay_update";
const VOICE_OVERLAY_WINDOW_LABEL: &str = "voice-overlay";

const TRANSCRIBE_WATCHDOG_MS: u64 = 75_000;

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(VoiceOverlayPanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true
        }
    })
}

mod audio;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VoiceOverlayPayload {
    pub state: String, // hidden | recording | transcribing | done | error
    pub text: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct VoiceInputSettings {
    pub voice_input_enabled: bool,
    pub voice_trigger_mode: String, // "fn_hold"
    pub voice_hold_ms: i64,
    pub voice_min_record_ms: i64,
    pub voice_hands_free_enabled: bool,
    pub voice_stt_provider: String,
    pub voice_stt_model: String,
    pub voice_language: String, // "auto" or BCP-47
    pub voice_ai_auto_edit: bool,
    pub voice_ai_model: String,
    pub voice_auto_paste: bool,
    pub voice_paste_delay_ms: i64,
    pub voice_restore_clipboard: bool,
    pub voice_append_trailing_space: bool,
    pub updated_at: String,
}

impl Default for VoiceInputSettings {
    fn default() -> Self {
        Self {
            voice_input_enabled: false,
            voice_trigger_mode: "fn_hold".to_string(),
            voice_hold_ms: 200,
            voice_min_record_ms: 300,
            voice_hands_free_enabled: false,
            voice_stt_provider: "elevenlabs".to_string(),
            voice_stt_model: "scribe_v2".to_string(),
            voice_language: "zh".to_string(),
            voice_ai_auto_edit: false,
            voice_ai_model: String::new(),
            voice_auto_paste: true,
            voice_paste_delay_ms: 120,
            voice_restore_clipboard: false,
            voice_append_trailing_space: true,
            updated_at: String::new(),
        }
    }
}

impl VoiceInputSettings {
    pub fn normalized(mut self, now_rfc3339: String) -> Self {
        if self.voice_trigger_mode.trim().is_empty() {
            self.voice_trigger_mode = "fn_hold".to_string();
        }
        let trigger = self.voice_trigger_mode.trim().to_ascii_lowercase();
        self.voice_trigger_mode = match trigger.as_str() {
            "fn_hold" => "fn_hold".to_string(),
            "option_hold" => "option_hold".to_string(),
            "fn_option_hold" | "fn_or_option_hold" => "fn_option_hold".to_string(),
            _ => "fn_hold".to_string(),
        };
        self.voice_hold_ms = self.voice_hold_ms.clamp(120, 800);
        self.voice_min_record_ms = self.voice_min_record_ms.clamp(120, 8000);
        if self.voice_stt_provider.trim().is_empty() {
            self.voice_stt_provider = "elevenlabs".to_string();
        }
        if self.voice_stt_model.trim().is_empty() {
            self.voice_stt_model = "scribe_v2".to_string();
        }
        if self.voice_language.trim().is_empty() {
            self.voice_language = "zh".to_string();
        }
        if self.voice_ai_model.trim().is_empty() {
            self.voice_ai_model = String::new();
        }
        self.voice_paste_delay_ms = self.voice_paste_delay_ms.clamp(0, 1200);
        self.updated_at = now_rfc3339;
        self
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct VoiceInputDiagnostics {
    pub listener_running: bool,
    pub fn_is_down: bool,
    pub fn_edge_count: i64,
    pub last_fn_edge_at: Option<String>,
    // Raw event tap diagnostics: helps distinguish permission/tap issues vs "Fn is not emitted".
    pub raw_event_count: i64,
    pub last_raw_event_at: Option<String>,
    pub last_raw_event_type: Option<String>,
    pub last_raw_keycode: Option<i64>,
    pub tap_location: Option<String>,
    pub is_recording: bool,
    pub waiting_transcribe: bool,
    pub last_trigger_at: Option<String>,
    pub last_stop_at: Option<String>,
    pub last_latency_ms: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VoiceInputStartPayload {
    pub session_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VoiceInputStopPayload {
    pub session_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VoiceInputCancelPayload {
    pub session_id: Option<String>,
    pub reason: String,
}

pub struct VoiceInputRuntime {
    running: Arc<AtomicBool>,
    thread_handle: Mutex<Option<JoinHandle<()>>>,
    diagnostics: Arc<Mutex<VoiceInputDiagnostics>>,
    // Transcribe cancellation channel for the current in-flight transcription (single-flight).
    transcribe_cancel_tx: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    transcribe_session_id: Arc<Mutex<Option<String>>>,
}

impl Default for VoiceInputRuntime {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            thread_handle: Mutex::new(None),
            diagnostics: Arc::new(Mutex::new(VoiceInputDiagnostics::default())),
            transcribe_cancel_tx: Arc::new(Mutex::new(None)),
            transcribe_session_id: Arc::new(Mutex::new(None)),
        }
    }
}

impl VoiceInputRuntime {
    pub fn diagnostics_arc(&self) -> Arc<Mutex<VoiceInputDiagnostics>> {
        Arc::clone(&self.diagnostics)
    }

    pub fn get_diagnostics(&self) -> VoiceInputDiagnostics {
        self.diagnostics
            .lock()
            .map(|d| d.clone())
            .unwrap_or_default()
    }

    pub fn set_active_transcribe(&self, session_id: String, tx: tokio::sync::oneshot::Sender<()>) {
        if let Ok(mut id) = self.transcribe_session_id.lock() {
            *id = Some(session_id);
        }
        if let Ok(mut slot) = self.transcribe_cancel_tx.lock() {
            *slot = Some(tx);
        }
    }

    pub fn clear_active_transcribe(&self, session_id: &str) {
        if let Ok(mut id) = self.transcribe_session_id.lock() {
            if id.as_deref() == Some(session_id) {
                *id = None;
            }
        }
        if let Ok(mut slot) = self.transcribe_cancel_tx.lock() {
            // Drop sender to free resources.
            *slot = None;
        }
    }

    pub fn cancel_active_transcribe(&self) -> Option<String> {
        let session_id = self
            .transcribe_session_id
            .lock()
            .ok()
            .and_then(|v| v.clone());

        if let Ok(mut slot) = self.transcribe_cancel_tx.lock() {
            if let Some(tx) = slot.take() {
                let _ = tx.send(());
            }
        }

        if let Ok(mut id) = self.transcribe_session_id.lock() {
            *id = None;
        }

        if let Ok(mut d) = self.diagnostics.lock() {
            d.waiting_transcribe = false;
        }

        session_id
    }

    pub fn start_hold_listener(
        &self,
        app: AppHandle,
        trigger_mode: String,
        hold_threshold_ms: i64,
        min_record_ms: i64,
        hands_free_enabled: bool,
    ) -> Result<(), String> {
        let trigger_mode = match trigger_mode.trim().to_ascii_lowercase().as_str() {
            "fn_hold" => "fn_hold".to_string(),
            "option_hold" => "option_hold".to_string(),
            "fn_option_hold" | "fn_or_option_hold" => "fn_option_hold".to_string(),
            _ => return Err("Unsupported voice trigger mode".to_string()),
        };
        if self.running.swap(true, Ordering::SeqCst) {
            // Already running.
            return Ok(());
        }

        {
            if let Ok(mut d) = self.diagnostics.lock() {
                d.listener_running = true;
                d.last_error = None;
            }
        }

        let running = Arc::clone(&self.running);
        let diagnostics = Arc::clone(&self.diagnostics);
        let cancel_tx = Arc::clone(&self.transcribe_cancel_tx);
        let transcribe_session_id = Arc::clone(&self.transcribe_session_id);
        let handle = thread::spawn(move || {
            #[cfg(target_os = "macos")]
            {
                let running_for_loop = Arc::clone(&running);
                let diagnostics_for_loop = Arc::clone(&diagnostics);
                if let Err(err) = modifier_hold_loop(
                    app,
                    running_for_loop,
                    diagnostics_for_loop,
                    cancel_tx,
                    transcribe_session_id,
                    trigger_mode,
                    hold_threshold_ms,
                    min_record_ms,
                    hands_free_enabled,
                ) {
                    if let Ok(mut d) = diagnostics.lock() {
                        d.last_error = Some(err);
                    }
                    running.store(false, Ordering::SeqCst);
                    if let Ok(mut d) = diagnostics.lock() {
                        d.listener_running = false;
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = app;
                let _ = hold_threshold_ms;
                let _ = min_record_ms;
                let _ = trigger_mode;
                if let Ok(mut d) = diagnostics.lock() {
                    d.last_error = Some(
                        "Voice input Fn-hold listener currently supports macOS only".to_string(),
                    );
                    d.listener_running = false;
                }
                running.store(false, Ordering::SeqCst);
            }
        });

        if let Ok(mut slot) = self.thread_handle.lock() {
            *slot = Some(handle);
        }

        Ok(())
    }

    pub fn start_fn_hold_listener(
        &self,
        app: AppHandle,
        hold_threshold_ms: i64,
        min_record_ms: i64,
    ) -> Result<(), String> {
        self.start_hold_listener(
            app,
            "fn_hold".to_string(),
            hold_threshold_ms,
            min_record_ms,
            false,
        )
    }

    pub fn start_option_hold_listener(
        &self,
        app: AppHandle,
        hold_threshold_ms: i64,
        min_record_ms: i64,
    ) -> Result<(), String> {
        self.start_hold_listener(
            app,
            "option_hold".to_string(),
            hold_threshold_ms,
            min_record_ms,
            false,
        )
    }

    pub fn stop_listener(&self) {
        self.running.store(false, Ordering::SeqCst);
        if let Ok(mut slot) = self.thread_handle.lock() {
            if let Some(handle) = slot.take() {
                let _ = handle.join();
            }
        }
        if let Ok(mut d) = self.diagnostics.lock() {
            d.listener_running = false;
            d.fn_is_down = false;
            d.is_recording = false;
            d.waiting_transcribe = false;
        }
    }

    pub fn mark_transcribe_latency(&self, latency_ms: i64) {
        if let Ok(mut d) = self.diagnostics.lock() {
            d.last_latency_ms = Some(latency_ms);
        }
    }

    pub fn mark_error(&self, msg: String) {
        if let Ok(mut d) = self.diagnostics.lock() {
            d.last_error = Some(msg);
        }
    }

    pub fn clear_waiting_transcribe(&self) {
        if let Ok(mut d) = self.diagnostics.lock() {
            d.waiting_transcribe = false;
        }
    }
}

fn calculate_overlay_position(app: &AppHandle, width: f64, height: f64) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    let work_w = work.size.width as f64 / scale;
    let work_h = work.size.height as f64 / scale;
    let work_x = work.position.x as f64 / scale;
    let work_y = work.position.y as f64 / scale;

    let x = work_x + (work_w - width) / 2.0;
    let y = work_y + work_h - height - 70.0;
    Some((x, y))
}

pub fn ensure_voice_overlay_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(VOICE_OVERLAY_WINDOW_LABEL).is_some() {
        return Ok(());
    }

    let (w, h) = (260.0_f64, 46.0_f64);

    // On macOS, use a non-activating NSPanel so the overlay doesn't steal focus from
    // the currently active app (critical for reliable auto-paste).
    #[cfg(target_os = "macos")]
    {
        if let Some((x, y)) = calculate_overlay_position(app, w, h) {
            PanelBuilder::<_, VoiceOverlayPanel>::new(app, VOICE_OVERLAY_WINDOW_LABEL)
                .url(WebviewUrl::App("index.html#/voice-overlay".into()))
                .title("MyKey Voice Overlay")
                .position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
                .level(PanelLevel::Status)
                .size(tauri::Size::Logical(tauri::LogicalSize { width: w, height: h }))
                .has_shadow(false)
                .transparent(true)
                .no_activate(true)
                .corner_radius(0.0)
                .collection_behavior(
                    CollectionBehavior::new()
                        .can_join_all_spaces()
                        .full_screen_auxiliary(),
                )
                .with_window(|w| {
                    w.resizable(false)
                        .visible(false)
                        .decorations(false)
                        .skip_taskbar(true)
                        .transparent(true)
                        .shadow(false)
                        .focused(false)
                        .focusable(false)
                })
                .build()
                .map_err(|e| e.to_string())?;

            if let Some(window) = app.get_webview_window(VOICE_OVERLAY_WINDOW_LABEL) {
                let _ = window.set_ignore_cursor_events(true);
                let _ = window.hide();
            }
            return Ok(());
        }
    }
    let mut builder = WebviewWindowBuilder::new(
        app,
        VOICE_OVERLAY_WINDOW_LABEL,
        WebviewUrl::App("index.html#/voice-overlay".into()),
    )
    .title("MyKey Voice Overlay")
    .resizable(false)
    .visible(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .shadow(false)
    .focused(false)
    .focusable(false)
    .inner_size(w, h);

    if let Some((x, y)) = calculate_overlay_position(app, w, h) {
        builder = builder.position(x, y);
    } else {
        builder = builder.center();
    }

    let window = builder.build().map_err(|e: tauri::Error| e.to_string())?;
    let _ = window.set_ignore_cursor_events(true);
    Ok(())
}

pub fn set_voice_overlay_state(app: &AppHandle, state: &str, text: Option<String>) {
    if let Some(window) = app.get_webview_window(VOICE_OVERLAY_WINDOW_LABEL) {
        if state == "hidden" {
            let _ = window.hide();
            let _ = window.emit(
                VOICE_OVERLAY_EVENT,
                VoiceOverlayPayload {
                    state: "hidden".to_string(),
                    text: None,
                },
            );
            return;
        }

        let _ = window.show();
        let _ = window.emit(
            VOICE_OVERLAY_EVENT,
            VoiceOverlayPayload {
                state: state.to_string(),
                text,
            },
        );
    }
}

pub fn hide_voice_overlay_after(app: AppHandle, delay_ms: u64) {
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(delay_ms));
        set_voice_overlay_state(&app, "hidden", None);
    });
}

#[cfg(target_os = "macos")]
fn begin_transcribe_session(
    app: AppHandle,
    diagnostics: Arc<Mutex<VoiceInputDiagnostics>>,
    transcribe_cancel_tx: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    transcribe_session_id: Arc<Mutex<Option<String>>>,
    skip_paste_flag: Arc<AtomicBool>,
    trigger_mode: String,
    session_id: String,
    audio_bytes: Vec<u8>,
    show_overlay: bool,
) {
    let stop_mark = chrono::Local::now().to_rfc3339();
    if show_overlay {
        set_voice_overlay_state(&app, "transcribing", None);
    } else {
        set_voice_overlay_state(&app, "hidden", None);
    }

    if let Ok(mut d) = diagnostics.lock() {
        d.is_recording = false;
        d.waiting_transcribe = true;
        d.last_stop_at = Some(stop_mark.clone());
    }

    if let Ok(mut id) = transcribe_session_id.lock() {
        *id = Some(session_id.clone());
    }

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    if let Ok(mut slot) = transcribe_cancel_tx.lock() {
        *slot = Some(cancel_tx);
    }

    let app_wd = app.clone();
    let diagnostics_wd = Arc::clone(&diagnostics);
    let cancel_tx_wd = Arc::clone(&transcribe_cancel_tx);
    let transcribe_session_id_wd = Arc::clone(&transcribe_session_id);
    let skip_paste_wd = Arc::clone(&skip_paste_flag);
    let session_id_wd = session_id.clone();

    let app_tx = app.clone();
    let diagnostics_tx = Arc::clone(&diagnostics);
    let cancel_tx_task = Arc::clone(&transcribe_cancel_tx);
    let transcribe_session_id_task = Arc::clone(&transcribe_session_id);
    let skip_paste_task = Arc::clone(&skip_paste_flag);
    let trigger_mode_task = trigger_mode.clone();
    let session_id_task = session_id.clone();

    tauri::async_runtime::spawn(async move {
        let started_at = Instant::now();
        let state = app_tx.state::<crate::AppState>();

        let (settings, provider, api_key) = {
            let vault = match state.vault.lock() {
                Ok(v) => v,
                Err(e) => {
                    let msg = format!("Vault lock failed: {}", e);
                    set_voice_overlay_state(&app_tx, "error", Some(msg.clone()));
                    hide_voice_overlay_after(app_tx.clone(), 2400);
                    return;
                }
            };
            let settings = match vault.get_voice_input_settings() {
                Ok(v) => v,
                Err(e) => {
                    set_voice_overlay_state(&app_tx, "error", Some(e.clone()));
                    hide_voice_overlay_after(app_tx.clone(), 2400);
                    return;
                }
            };
            let provider = match vault.get_provider_config(&settings.voice_stt_provider) {
                Some(v) => v,
                None => {
                    let msg = format!("Provider not found: {}", settings.voice_stt_provider);
                    set_voice_overlay_state(&app_tx, "error", Some(msg.clone()));
                    hide_voice_overlay_after(app_tx.clone(), 2400);
                    return;
                }
            };
            let api_key = crate::commands::resolve_provider_auth(&vault, &provider);
            (settings, provider, api_key)
        };

        if api_key.trim().is_empty() {
            let msg = "STT Provider API Key 为空（请先解锁并配置 STT Provider Key）".to_string();
            if let Ok(mut d) = diagnostics_tx.lock() {
                d.waiting_transcribe = false;
                d.last_error = Some(msg.clone());
            }
            set_voice_overlay_state(&app_tx, "error", Some(msg));
            hide_voice_overlay_after(app_tx.clone(), 2400);
            return;
        }

        let model = settings.voice_stt_model.trim().to_string();
        let language = settings.voice_language.trim().to_string();
        let file_name = "voice.wav";

        let transcribe_fut = async {
            match provider.provider.as_str() {
                "elevenlabs" => {
                    crate::commands::transcribe_with_elevenlabs(
                        &provider,
                        &api_key,
                        &model,
                        &language,
                        file_name,
                        audio_bytes,
                    )
                    .await
                }
                _ => {
                    crate::commands::transcribe_with_openai_compatible(
                        &provider,
                        &api_key,
                        &model,
                        &language,
                        file_name,
                        audio_bytes,
                    )
                    .await
                }
            }
        };
        tokio::pin!(transcribe_fut);

        let stt_result = tokio::select! {
            _ = cancel_rx => Err("Cancelled".to_string()),
            res = &mut transcribe_fut => res,
        };

        let latency_ms = started_at.elapsed().as_millis() as i64;
        if let Ok(mut d) = diagnostics_tx.lock() {
            d.last_latency_ms = Some(latency_ms);
            d.waiting_transcribe = false;
        }
        if let Ok(mut slot) = cancel_tx_task.lock() {
            *slot = None;
        }
        if let Ok(mut id) = transcribe_session_id_task.lock() {
            *id = None;
        }

        match stt_result {
            Ok(text) => {
                let raw_text = text.trim().to_string();
                let mut final_text = raw_text.clone();
                let mut post_error: Option<String> = None;

                // Optional AI post-processing (rewrite/format) via local gateway.
                if settings.voice_ai_auto_edit && !final_text.is_empty() {
                    // Hide/pause overlay updates if the user already cancelled paste.
                    if show_overlay && !skip_paste_task.load(Ordering::SeqCst) {
                        set_voice_overlay_state(&app_tx, "processing", None);
                    }

                    // Best-effort: start gateway runtime if configured.
                    let _ = crate::gateway::sync_gateway_runtime(state.inner());

                    let (gateway_base_url, gateway_api_key, gateway_open_responses, model_name) = {
                        let vault = state.vault.lock().ok();
                        if let Some(vault) = vault.as_ref() {
                            let open_responses = vault.gateway_open_responses_enabled().unwrap_or(false);
                            match vault.get_gateway_access_credentials("codex") {
                                Ok(creds) => {
                                    let model_name = settings
                                        .voice_ai_model
                                        .trim()
                                        .to_string();
                                    let model_name = if !model_name.is_empty() {
                                        model_name
                                    } else {
                                        creds
                                            .model
                                            .as_deref()
                                            .map(|v| v.trim().to_string())
                                            .filter(|v| !v.is_empty())
                                            .unwrap_or_else(|| "gpt-5-mini".to_string())
                                    };
                                    (Some(creds.base_url), Some(creds.api_key), open_responses, model_name)
                                }
                                Err(_err) => (None, None, open_responses, String::new()),
                            }
                        } else {
                            (None, None, false, String::new())
                        }
                    };

                    if let (Some(base_url), Some(api_key)) = (gateway_base_url, gateway_api_key) {
                        // Keep prompt short to reduce latency/cost.
                        let system_prompt = "你是一个专业的中文写作助手。请将用户的口述内容编辑成清晰、简洁、可直接发送的文本。要求：保持原意，不添加新信息；删除口头禅/填充词；删除不必要的重复；若用户改口只保留最终表达；把口述的列表/步骤格式化为清晰的条目/编号。只输出最终文本。";
                        match crate::commands::gateway_responses_text(
                            &base_url,
                            &api_key,
                            gateway_open_responses,
                            &model_name,
                            system_prompt,
                            &final_text,
                        )
                        .await
                        {
                            Ok(rewritten) => {
                                let rewritten = rewritten.trim();
                                if !rewritten.is_empty() {
                                    final_text = rewritten.to_string();
                                }
                            }
                            Err(err) => {
                                post_error = Some(err);
                            }
                        }
                    } else {
                        post_error = Some("AI 自动编辑不可用：未配置或无法启动 Gateway/codex 路由".to_string());
                    }
                }

                if settings.voice_append_trailing_space && !final_text.is_empty() {
                    if !final_text.ends_with(char::is_whitespace) {
                        final_text.push(' ');
                    }
                }

                let cancelled = skip_paste_task.load(Ordering::SeqCst);
                let mut pasted = false;
                let mut output_error: Option<String> = None;

                #[cfg(target_os = "macos")]
                {
                    if !cancelled {
                        if settings.voice_auto_paste && !final_text.is_empty() {
                            let delay_ms = settings.voice_paste_delay_ms.max(0) as u64;
                            match crate::commands::paste_text_via_clipboard(
                                &final_text,
                                delay_ms,
                                settings.voice_restore_clipboard,
                            ) {
                                Ok(did_paste) => pasted = did_paste,
                                Err(err) => output_error = Some(err),
                            }
                        } else if !final_text.is_empty() {
                            let _ = crate::commands::write_clipboard_text(&final_text);
                        }
                    }
                }

                // Save history (best-effort).
                let history = crate::VoiceInputHistoryRecord {
                    id: uuid::Uuid::new_v4().to_string(),
                    session_id: Some(session_id_task.clone()),
                    trigger_mode: trigger_mode_task.clone(),
                    raw_text: if raw_text.is_empty() { None } else { Some(raw_text) },
                    final_text: if final_text.trim().is_empty() {
                        None
                    } else {
                        Some(final_text.trim().to_string())
                    },
                    provider: Some(provider.provider.clone()),
                    model: Some(model.clone()),
                    language: Some(language.clone()),
                    latency_ms: Some(latency_ms),
                    pasted,
                    cancelled,
                    error: output_error
                        .clone()
                        .or_else(|| post_error.clone())
                        .filter(|v| !v.trim().is_empty()),
                    created_at: chrono::Local::now().to_rfc3339(),
                };
                if let Ok(vault) = state.vault.lock() {
                    if let Err(err) = vault.append_voice_input_history(&history) {
                        log::warn!("append_voice_input_history failed: {}", err);
                    }
                }

                if let Some(msg) = output_error {
                    if let Ok(mut d) = diagnostics_tx.lock() {
                        d.last_error = Some(msg.clone());
                    }
                    set_voice_overlay_state(&app_tx, "error", Some(msg));
                    hide_voice_overlay_after(app_tx.clone(), 2200);
                } else if cancelled {
                    // User requested cancel: do not paste; still show a brief "saved" state.
                    if let Ok(mut d) = diagnostics_tx.lock() {
                        d.last_error = None;
                    }
                    set_voice_overlay_state(&app_tx, "saved", Some(final_text.trim().to_string()));
                    hide_voice_overlay_after(app_tx.clone(), 900);
                } else {
                    if let Ok(mut d) = diagnostics_tx.lock() {
                        d.last_error = post_error.clone();
                    }
                    set_voice_overlay_state(&app_tx, "done", Some(final_text.trim().to_string()));
                    hide_voice_overlay_after(app_tx.clone(), 1200);
                }
            }
            Err(err) => {
                if err == "Cancelled" {
                    set_voice_overlay_state(&app_tx, "hidden", None);
                } else {
                    if let Ok(mut d) = diagnostics_tx.lock() {
                        d.last_error = Some(err.clone());
                    }
                    set_voice_overlay_state(&app_tx, "error", Some(err));
                    hide_voice_overlay_after(app_tx.clone(), 2400);
                }
            }
        }

        // Clear skip-paste flag for the next session.
        skip_paste_task.store(false, Ordering::SeqCst);
    });

    thread::spawn(move || {
        thread::sleep(Duration::from_millis(TRANSCRIBE_WATCHDOG_MS));
        let should_timeout = diagnostics_wd
            .lock()
            .ok()
            .map(|d| d.waiting_transcribe && d.last_stop_at.as_deref() == Some(stop_mark.as_str()))
            .unwrap_or(false);
        if !should_timeout {
            return;
        }

        if let Ok(mut slot) = cancel_tx_wd.lock() {
            if let Some(tx) = slot.take() {
                let _ = tx.send(());
            }
        }
        if let Ok(mut id) = transcribe_session_id_wd.lock() {
            *id = None;
        }
        if let Ok(mut d) = diagnostics_wd.lock() {
            d.waiting_transcribe = false;
            d.last_error = Some("转写超时".to_string());
        }
        skip_paste_wd.store(false, Ordering::SeqCst);

        set_voice_overlay_state(&app_wd, "error", Some("转写超时，已取消".to_string()));
        hide_voice_overlay_after(app_wd.clone(), 2400);
        let _ = app_wd.emit(
            VOICE_INPUT_EVENT_CANCEL,
            VoiceInputCancelPayload {
                session_id: Some(session_id_wd),
                reason: "转写超时，已取消".to_string(),
            },
        );
    });
}

#[cfg(target_os = "macos")]
fn modifier_hold_loop(
    app: AppHandle,
    running: Arc<AtomicBool>,
    diagnostics: Arc<Mutex<VoiceInputDiagnostics>>,
    transcribe_cancel_tx: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    transcribe_session_id: Arc<Mutex<Option<String>>>,
    trigger_mode: String,
    hold_threshold_ms: i64,
    min_record_ms: i64,
    hands_free_enabled: bool,
) -> Result<(), String> {
    // NOTE: handy-keys' KeyboardListener may not emit standalone Fn edges reliably.
    // Use a CGEventTap on FlagsChanged and track the SecondaryFn flag.
    use core_foundation::base::TCFType;
    use core_foundation::runloop::{kCFRunLoopCommonModes, kCFRunLoopDefaultMode, CFRunLoop};
    use core_graphics::event::{
        CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
        CGEventType, EventField,
    };

    extern "C" {
        fn CGEventTapEnable(tap: core_foundation::mach_port::CFMachPortRef, enable: bool);
    }

    #[derive(Debug)]
    struct TapState {
        fn_down: bool,
        pending_id: Option<String>,
        recording: Option<(String, Instant)>,
        hands_free_active: bool,
    }

    // Exposed by CoreGraphics. This is what macOS uses for "Input Monitoring" preflight.
    // We don't hard-fail here; we use it to pick a more reliable tap location.
    extern "C" {
        fn CGPreflightListenEventAccess() -> bool;
    }

    let hold_threshold = Duration::from_millis(hold_threshold_ms.max(0) as u64);
    let min_record = Duration::from_millis(min_record_ms.max(0) as u64);

    enum AudioCommand {
        Start(std::sync::mpsc::Sender<Result<(), String>>),
        Stop(std::sync::mpsc::Sender<Result<Vec<u8>, String>>),
        Cancel,
    }

    let (audio_cmd_tx, audio_cmd_rx) = std::sync::mpsc::channel::<AudioCommand>();
    thread::spawn(move || {
        let mut recorder: Option<audio::VoiceAudioRecorder> = None;
        while let Ok(cmd) = audio_cmd_rx.recv() {
            match cmd {
                AudioCommand::Start(reply) => {
                    if recorder.is_some() {
                        let _ = reply.send(Ok(()));
                        continue;
                    }
                    let next = audio::VoiceAudioRecorder::start();
                    match next {
                        Ok(value) => {
                            recorder = Some(value);
                            let _ = reply.send(Ok(()));
                        }
                        Err(err) => {
                            recorder = None;
                            let _ = reply.send(Err(err));
                        }
                    }
                }
                AudioCommand::Stop(reply) => {
                    let current = recorder.take();
                    match current {
                        None => {
                            let _ = reply.send(Err("No active recorder".to_string()));
                        }
                        Some(r) => {
                            let result = r.stop(16_000);
                            let _ = reply.send(result);
                        }
                    }
                }
                AudioCommand::Cancel => {
                    recorder = None;
                }
            }
        }
    });
    let trigger_mode = match trigger_mode.trim().to_ascii_lowercase().as_str() {
        "fn_hold" => "fn_hold",
        "option_hold" => "option_hold",
        "fn_option_hold" | "fn_or_option_hold" => "fn_option_hold",
        _ => "fn_hold",
    };

    let state = Arc::new(Mutex::new(TapState {
        fn_down: false,
        pending_id: None,
        recording: None,
        hands_free_active: false,
    }));

    // Single-flight "skip auto paste" flag (Esc cancels paste but still saves to history).
    let transcribe_skip_paste = Arc::new(AtomicBool::new(false));

    let app_for_cb = app.clone();
    let state_for_cb = Arc::clone(&state);
    let running_for_cb = Arc::clone(&running);
    let diagnostics_for_cb = Arc::clone(&diagnostics);
    let skip_paste_for_cb = Arc::clone(&transcribe_skip_paste);

    // Keep a handle to the Mach port so the callback can re-enable the tap if macOS disables it.
    let tap_port_ref = Arc::new(Mutex::new(0usize));
    let tap_port_ref_cb = Arc::clone(&tap_port_ref);

    // Keep the session tap aligned with handy-keys behavior; it is friendlier for
    // background global listening across app focus changes.
    let input_monitoring_granted = unsafe { CGPreflightListenEventAccess() };
    let tap_location = CGEventTapLocation::Session;
    if let Ok(mut d) = diagnostics.lock() {
        d.tap_location = Some(format!(
            "{:?}{}",
            tap_location,
            if input_monitoring_granted {
                ""
            } else {
                " (input_monitoring_not_granted)"
            }
        ));
    }

    let tap = CGEventTap::new(
        tap_location,
        CGEventTapPlacement::TailAppendEventTap,
        CGEventTapOptions::Default,
        vec![
            CGEventType::FlagsChanged,
            CGEventType::KeyDown,
            CGEventType::KeyUp,
        ],
        move |_proxy, etype, event| {
            if !running_for_cb.load(Ordering::SeqCst) {
                return None;
            }

            let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as i64;
            if let Ok(mut d) = diagnostics_for_cb.lock() {
                d.raw_event_count = d.raw_event_count.saturating_add(1);
                d.last_raw_event_at = Some(chrono::Local::now().to_rfc3339());
                d.last_raw_event_type = Some(format!("{:?}", etype));
                // Only meaningful for keyboard-ish events.
                d.last_raw_keycode = Some(keycode);
            }

            // Hands-free mode toggle: Fn + Space (macOS often binds this to input-source switching,
            // so we null the key event when hands-free is enabled to avoid inserting a space).
            if hands_free_enabled
                && matches!(etype, CGEventType::KeyDown | CGEventType::KeyUp)
                && keycode == 49
                && event
                    .get_flags()
                    .contains(CGEventFlags::CGEventFlagSecondaryFn)
            {
                // Swallow the Fn+Space key event.
                event.set_type(CGEventType::Null);

                if matches!(etype, CGEventType::KeyDown) {
                    let mut st = match state_for_cb.lock() {
                        Ok(v) => v,
                        Err(_) => return None,
                    };

                    // Toggle start/stop.
                    if let Some((session_id, started_at)) = st.recording.take() {
                        if !st.hands_free_active {
                            // Not in hands-free recording; ignore toggle.
                            st.recording = Some((session_id, started_at));
                            return None;
                        }

                        st.hands_free_active = false;

                        let record_dur = Instant::now().saturating_duration_since(started_at);
                        if record_dur < min_record {
                            let _ = audio_cmd_tx.send(AudioCommand::Cancel);
                            set_voice_overlay_state(&app_for_cb, "hidden", None);
                            let _ = app_for_cb.emit(
                                VOICE_INPUT_EVENT_CANCEL,
                                VoiceInputCancelPayload {
                                    session_id: Some(session_id),
                                    reason: "录音时间过短，已忽略".to_string(),
                                },
                            );
                            if let Ok(mut d) = diagnostics_for_cb.lock() {
                                d.is_recording = false;
                                d.waiting_transcribe = false;
                                d.last_stop_at = Some(chrono::Local::now().to_rfc3339());
                            }
                            return None;
                        }

                        let (reply_tx, reply_rx) =
                            std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
                        if audio_cmd_tx.send(AudioCommand::Stop(reply_tx)).is_err() {
                            let msg = "音频线程已退出".to_string();
                            if let Ok(mut d) = diagnostics_for_cb.lock() {
                                d.is_recording = false;
                                d.waiting_transcribe = false;
                                d.last_error = Some(msg.clone());
                                d.last_stop_at = Some(chrono::Local::now().to_rfc3339());
                            }
                            set_voice_overlay_state(&app_for_cb, "error", Some(msg));
                            hide_voice_overlay_after(app_for_cb.clone(), 2400);
                            return None;
                        }

                        let audio_bytes = match reply_rx.recv_timeout(Duration::from_secs(2)) {
                            Ok(Ok(bytes)) => bytes,
                            Ok(Err(err)) => {
                                if let Ok(mut d) = diagnostics_for_cb.lock() {
                                    d.is_recording = false;
                                    d.waiting_transcribe = false;
                                    d.last_error = Some(err.clone());
                                    d.last_stop_at = Some(chrono::Local::now().to_rfc3339());
                                }
                                set_voice_overlay_state(&app_for_cb, "error", Some(err));
                                hide_voice_overlay_after(app_for_cb.clone(), 2400);
                                return None;
                            }
                            Err(_) => {
                                let msg = "停止录音超时".to_string();
                                if let Ok(mut d) = diagnostics_for_cb.lock() {
                                    d.is_recording = false;
                                    d.waiting_transcribe = false;
                                    d.last_error = Some(msg.clone());
                                    d.last_stop_at = Some(chrono::Local::now().to_rfc3339());
                                }
                                set_voice_overlay_state(&app_for_cb, "error", Some(msg));
                                hide_voice_overlay_after(app_for_cb.clone(), 2400);
                                return None;
                            }
                        };

                        skip_paste_for_cb.store(false, Ordering::SeqCst);
                        begin_transcribe_session(
                            app_for_cb.clone(),
                            Arc::clone(&diagnostics_for_cb),
                            Arc::clone(&transcribe_cancel_tx),
                            Arc::clone(&transcribe_session_id),
                            Arc::clone(&skip_paste_for_cb),
                            trigger_mode.to_string(),
                            session_id,
                            audio_bytes,
                            true,
                        );
                        return None;
                    }

                    // Start a new hands-free recording immediately.
                    let waiting = diagnostics_for_cb
                        .lock()
                        .ok()
                        .map(|d| d.waiting_transcribe)
                        .unwrap_or(false);
                    if waiting {
                        // Already transcribing; ignore toggle to avoid overlapping sessions.
                        return None;
                    }
                    st.pending_id = None;
                    st.hands_free_active = true;
                    let session_id = uuid::Uuid::new_v4().to_string();
                    let (reply_tx, reply_rx) = std::sync::mpsc::channel::<Result<(), String>>();
                    if audio_cmd_tx.send(AudioCommand::Start(reply_tx)).is_err() {
                        let msg = "音频线程已退出".to_string();
                        if let Ok(mut d) = diagnostics_for_cb.lock() {
                            d.last_error = Some(msg.clone());
                        }
                        set_voice_overlay_state(&app_for_cb, "error", Some(msg));
                        hide_voice_overlay_after(app_for_cb.clone(), 2400);
                        st.hands_free_active = false;
                        return None;
                    }

                    let started = reply_rx
                        .recv_timeout(Duration::from_secs(3))
                        .unwrap_or_else(|_| Err("启动录音超时".to_string()));
                    if let Err(err) = started {
                        if let Ok(mut d) = diagnostics_for_cb.lock() {
                            d.last_error = Some(err.clone());
                        }
                        set_voice_overlay_state(&app_for_cb, "error", Some(err));
                        hide_voice_overlay_after(app_for_cb.clone(), 2400);
                        st.hands_free_active = false;
                        return None;
                    }

                    st.recording = Some((session_id, Instant::now()));
                    set_voice_overlay_state(&app_for_cb, "recording", None);
                    if let Ok(mut d) = diagnostics_for_cb.lock() {
                        d.is_recording = true;
                        d.waiting_transcribe = false;
                        d.last_trigger_at = Some(chrono::Local::now().to_rfc3339());
                    }
                }

                return None;
            }

            if matches!(etype, CGEventType::KeyDown) && keycode == 53 {
                // Esc: cancel auto paste but keep the transcription in history.
                let mut recording_to_stop: Option<(String, Instant)> = None;
                if let Ok(mut st) = state_for_cb.lock() {
                    st.pending_id = None;
                    if let Some((sid, started_at)) = st.recording.take() {
                        st.hands_free_active = false;
                        recording_to_stop = Some((sid, started_at));
                    }
                }

                let waiting_transcribe = diagnostics_for_cb
                    .lock()
                    .ok()
                    .map(|d| d.waiting_transcribe)
                    .unwrap_or(false);

                // Swallow Esc only when it affects voice input.
                if recording_to_stop.is_some() || waiting_transcribe {
                    event.set_type(CGEventType::Null);
                }

                if let Some((session_id, started_at)) = recording_to_stop {
                    let record_dur = Instant::now().saturating_duration_since(started_at);
                    if record_dur < min_record {
                        let _ = audio_cmd_tx.send(AudioCommand::Cancel);
                        set_voice_overlay_state(&app_for_cb, "hidden", None);
                        if let Ok(mut d) = diagnostics_for_cb.lock() {
                            d.is_recording = false;
                            d.waiting_transcribe = false;
                            d.last_stop_at = Some(chrono::Local::now().to_rfc3339());
                        }
                        return None;
                    }

                    let (reply_tx, reply_rx) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
                    if audio_cmd_tx.send(AudioCommand::Stop(reply_tx)).is_err() {
                        let msg = "音频线程已退出".to_string();
                        if let Ok(mut d) = diagnostics_for_cb.lock() {
                            d.is_recording = false;
                            d.waiting_transcribe = false;
                            d.last_error = Some(msg.clone());
                            d.last_stop_at = Some(chrono::Local::now().to_rfc3339());
                        }
                        set_voice_overlay_state(&app_for_cb, "error", Some(msg));
                        hide_voice_overlay_after(app_for_cb.clone(), 2400);
                        return None;
                    }

                    let audio_bytes = match reply_rx.recv_timeout(Duration::from_secs(2)) {
                        Ok(Ok(bytes)) => bytes,
                        Ok(Err(err)) => {
                            if let Ok(mut d) = diagnostics_for_cb.lock() {
                                d.is_recording = false;
                                d.waiting_transcribe = false;
                                d.last_error = Some(err.clone());
                                d.last_stop_at = Some(chrono::Local::now().to_rfc3339());
                            }
                            set_voice_overlay_state(&app_for_cb, "error", Some(err));
                            hide_voice_overlay_after(app_for_cb.clone(), 2400);
                            return None;
                        }
                        Err(_) => {
                            let msg = "停止录音超时".to_string();
                            if let Ok(mut d) = diagnostics_for_cb.lock() {
                                d.is_recording = false;
                                d.waiting_transcribe = false;
                                d.last_error = Some(msg.clone());
                                d.last_stop_at = Some(chrono::Local::now().to_rfc3339());
                            }
                            set_voice_overlay_state(&app_for_cb, "error", Some(msg));
                            hide_voice_overlay_after(app_for_cb.clone(), 2400);
                            return None;
                        }
                    };

                    // Esc requests skip-paste.
                    skip_paste_for_cb.store(true, Ordering::SeqCst);
                    begin_transcribe_session(
                        app_for_cb.clone(),
                        Arc::clone(&diagnostics_for_cb),
                        Arc::clone(&transcribe_cancel_tx),
                        Arc::clone(&transcribe_session_id),
                        Arc::clone(&skip_paste_for_cb),
                        trigger_mode.to_string(),
                        session_id,
                        audio_bytes,
                        false,
                    );
                    return None;
                }

                if waiting_transcribe {
                    // Do not cancel the in-flight request; just skip the output/paste.
                    skip_paste_for_cb.store(true, Ordering::SeqCst);
                    set_voice_overlay_state(&app_for_cb, "hidden", None);
                }

                return None;
            }

            // Keep the tap alive if macOS disables it due to timeout/user input bursts.
            match etype {
                CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
                    let port = match tap_port_ref_cb.lock() {
                        Ok(g) => *g,
                        Err(_) => 0usize,
                    };
                    if port != 0 {
                        unsafe { CGEventTapEnable(port as _, true) };
                    }
                    return None;
                }
                CGEventType::FlagsChanged | CGEventType::KeyDown | CGEventType::KeyUp => {}
                _ => return None,
            }

    // Determine "trigger is down" state.
            //
            // Modifier keys commonly arrive as FlagsChanged. Fn on some keyboards may not emit
            // anything we can observe; that's why we keep raw_event_count for diagnosis.
            let flags = event.get_flags();
    let is_fn_keycode = matches!(keycode, 63 | 0 | 255);
    let is_alt_keycode = matches!(keycode, 58 | 61);
    let trigger_down_now = match (trigger_mode, etype) {
        ("option_hold", CGEventType::FlagsChanged) => flags.contains(CGEventFlags::CGEventFlagAlternate),
        ("option_hold", CGEventType::KeyDown) => is_alt_keycode,
        ("option_hold", CGEventType::KeyUp) => {
            if is_alt_keycode {
                false
            } else {
                return None;
            }
        }
        ("fn_option_hold", CGEventType::FlagsChanged) => {
            flags.contains(CGEventFlags::CGEventFlagSecondaryFn)
                && flags.contains(CGEventFlags::CGEventFlagAlternate)
        }
        ("fn_hold", CGEventType::FlagsChanged) => flags.contains(CGEventFlags::CGEventFlagSecondaryFn),
        // Some hardware/OS combinations may emit Fn as a keycode; keep a best-effort.
        ("fn_hold", CGEventType::KeyDown) => is_fn_keycode,
        ("fn_option_hold", CGEventType::KeyDown) => {
            is_fn_keycode && flags.contains(CGEventFlags::CGEventFlagAlternate)
        }
        ("fn_hold", CGEventType::KeyUp) => {
            if is_fn_keycode {
                false
            } else {
                        // Ignore non-Fn key ups to avoid spurious edges while typing.
                return None;
            }
        }
        ("fn_option_hold", CGEventType::KeyUp) => {
            if is_fn_keycode || is_alt_keycode {
                false
            } else {
                return None;
            }
        }
        _ => {
            // Ignore other keyboard events to avoid false edges.
            return None;
        }
    };

            let mut st = match state_for_cb.lock() {
                Ok(v) => v,
                Err(_) => return None,
            };

            if trigger_down_now == st.fn_down {
                return None;
            }

            st.fn_down = trigger_down_now;
            if let Ok(mut d) = diagnostics_for_cb.lock() {
                d.fn_is_down = trigger_down_now;
                d.fn_edge_count = d.fn_edge_count.saturating_add(1);
                d.last_fn_edge_at = Some(chrono::Local::now().to_rfc3339());
                d.last_error = None;
            }

            if trigger_down_now {
                // If we're currently transcribing, pressing the trigger again cancels the in-flight request.
                let waiting = diagnostics_for_cb
                    .lock()
                    .ok()
                    .map(|d| d.waiting_transcribe)
                    .unwrap_or(false);
                if waiting {
                    if let Ok(mut slot) = transcribe_cancel_tx.lock() {
                        if let Some(tx) = slot.take() {
                            let _ = tx.send(());
                        }
                    }
                    let sid = transcribe_session_id
                        .lock()
                        .ok()
                        .and_then(|v| v.clone());
                    if let Ok(mut id) = transcribe_session_id.lock() {
                        *id = None;
                    }
                    if let Ok(mut d) = diagnostics_for_cb.lock() {
                        d.waiting_transcribe = false;
                    }
                    set_voice_overlay_state(&app_for_cb, "error", Some("已取消".to_string()));
                    hide_voice_overlay_after(app_for_cb.clone(), 700);
                    let _ = app_for_cb.emit(
                        VOICE_INPUT_EVENT_CANCEL,
                        VoiceInputCancelPayload {
                            session_id: sid.clone(),
                            reason: "已取消转写".to_string(),
                        },
                    );
                    return None;
                }

                // Pressed: start hold timer.
                let pending_id = uuid::Uuid::new_v4().to_string();
                st.pending_id = Some(pending_id.clone());
                if let Ok(mut d) = diagnostics_for_cb.lock() {
                    d.last_trigger_at = Some(chrono::Local::now().to_rfc3339());
                }

                let app_t = app_for_cb.clone();
                let state_t = Arc::clone(&state_for_cb);
                let running_t = Arc::clone(&running_for_cb);
                let diagnostics_t = Arc::clone(&diagnostics_for_cb);
                let audio_cmd_tx_t = audio_cmd_tx.clone();
                thread::spawn(move || {
                    thread::sleep(hold_threshold);
                    if !running_t.load(Ordering::SeqCst) {
                        return;
                    }
                    let mut st = match state_t.lock() {
                        Ok(v) => v,
                        Err(_) => return,
                    };
                    if !st.fn_down {
                        return;
                    }
                    if st.recording.is_some() {
                        return;
                    }
                    if st.pending_id.as_deref() != Some(pending_id.as_str()) {
                        return;
                    }

                    let session_id = pending_id;
                    let (reply_tx, reply_rx) = std::sync::mpsc::channel::<Result<(), String>>();
                    if audio_cmd_tx_t.send(AudioCommand::Start(reply_tx)).is_err() {
                        let msg = "音频线程已退出".to_string();
                        if let Ok(mut d) = diagnostics_t.lock() {
                            d.last_error = Some(msg.clone());
                        }
                        set_voice_overlay_state(&app_t, "error", Some(msg));
                        hide_voice_overlay_after(app_t.clone(), 2400);
                        return;
                    }

                    let started = reply_rx
                        .recv_timeout(Duration::from_secs(3))
                        .unwrap_or_else(|_| Err("启动录音超时".to_string()));
                    if let Err(err) = started {
                        if let Ok(mut d) = diagnostics_t.lock() {
                            d.last_error = Some(err.clone());
                        }
                        set_voice_overlay_state(&app_t, "error", Some(err));
                        hide_voice_overlay_after(app_t.clone(), 2400);
                        return;
                    }

                    st.pending_id = None;
                    st.recording = Some((session_id.clone(), Instant::now()));
                    st.hands_free_active = false;
                    set_voice_overlay_state(&app_t, "recording", None);
                    if let Ok(mut d) = diagnostics_t.lock() {
                        d.is_recording = true;
                        d.waiting_transcribe = false;
                    }
                });
            } else {
                // Released: cancel pending or stop recording.
                st.pending_id = None;
                if st.hands_free_active {
                    // Hands-free mode keeps recording after Fn is released.
                    return None;
                }
                if let Some((session_id, started_at)) = st.recording.take() {
                    let record_dur = Instant::now().saturating_duration_since(started_at);
                    if record_dur < min_record {
                        let _ = audio_cmd_tx.send(AudioCommand::Cancel);
                        set_voice_overlay_state(&app_for_cb, "hidden", None);
                        let _ = app_for_cb.emit(
                            VOICE_INPUT_EVENT_CANCEL,
                            VoiceInputCancelPayload {
                                session_id: Some(session_id),
                                reason: "录音时间过短，已忽略".to_string(),
                            },
                        );
                        if let Ok(mut d) = diagnostics_for_cb.lock() {
                            d.is_recording = false;
                            d.waiting_transcribe = false;
                            d.last_stop_at = Some(chrono::Local::now().to_rfc3339());
                        }
                    } else {
                        let (reply_tx, reply_rx) =
                            std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
                        if audio_cmd_tx.send(AudioCommand::Stop(reply_tx)).is_err() {
                            let msg = "音频线程已退出".to_string();
                            if let Ok(mut d) = diagnostics_for_cb.lock() {
                                d.is_recording = false;
                                d.waiting_transcribe = false;
                                d.last_error = Some(msg.clone());
                                d.last_stop_at = Some(chrono::Local::now().to_rfc3339());
                            }
                            set_voice_overlay_state(&app_for_cb, "error", Some(msg));
                            hide_voice_overlay_after(app_for_cb.clone(), 2400);
                            return None;
                        }

                        let audio_bytes = match reply_rx.recv_timeout(Duration::from_secs(2)) {
                            Ok(Ok(bytes)) => bytes,
                            Ok(Err(err)) => {
                                if let Ok(mut d) = diagnostics_for_cb.lock() {
                                    d.is_recording = false;
                                    d.waiting_transcribe = false;
                                    d.last_error = Some(err.clone());
                                    d.last_stop_at = Some(chrono::Local::now().to_rfc3339());
                                }
                                set_voice_overlay_state(&app_for_cb, "error", Some(err));
                                hide_voice_overlay_after(app_for_cb.clone(), 2400);
                                return None;
                            }
                            Err(_) => {
                                let msg = "停止录音超时".to_string();
                                if let Ok(mut d) = diagnostics_for_cb.lock() {
                                    d.is_recording = false;
                                    d.waiting_transcribe = false;
                                    d.last_error = Some(msg.clone());
                                    d.last_stop_at = Some(chrono::Local::now().to_rfc3339());
                                }
                                set_voice_overlay_state(&app_for_cb, "error", Some(msg));
                                hide_voice_overlay_after(app_for_cb.clone(), 2400);
                                return None;
                            }
                        };

                        // Normal path: auto paste is enabled unless user pressed Esc during transcription.
                        skip_paste_for_cb.store(false, Ordering::SeqCst);
                        begin_transcribe_session(
                            app_for_cb.clone(),
                            Arc::clone(&diagnostics_for_cb),
                            Arc::clone(&transcribe_cancel_tx),
                            Arc::clone(&transcribe_session_id),
                            Arc::clone(&skip_paste_for_cb),
                            trigger_mode.to_string(),
                            session_id,
                            audio_bytes,
                            true,
                        );
                    }
                }
            }

            None
        },
    )
    .map_err(|_| {
        "Failed to create keyboard event tap. Permission not granted.\n请确认：系统设置 -> 隐私与安全性 -> 输入监控 / 辅助功能 已允许当前运行的 MyKey.app。"
            .to_string()
    })?;

    unsafe {
        // Publish the port ref for re-enable in callback.
        if let Ok(mut slot) = tap_port_ref.lock() {
            *slot = tap.mach_port.as_concrete_TypeRef() as usize;
        }

        let run_loop = CFRunLoop::get_current();
        let loop_source = tap
            .mach_port
            .create_runloop_source(0)
            .map_err(|_| "Failed to create event tap runloop source".to_string())?;
        run_loop.add_source(&loop_source, kCFRunLoopCommonModes);
        tap.enable();

        while running.load(Ordering::SeqCst) {
            // Pump the runloop in small intervals so we can stop cleanly.
            let _ = CFRunLoop::run_in_mode(kCFRunLoopDefaultMode, Duration::from_millis(120), true);
        }

        run_loop.remove_source(&loop_source, kCFRunLoopCommonModes);
    }

    if let Ok(mut d) = diagnostics.lock() {
        d.listener_running = false;
        d.fn_is_down = false;
        d.is_recording = false;
        d.waiting_transcribe = false;
    }
    set_voice_overlay_state(&app, "hidden", None);
    Ok(())
}
