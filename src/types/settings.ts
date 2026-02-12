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
