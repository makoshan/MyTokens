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

export interface ProviderEndpointInput {
  id?: string
  base_url: string
  headers?: string | null
  timeout_ms?: number | null
  proxy_url?: string | null
  is_primary: boolean
}

export interface ProviderEnvVarInput {
  id?: string
  key: string
  value: string
  is_secret: boolean
}

export interface ProviderAppBindingInput {
  id?: string
  app_type: string
  config_path: string
  enabled: boolean
}

export interface ProviderDetails {
  website_url: string
  notes: string
  main_model: string
  reasoning_model: string
  default_haiku_model: string
  default_sonnet_model: string
  default_opus_model: string
  settings_json: string
  use_common_config: boolean
  test_config_enabled: boolean
  test_model: string
  test_timeout_secs?: number | null
  test_prompt: string
  test_degraded_threshold_ms?: number | null
  test_max_retries?: number | null
  proxy_config_enabled: boolean
  proxy_url: string
  proxy_username: string
  proxy_password: string
}

export const DEFAULT_PROVIDER_DETAILS: ProviderDetails = {
  website_url: '',
  notes: '',
  main_model: '',
  reasoning_model: '',
  default_haiku_model: '',
  default_sonnet_model: '',
  default_opus_model: '',
  settings_json: '{\n  "env": {},\n  "includeCoAuthoredBy": false\n}',
  use_common_config: false,
  test_config_enabled: false,
  test_model: '',
  test_timeout_secs: null,
  test_prompt: '',
  test_degraded_threshold_ms: null,
  test_max_retries: null,
  proxy_config_enabled: false,
  proxy_url: '',
  proxy_username: '',
  proxy_password: '',
}

export interface ProviderConfig {
  provider: string
  label: string
  api_key: string
  base_url: string
  updated_at: string
  is_active: boolean
  models: string[]
  details?: ProviderDetails
  endpoints: ProviderEndpoint[]
  env_vars: ProviderEnvVar[]
  app_bindings: ProviderAppBinding[]
}
