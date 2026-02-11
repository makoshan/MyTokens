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
