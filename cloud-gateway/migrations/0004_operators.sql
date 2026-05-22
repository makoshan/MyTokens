-- Multi-tenant P0a: operator identities + sessions.
-- An operator's identity is an EVM keypair held by the native app; the gateway
-- stores only the public address. Operators authenticate by EIP-191 signature
-- and get a session. (operator_id scoping of provider tokens / accounts /
-- routing lands in a follow-up migration; this one only adds the identity layer.)

CREATE TABLE IF NOT EXISTS compute_operators (
  id TEXT PRIMARY KEY,
  pubkey_address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS compute_operator_sessions (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  session_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (operator_id) REFERENCES compute_operators(id)
);

CREATE INDEX IF NOT EXISTS idx_operator_sessions_hash ON compute_operator_sessions(session_hash);
