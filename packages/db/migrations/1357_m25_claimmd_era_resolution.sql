-- compat: expand
-- BIL-1.4.1A: durable, protected ownership decisions; no tenant visibility and no financial mutation.
CREATE TABLE claimmd_era_resolution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL UNIQUE REFERENCES claimmd_era_inbox(id) ON DELETE RESTRICT,
  vendor text NOT NULL CHECK (vendor='claimmd'),
  account_reference text NOT NULL CHECK (account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  original_835_digest text NOT NULL CHECK (original_835_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('verified','unmatched','ambiguous','conflict','needs_review','invalid_source')),
  organization_id uuid,
  provider_entity_id uuid,
  location_id uuid,
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z_]{1,64}$'),
  algorithm_version text NOT NULL,
  resolution_version integer NOT NULL DEFAULT 1 CHECK (resolution_version > 0),
  decision_cipher text NOT NULL,
  decision_key_id text NOT NULL,
  decision_digest text NOT NULL CHECK (decision_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status='verified') = (organization_id IS NOT NULL AND provider_entity_id IS NOT NULL)),
  CHECK (organization_id IS NOT NULL OR location_id IS NULL)
);--> statement-breakpoint
CREATE INDEX claimmd_era_resolution_owner_ix ON claimmd_era_resolution(organization_id,provider_entity_id,created_at);--> statement-breakpoint
CREATE TABLE claimmd_era_resolution_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resolution_id uuid NOT NULL REFERENCES claimmd_era_resolution(id) ON DELETE RESTRICT,
  resolution_version integer NOT NULL CHECK (resolution_version > 0),
  status text NOT NULL CHECK (status IN ('verified','unmatched','ambiguous','conflict','needs_review','invalid_source')),
  organization_id uuid, provider_entity_id uuid,
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z_]{1,64}$'),
  algorithm_version text NOT NULL, decision_cipher text NOT NULL, decision_key_id text NOT NULL,
  decision_digest text NOT NULL CHECK (decision_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(resolution_id,resolution_version)
);--> statement-breakpoint
ALTER TABLE claimmd_era_resolution ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_era_resolution FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_era_resolution_capture ON claimmd_era_resolution FOR ALL TO claimmd_capture USING(true) WITH CHECK(true);--> statement-breakpoint
ALTER TABLE claimmd_era_resolution_history ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_era_resolution_history FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_era_resolution_history_capture ON claimmd_era_resolution_history FOR ALL TO claimmd_capture USING(true) WITH CHECK(true);--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON claimmd_era_resolution TO claimmd_capture;--> statement-breakpoint
GRANT SELECT,INSERT ON claimmd_era_resolution_history TO claimmd_capture;
