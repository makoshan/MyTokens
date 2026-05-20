-- Red packets: operator pre-creates a packet (amount of MYC) with a claim code.
-- A friend redeems the code → relayer transfers MYC from its pool to the
-- friend's wallet. code_hash = sha-256 of the raw code (raw code never stored).
CREATE TABLE IF NOT EXISTS compute_redpackets (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  amount_raw TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'unclaimed',
  claimed_by_account TEXT,
  claimed_to_address TEXT,
  claim_tx_hash TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_compute_redpackets_status ON compute_redpackets(status, created_at);
