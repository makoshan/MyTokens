CREATE TABLE IF NOT EXISTS compute_provider_tokens (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  adapter TEXT NOT NULL,
  base_url TEXT,
  models_json TEXT,
  status TEXT NOT NULL,
  scope_json TEXT,
  secret_ref TEXT,
  ciphertext TEXT,
  nonce TEXT,
  key_version TEXT,
  derivation_fingerprint TEXT,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  exhausted_until TEXT,
  last_error TEXT,
  last_response_ms INTEGER,
  last_used_at TEXT,
  rotated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compute_provider_tokens_provider ON compute_provider_tokens(provider);
CREATE INDEX IF NOT EXISTS idx_compute_provider_tokens_status ON compute_provider_tokens(status);
CREATE INDEX IF NOT EXISTS idx_compute_provider_tokens_exhausted ON compute_provider_tokens(exhausted_until);

CREATE TABLE IF NOT EXISTS compute_accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  owner_wallet TEXT,
  status TEXT NOT NULL,
  account_group TEXT NOT NULL DEFAULT 'default',
  default_provider TEXT NOT NULL,
  default_model TEXT,
  daily_budget_micro_usd INTEGER,
  rpm_limit INTEGER,
  tpm_limit INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS compute_api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT,
  key_prefix TEXT NOT NULL,
  key_last4 TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'compat_api',
  derivation_mode TEXT NOT NULL DEFAULT 'random',
  derivation_fingerprint TEXT,
  derivation_index INTEGER,
  ip_allowlist_json TEXT,
  model_allowlist_json TEXT,
  rpm_limit INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY(account_id) REFERENCES compute_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_compute_api_keys_hash ON compute_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_compute_api_keys_account ON compute_api_keys(account_id);

CREATE TABLE IF NOT EXISTS compute_account_invites (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  invite_token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES compute_accounts(id)
);

CREATE TABLE IF NOT EXISTS compute_dashboard_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  session_hash TEXT NOT NULL UNIQUE,
  auth_method TEXT NOT NULL,
  passkey_credential_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY(account_id) REFERENCES compute_accounts(id)
);

CREATE TABLE IF NOT EXISTS compute_credit_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  requested_micro_usd INTEGER NOT NULL,
  message TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  FOREIGN KEY(account_id) REFERENCES compute_accounts(id)
);

CREATE TABLE IF NOT EXISTS compute_price_book (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream_input_micro_usd_per_1m_tokens INTEGER NOT NULL,
  upstream_output_micro_usd_per_1m_tokens INTEGER NOT NULL,
  sell_input_micro_usd_per_1m_tokens INTEGER NOT NULL,
  sell_output_micro_usd_per_1m_tokens INTEGER NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, model, version)
);

CREATE TABLE IF NOT EXISTS compute_routing_rules (
  id TEXT PRIMARY KEY,
  account_group TEXT NOT NULL DEFAULT 'default',
  requested_provider TEXT,
  requested_model TEXT NOT NULL,
  provider_token_id TEXT NOT NULL,
  actual_provider_model TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  model_mapping_json TEXT,
  quality_label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(provider_token_id) REFERENCES compute_provider_tokens(id)
);

CREATE INDEX IF NOT EXISTS idx_compute_routing_rules_group_model ON compute_routing_rules(account_group, requested_model, status);
CREATE INDEX IF NOT EXISTS idx_compute_routing_rules_provider_token ON compute_routing_rules(provider_token_id);

CREATE TABLE IF NOT EXISTS compute_model_allowlist (
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, provider, model),
  FOREIGN KEY(account_id) REFERENCES compute_accounts(id)
);

CREATE TABLE IF NOT EXISTS compute_ledger_entries (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount_micro_usd INTEGER NOT NULL,
  balance_after_micro_usd INTEGER,
  provider TEXT,
  model TEXT,
  request_id TEXT,
  reservation_id TEXT,
  chain_id INTEGER,
  tx_hash TEXT,
  log_index INTEGER,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES compute_accounts(id)
);

CREATE TABLE IF NOT EXISTS compute_request_logs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  api_key_id TEXT,
  provider_token_id TEXT,
  routing_rule_id TEXT,
  created_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  endpoint TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  billable_unit TEXT,
  billable_units INTEGER,
  sell_cost_micro_usd INTEGER,
  upstream_cost_micro_usd INTEGER,
  blocked_reason TEXT,
  error_code TEXT,
  request_hash TEXT,
  FOREIGN KEY(account_id) REFERENCES compute_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_compute_logs_account_created ON compute_request_logs(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_compute_logs_provider_model ON compute_request_logs(provider, model);
CREATE INDEX IF NOT EXISTS idx_compute_logs_route ON compute_request_logs(provider_token_id, routing_rule_id);

CREATE TABLE IF NOT EXISTS compute_admin_audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
