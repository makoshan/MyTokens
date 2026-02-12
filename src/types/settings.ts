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
}

export interface GatewayTrafficGroup {
  key: string
  requests: number
  success_requests: number
  error_requests: number
  blocked_requests: number
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
  by_app: GatewayTrafficGroup[]
  by_provider: GatewayTrafficGroup[]
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
  automation_granted: boolean
  selection_capture_ready: boolean
  automation_error?: string | null
  guidance: string
}
