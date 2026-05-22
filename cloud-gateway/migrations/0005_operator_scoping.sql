-- Multi-tenant P0b: scope provider tokens / friend accounts / routing rules to
-- an operator. A friend's relay only ever uses its operator's tokens & rules.

ALTER TABLE compute_provider_tokens ADD COLUMN operator_id TEXT;
ALTER TABLE compute_accounts ADD COLUMN operator_id TEXT;
ALTER TABLE compute_routing_rules ADD COLUMN operator_id TEXT;

-- Backfill all existing single-tenant data into one bucket so it stays grouped
-- (and does NOT cross-leak to future operators' tokens). The platform owner's
-- current data becomes 'op_default'. When the native app registers its operator
-- identity, point it at 'op_default' (or reassign) so it owns this data.
UPDATE compute_provider_tokens SET operator_id = 'op_default' WHERE operator_id IS NULL;
UPDATE compute_accounts SET operator_id = 'op_default' WHERE operator_id IS NULL;
UPDATE compute_routing_rules SET operator_id = 'op_default' WHERE operator_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_provider_tokens_operator ON compute_provider_tokens(operator_id);
CREATE INDEX IF NOT EXISTS idx_accounts_operator ON compute_accounts(operator_id);
CREATE INDEX IF NOT EXISTS idx_routing_rules_operator ON compute_routing_rules(operator_id);
