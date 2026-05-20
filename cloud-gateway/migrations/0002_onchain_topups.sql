-- On-chain top-ups: a buyer pays a TIP-20 token (MYC / USDC.e) to the operator
-- recipient address on Tempo, then submits the tx hash. The gateway verifies the
-- transfer on-chain and credits balance. This table is the replay guard: each
-- (chain_id, tx_hash, log_index) can only ever credit once.
CREATE TABLE IF NOT EXISTS compute_onchain_topups (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  token_address TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  credited_micro_usd INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES compute_accounts(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_compute_topups_unique
  ON compute_onchain_topups(chain_id, tx_hash, log_index);
CREATE INDEX IF NOT EXISTS idx_compute_topups_account
  ON compute_onchain_topups(account_id, created_at);
