-- compat: contract
-- BIL-1.4.1B: recoverable, source-scoped delivery receipt plus protected non-posting M25 stage details.
ALTER TABLE claimmd_era_m25_stage ADD COLUMN source_file_digest text CHECK (source_file_digest IS NULL OR source_file_digest ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE claimmd_era_m25_stage ADD COLUMN resolution_id uuid;--> statement-breakpoint
ALTER TABLE claimmd_era_m25_stage ADD COLUMN resolution_version integer CHECK (resolution_version IS NULL OR resolution_version > 0);--> statement-breakpoint
ALTER TABLE claimmd_era_m25_stage ADD COLUMN idempotency_key text CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE claimmd_era_m25_stage ADD COLUMN protected_details_cipher text;--> statement-breakpoint
ALTER TABLE claimmd_era_m25_stage ADD COLUMN protected_details_key_id text;--> statement-breakpoint
ALTER TABLE claimmd_era_m25_stage ADD COLUMN content_digest text CHECK (content_digest IS NULL OR content_digest ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE claimmd_era_m25_stage ADD COLUMN payment_trace_digest text CHECK (payment_trace_digest IS NULL OR payment_trace_digest ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE claimmd_era_m25_stage ADD CONSTRAINT claimmd_era_m25_stage_delivery_key_uq UNIQUE(idempotency_key);--> statement-breakpoint

CREATE TABLE claimmd_era_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL REFERENCES claimmd_era_inbox(id) ON DELETE RESTRICT,
  resolution_id uuid NOT NULL REFERENCES claimmd_era_resolution(id) ON DELETE RESTRICT,
  resolution_version integer NOT NULL CHECK (resolution_version > 0),
  vendor text NOT NULL DEFAULT 'claimmd' CHECK (vendor='claimmd'),
  account_reference text NOT NULL CHECK (account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  era_id text NOT NULL CHECK (era_id ~ '^[0-9]{1,64}$'),
  original_835_digest text NOT NULL CHECK (original_835_digest ~ '^[0-9a-f]{64}$'),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  location_id uuid,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('prepared','delivered','possible_duplicate','exact_duplicate','held')),
  tenant_finalized boolean NOT NULL DEFAULT false,
  stage_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  existing_advice_id uuid,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  safe_error_code text CHECK (safe_error_code IS NULL OR safe_error_code ~ '^[A-Z_]{1,64}$'),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_era_delivery_account_era_uq UNIQUE(vendor,account_reference,usage,era_id),
  CONSTRAINT claimmd_era_delivery_inbox_uq UNIQUE(inbox_id),
  CONSTRAINT claimmd_era_delivery_key_uq UNIQUE(idempotency_key)
);--> statement-breakpoint
CREATE INDEX claimmd_era_delivery_pending_ix ON claimmd_era_delivery(state,updated_at);--> statement-breakpoint
CREATE TABLE claimmd_era_delivery_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES claimmd_era_delivery(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('prepared','delivered','possible_duplicate','exact_duplicate','held')),
  safe_reason_code text CHECK (safe_reason_code IS NULL OR safe_reason_code ~ '^[A-Z_]{1,64}$'),
  attempt_count integer NOT NULL CHECK (attempt_count >= 0),
  stage_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX claimmd_era_delivery_history_ix ON claimmd_era_delivery_history(delivery_id,created_at);--> statement-breakpoint
ALTER TABLE claimmd_era_delivery ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_era_delivery FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_era_delivery_capture ON claimmd_era_delivery FOR ALL TO claimmd_capture USING(true) WITH CHECK(true);--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON claimmd_era_delivery TO claimmd_capture;
--> statement-breakpoint
ALTER TABLE claimmd_era_delivery_history ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_era_delivery_history FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_era_delivery_history_capture ON claimmd_era_delivery_history FOR ALL TO claimmd_capture USING(true) WITH CHECK(true);--> statement-breakpoint
GRANT SELECT,INSERT ON claimmd_era_delivery_history TO claimmd_capture;
