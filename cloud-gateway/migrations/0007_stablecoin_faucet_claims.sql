-- Test stablecoin faucet claims.
--
-- One dashboard account may receive the Sepolia test-USDT grant exactly once.
-- The unique account_id guard keeps retries, multiple devices, and concurrent
-- requests from minting more than one faucet grant.

CREATE TABLE IF NOT EXISTS compute_stablecoin_faucet_claims (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  tx_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stablecoin_faucet_claims_account
  ON compute_stablecoin_faucet_claims(account_id);
