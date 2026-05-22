export interface AppIntegration {
  id: string
  app_type: string
  detected: boolean
  enabled: boolean
  config_path?: string | null
  updated_at: string
}

export interface ServiceConfig {
  service_name: string
  enabled: boolean
  auto_start: boolean
  port?: number | null
  running: boolean
  health: string
  updated_at: string
}

export interface GlobalSettingsPayload {
  debug_mode: boolean
  log_level: string
  integrations: AppIntegration[]
  services: ServiceConfig[]
  database_path: string
  logs_path: string
  last_backup_at?: string | null
}

export interface GatewayPolicySettings {
  circuit_breaker_enabled: boolean
  daily_budget_usd?: number | null
  today_request_count: number
  today_cost_usd: number
}

export interface GatewayRequestLog {
  id: string
  created_at: string
  app_type: string
  provider: string
  model?: string | null
  endpoint: string
  status_code: number
  latency_ms: number
  blocked_reason?: string | null
  error_code?: string | null
  estimated_cost_usd?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
  total_tokens?: number | null
  user_key?: string | null
}

export interface GatewayTrafficGroup {
  key: string
  requests: number
  success_requests: number
  error_requests: number
  blocked_requests: number
  estimated_cost_usd?: number
  total_input_tokens?: number
  total_output_tokens?: number
  total_tokens?: number
  avg_latency_ms?: number | null
  p95_latency_ms?: number | null
}

export interface GatewayErrorSummary {
  code: string
  requests: number
}

export interface GatewayTrafficPoint {
  minute: string
  requests: number
  error_requests: number
  total_tokens?: number
  avg_latency_ms?: number | null
}

export interface GatewayTrafficMetrics {
  window_minutes: number
  total_requests: number
  success_requests: number
  client_error_requests: number
  server_error_requests: number
  blocked_requests: number
  requests_per_minute: number
  avg_latency_ms?: number | null
  p95_latency_ms?: number | null
  estimated_cost_usd: number
  total_input_tokens?: number
  total_output_tokens?: number
  total_tokens?: number
  by_app: GatewayTrafficGroup[]
  by_provider: GatewayTrafficGroup[]
  by_model: GatewayTrafficGroup[]
  by_user: GatewayTrafficGroup[]
  top_errors: GatewayErrorSummary[]
  timeline: GatewayTrafficPoint[]
}

export interface QuickActionSettings {
  translate_hotkey: string
  ocr_hotkey: string
  default_translate_provider: string
  default_ocr_provider: string
  source_lang: string
  target_lang: string
  auto_close_seconds: number
  updated_at: string
}

export interface QuickProviderOption {
  provider: string
  label: string
}

export interface QuickProviderOptions {
  translate: QuickProviderOption[]
  ocr: QuickProviderOption[]
}

export interface QuickActionResult {
  action_type: string
  source_text?: string | null
  ocr_text?: string | null
  result_text?: string | null
  provider: string
  translate_provider?: string | null
  ocr_provider?: string | null
  latency_ms: number
  status: string
  error_code?: string | null
  error_message?: string | null
  created_at: string
}

export interface QuickActionHistoryRecord {
  id: string
  action_type: string
  source_text?: string | null
  ocr_text?: string | null
  result_text?: string | null
  provider: string
  latency_ms: number
  status: string
  error_code?: string | null
  created_at: string
}

export interface QuickHotkeyDiagnostics {
  translate_hotkey: string
  ocr_hotkey: string
  translate_registered: boolean
  ocr_registered: boolean
  translate_parse_error?: string | null
  ocr_parse_error?: string | null
  last_trigger_shortcut?: string | null
  last_trigger_at?: string | null
  last_register_at?: string | null
  last_register_error?: string | null
}

export interface MacosPermissionStatus {
  is_macos: boolean
  accessibility_granted: boolean
  input_monitoring_granted: boolean
  automation_granted: boolean
  selection_capture_ready: boolean
  process_name?: string | null
  executable_path?: string | null
  automation_error?: string | null
  guidance: string
}

export interface VoiceInputSettings {
  voice_input_enabled: boolean
  voice_trigger_mode: string
  voice_hold_ms: number
  voice_min_record_ms: number
  voice_hands_free_enabled: boolean
  voice_stt_provider: string
  voice_stt_model: string
  voice_language: string
  voice_ai_auto_edit: boolean
  voice_ai_model: string
  voice_auto_paste: boolean
  voice_paste_delay_ms: number
  voice_restore_clipboard: boolean
  voice_append_trailing_space: boolean
  updated_at: string
}

export interface VoiceInputDiagnostics {
  listener_running: boolean
  fn_is_down: boolean
  fn_edge_count?: number | null
  last_fn_edge_at?: string | null
  raw_event_count?: number | null
  last_raw_event_at?: string | null
  last_raw_event_type?: string | null
  last_raw_keycode?: number | null
  tap_location?: string | null
  is_recording: boolean
  waiting_transcribe: boolean
  last_trigger_at?: string | null
  last_stop_at?: string | null
  last_latency_ms?: number | null
  last_error?: string | null
}

export interface VoiceInputTranscribeResult {
  text: string
  provider: string
  model: string
  pasted: boolean
  latency_ms: number
  error?: string | null
}

export interface VoiceInputHistoryRecord {
  id: string
  session_id?: string | null
  trigger_mode: string
  raw_text?: string | null
  final_text?: string | null
  provider?: string | null
  model?: string | null
  language?: string | null
  latency_ms?: number | null
  pasted: boolean
  cancelled: boolean
  error?: string | null
  created_at: string
}

export interface RecentDebugLogs {
  path: string
  lines: string[]
}
