-- compat: expand
-- BIL-1.5A.1: immutable audit receipt for privileged, idempotent ERA recovery decisions.
CREATE TABLE claimmd_era_recovery_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id uuid NOT NULL UNIQUE,
  inbox_id uuid NOT NULL REFERENCES claimmd_era_inbox(id) ON DELETE RESTRICT,
  account_reference text NOT NULL CHECK (account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  era_id text NOT NULL CHECK (era_id ~ '^[0-9]{1,64}$'),
  stage text NOT NULL CHECK (stage IN ('capture','ownership_resolution','m25_delivery')),
  actor_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  expected_state text NOT NULL CHECK (length(expected_state) BETWEEN 1 AND 64),
  resulting_state text NOT NULL CHECK (length(resulting_state) BETWEEN 1 AND 64),
  previous_retry_count integer NOT NULL CHECK (previous_retry_count >= 0),
  new_retry_eligibility boolean NOT NULL,
  resolution_version integer CHECK (resolution_version IS NULL OR resolution_version > 0),
  delivery_id uuid,
  delivery_attempt_count integer CHECK (delivery_attempt_count IS NULL OR delivery_attempt_count >= 0),
  outcome text NOT NULL CHECK (outcome IN ('requeued','reconciled','rejected')),
  safe_failure_code text CHECK (safe_failure_code IS NULL OR safe_failure_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX claimmd_era_recovery_action_inbox_ix ON claimmd_era_recovery_action(inbox_id, created_at);--> statement-breakpoint
ALTER TABLE claimmd_era_recovery_action ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_era_recovery_action FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_era_recovery_action_capture ON claimmd_era_recovery_action FOR ALL TO claimmd_capture USING(true) WITH CHECK(true);--> statement-breakpoint
GRANT SELECT,INSERT ON claimmd_era_recovery_action TO claimmd_capture;
