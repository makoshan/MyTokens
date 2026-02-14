use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const VOICE_INPUT_EVENT_START: &str = "voice_input_start";
pub const VOICE_INPUT_EVENT_STOP: &str = "voice_input_stop";
pub const VOICE_INPUT_EVENT_CANCEL: &str = "voice_input_cancel";

pub const VOICE_OVERLAY_EVENT: &str = "voice_overlay_update";
const VOICE_OVERLAY_WINDOW_LABEL: &str = "voice-overlay";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VoiceOverlayPayload {
    pub state: String, // hidden | recording | transcribing | done | error
    pub text: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VoiceInputSettings {
    pub voice_input_enabled: bool,
    pub voice_trigger_mode: String, // "fn_hold"
    pub voice_hold_ms: i64,
    pub voice_min_record_ms: i64,
    pub voice_stt_provider: String,
    pub voice_stt_model: String,
    pub voice_language: String, // "auto" or BCP-47
    pub voice_auto_paste: bool,
    pub voice_paste_delay_ms: i64,
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
            voice_stt_provider: "openai".to_string(),
            voice_stt_model: "whisper-1".to_string(),
            voice_language: "auto".to_string(),
            voice_auto_paste: true,
            voice_paste_delay_ms: 120,
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
            self.voice_stt_provider = "openai".to_string();
        }
        if self.voice_stt_model.trim().is_empty() {
            self.voice_stt_model = "whisper-1".to_string();
        }
        if self.voice_language.trim().is_empty() {
            self.voice_language = "auto".to_string();
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
        self.start_hold_listener(app, "fn_hold".to_string(), hold_threshold_ms, min_record_ms)
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
fn modifier_hold_loop(
    app: AppHandle,
    running: Arc<AtomicBool>,
    diagnostics: Arc<Mutex<VoiceInputDiagnostics>>,
    transcribe_cancel_tx: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    transcribe_session_id: Arc<Mutex<Option<String>>>,
    trigger_mode: String,
    hold_threshold_ms: i64,
    min_record_ms: i64,
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
    }

    // Exposed by CoreGraphics. This is what macOS uses for "Input Monitoring" preflight.
    // We don't hard-fail here; we use it to pick a more reliable tap location.
    extern "C" {
        fn CGPreflightListenEventAccess() -> bool;
    }

    let hold_threshold = Duration::from_millis(hold_threshold_ms.max(0) as u64);
    let min_record = Duration::from_millis(min_record_ms.max(0) as u64);
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
    }));

    let app_for_cb = app.clone();
    let state_for_cb = Arc::clone(&state);
    let running_for_cb = Arc::clone(&running);
    let diagnostics_for_cb = Arc::clone(&diagnostics);

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
        CGEventTapOptions::ListenOnly,
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

            // Allow cancel while transcribing: press Esc.
            // Note: we use ListenOnly so Esc still reaches the focused app. This just cancels our request.
            if matches!(etype, CGEventType::KeyDown) && keycode == 53 {
                let should_cancel = diagnostics_for_cb
                    .lock()
                    .ok()
                    .map(|d| d.waiting_transcribe)
                    .unwrap_or(false);
                if should_cancel {
                    // Cancel in-flight transcribe (if any) and notify frontend.
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
    let trigger_down_now = match (trigger_mode.as_str(), etype) {
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
                    st.pending_id = None;
                    st.recording = Some((session_id.clone(), Instant::now()));
                    set_voice_overlay_state(&app_t, "recording", None);
                    let _ = app_t.emit(VOICE_INPUT_EVENT_START, VoiceInputStartPayload { session_id });
                    if let Ok(mut d) = diagnostics_t.lock() {
                        d.is_recording = true;
                        d.waiting_transcribe = false;
                    }
                });
            } else {
                // Released: cancel pending or stop recording.
                st.pending_id = None;
                if let Some((session_id, started_at)) = st.recording.take() {
                    let record_dur = Instant::now().saturating_duration_since(started_at);
                    if record_dur < min_record {
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
                        set_voice_overlay_state(&app_for_cb, "transcribing", None);
                        let _ = app_for_cb.emit(VOICE_INPUT_EVENT_STOP, VoiceInputStopPayload { session_id });
                        if let Ok(mut d) = diagnostics_for_cb.lock() {
                            d.is_recording = false;
                            d.waiting_transcribe = true;
                            d.last_stop_at = Some(chrono::Local::now().to_rfc3339());
                        }
                    }
                }
            }

            None
        },
    )
    .map_err(|_| {
        "Failed to create Fn event tap (FlagsChanged). Accessibility permission not granted, or the app is not trusted.\n请确认：系统设置 -> 隐私与安全性 -> 辅助功能 已允许当前运行的 MyKey.app。"
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
