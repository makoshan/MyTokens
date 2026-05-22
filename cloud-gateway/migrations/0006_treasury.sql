-- Per-operator treasury ledger.
--
-- The relayer EOA is a single shared hot wallet: every operator's friends pay
-- their MYC purchases (USDC) into it. So the relayer's raw on-chain USDC balance
-- is the SUM across all operators and must never be withdrawn wholesale by any
-- one of them. These two tables attribute income per operator so a withdrawal is
-- capped at exactly that operator's own (credited - withdrawn) share.

-- Income in: one row per successful buy-myc, attributing the USDC paid into the
-- relayer to the operator that owns the buyer's account. Unique on the on-chain
-- payment tx so a retried/replayed request can never double-credit.
CREATE TABLE IF NOT EXISTS compute_treasury_credits (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  account_id TEXT,
  amount_micro_usd INTEGER NOT NULL,
  stablecoin_tx_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_treasury_credits_tx
  ON compute_treasury_credits(stablecoin_tx_hash);
CREATE INDEX IF NOT EXISTS idx_treasury_credits_operator
  ON compute_treasury_credits(operator_id, created_at);

-- Income out: one row per successful withdrawal of USDC from the relayer to an
-- operator's own wallet.
CREATE TABLE IF NOT EXISTS compute_treasury_withdrawals (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  amount_micro_usd INTEGER NOT NULL,
  to_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_treasury_withdrawals_operator
  ON compute_treasury_withdrawals(operator_id, created_at);
