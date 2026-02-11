export interface ProviderEndpoint {
  id: string
  provider: string
  base_url: string
  headers?: string | null
  timeout_ms?: number | null
  proxy_url?: string | null
  is_primary: boolean
  created_at: string
  updated_at: string
}

export interface ProviderEnvVar {
  id: string
  provider: string
  key: string
  value: string
  is_secret: boolean
  created_at: string
  updated_at: string
}

export interface ProviderAppBinding {
  id: string
  provider: string
  app_type: string
  config_path: string
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface ProviderConfig {
  provider: string
  label: string
  api_key: string
  base_url: string
  updated_at: string
  is_active: boolean
  models: string[]
  endpoints: ProviderEndpoint[]
  env_vars: ProviderEnvVar[]
  app_bindings: ProviderAppBinding[]
}
