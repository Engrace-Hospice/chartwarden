-- compat: expand
-- BIL-1.2 identity decisions are central account resources, unreadable by tenant roles. No billing status mutation.
CREATE TABLE IF NOT EXISTS claimmd_response_resolution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES claimmd_response_event(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('pending','resolved','unmatched','ambiguous','conflict','needs_review')),
  organization_id uuid,
  provider_entity_id uuid,
  claim_id uuid,
  module text CHECK (module IS NULL OR module IN ('M23','M24','M41')),
  submission_id uuid,
  submission_attempt_id uuid,
  strategy text CHECK (strategy IS NULL OR strategy IN ('external_claim_id','submission_receipt','strict_composite')),
  reason_code text CHECK (reason_code IS NULL OR reason_code IN ('NO_MATCHING_SUBMISSION','MULTIPLE_CANDIDATES','PROVIDER_IDENTITY_MISMATCH','TENANT_OWNERSHIP_CONFLICT','PAYER_MISMATCH','MISSING_STRONG_IDENTIFIERS','UNKNOWN_EXTERNAL_CLAIM','HISTORICAL_IDENTITY_UNAVAILABLE','EXTERNAL_IDENTIFIER_CONFLICT','MALFORMED_SOURCE_EVENT','RESOLUTION_TRANSIENT_FAILURE')),
  evidence_ref jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence_ref)='object'),
  algorithm_version text NOT NULL CHECK (algorithm_version ~ '^bil1\.2\.v[0-9]+$'),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  lease_owner uuid,
  lease_until timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_response_resolution_event_uq UNIQUE(event_id),
  CONSTRAINT claimmd_response_resolution_lease_pair CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CONSTRAINT claimmd_response_resolution_complete CHECK (
    state <> 'resolved' OR (organization_id IS NOT NULL AND provider_entity_id IS NOT NULL AND claim_id IS NOT NULL AND module IS NOT NULL AND submission_id IS NOT NULL AND submission_attempt_id IS NOT NULL AND strategy IS NOT NULL AND resolved_at IS NOT NULL)
  )
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS claimmd_response_resolution_due_ix ON claimmd_response_resolution(state,next_attempt_at,created_at);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS claimmd_response_resolution_org_ix ON claimmd_response_resolution(organization_id,provider_entity_id,state);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS claimmd_response_resolution_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resolution_id uuid NOT NULL REFERENCES claimmd_response_resolution(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('pending','resolved','unmatched','ambiguous','conflict','needs_review')),
  organization_id uuid,
  provider_entity_id uuid,
  claim_id uuid,
  module text,
  submission_id uuid,
  submission_attempt_id uuid,
  strategy text,
  reason_code text,
  evidence_ref jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence_ref)='object'),
  algorithm_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_response_resolution_history_version_uq UNIQUE(resolution_id,version)
);--> statement-breakpoint
ALTER TABLE claimmd_response_resolution ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_response_resolution FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_response_resolution_internal ON claimmd_response_resolution FOR ALL TO claimmd_capture USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE claimmd_response_resolution_history ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_response_resolution_history FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_response_resolution_history_internal ON claimmd_response_resolution_history FOR ALL TO claimmd_capture USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON claimmd_response_resolution TO claimmd_capture;--> statement-breakpoint
GRANT SELECT, INSERT ON claimmd_response_resolution_history TO claimmd_capture;
--> statement-breakpoint
-- Include already-captured events; this is metadata-only backfill and never changes the authoritative response cursor.
INSERT INTO claimmd_response_resolution(event_id,state,algorithm_version)
SELECT e.id,CASE WHEN e.capture_state='malformed' THEN 'needs_review' ELSE 'pending' END,'bil1.2.v1' FROM claimmd_response_event e
ON CONFLICT(event_id) DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION claimmd_seed_response_resolution() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO claimmd_response_resolution(event_id,state,algorithm_version)
  VALUES (NEW.id,CASE WHEN NEW.capture_state='malformed' THEN 'needs_review' ELSE 'pending' END,'bil1.2.v1') ON CONFLICT(event_id) DO NOTHING;
  RETURN NEW;
END $fn$;--> statement-breakpoint
CREATE TRIGGER trg_claimmd_seed_response_resolution AFTER INSERT ON claimmd_response_event
FOR EACH ROW EXECUTE FUNCTION claimmd_seed_response_resolution();
