-- compat: contract
-- L6B: tenant-scoped Medicaid ERA review and append-only investigation history. Never a ledger/posting record.
CREATE TABLE medicaid_era_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  stage_id uuid NOT NULL REFERENCES claimmd_era_m25_stage(id) ON DELETE RESTRICT,
  vendor varchar(16) NOT NULL CHECK (vendor = 'claimmd'),
  account_reference varchar(128) NOT NULL,
  source_environment varchar(16) NOT NULL CHECK (source_environment IN ('test', 'production')),
  canonical_payer_id uuid NOT NULL,
  program_id varchar(80) NOT NULL,
  source_digest varchar(64) NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  assessment_fingerprint varchar(64) NOT NULL,
  assessment_version varchar(32) NOT NULL,
  decision_status varchar(32) NOT NULL CHECK (decision_status IN ('review_required', 'payment_reported')),
  reason_codes jsonb NOT NULL CHECK (jsonb_typeof(reason_codes) = 'array'),
  claim_match_status varchar(32) NOT NULL,
  duplicate_status varchar(16) NOT NULL CHECK (duplicate_status IN ('none', 'exact', 'possible', 'conflict')),
  safe_summary jsonb NOT NULL CHECK (jsonb_typeof(safe_summary) = 'object'),
  workflow_state varchar(32) NOT NULL DEFAULT 'needs_review'
    CHECK (workflow_state IN ('needs_review', 'investigating', 'follow_up_required', 'reviewed_not_posted', 'reopened')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medicaid_era_review_stage_digest_uq UNIQUE (organization_id, provider_entity_id, stage_id, source_digest),
  CONSTRAINT medicaid_era_review_assessment_fingerprint_ck CHECK (assessment_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT medicaid_era_review_stage_owner_ck CHECK (organization_id IS NOT NULL AND provider_entity_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX medicaid_era_review_worklist_ix ON medicaid_era_review
  (organization_id, provider_entity_id, workflow_state, created_at DESC);
--> statement-breakpoint
ALTER TABLE medicaid_era_review ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE medicaid_era_review FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY medicaid_era_review_org_read ON medicaid_era_review FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY medicaid_era_review_org_write ON medicaid_era_review FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid AND EXISTS (
    SELECT 1 FROM claimmd_era_m25_stage stage WHERE stage.id = medicaid_era_review.stage_id
      AND stage.organization_id = medicaid_era_review.organization_id
      AND stage.provider_entity_id = medicaid_era_review.provider_entity_id
  ));
--> statement-breakpoint
GRANT SELECT ON medicaid_era_review TO chartwarden_app;
REVOKE ALL ON medicaid_era_review FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    GRANT SELECT, INSERT, UPDATE ON medicaid_era_review TO chartwarden_platform;
  END IF;
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_audit_medicaid_era_review AFTER INSERT OR UPDATE OR DELETE ON medicaid_era_review
  FOR EACH ROW EXECUTE FUNCTION chartwarden_audit_trigger();
--> statement-breakpoint
CREATE FUNCTION guard_medicaid_era_review_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_stage record;
BEGIN
  SELECT organization_id, provider_entity_id, vendor, account_reference, usage, source_file_digest, state, safe_reason_code
    INTO source_stage
    FROM claimmd_era_m25_stage WHERE id = NEW.stage_id;
  IF NOT FOUND OR source_stage.organization_id IS DISTINCT FROM NEW.organization_id
    OR source_stage.provider_entity_id IS DISTINCT FROM NEW.provider_entity_id
    OR source_stage.vendor IS DISTINCT FROM NEW.vendor
    OR source_stage.account_reference IS DISTINCT FROM NEW.account_reference
    OR source_stage.usage IS DISTINCT FROM NEW.source_environment
    OR source_stage.source_file_digest IS DISTINCT FROM NEW.source_digest
    OR NOT (
      source_stage.state = 'staged'
      OR (source_stage.state = 'possible_duplicate' AND source_stage.safe_reason_code = 'POSSIBLE_CROSS_SOURCE_DUPLICATE')
      OR (source_stage.state = 'held' AND source_stage.safe_reason_code = 'EXACT_CROSS_SOURCE_DUPLICATE')
    ) THEN
    RAISE EXCEPTION 'medicaid_era_review source identity is not backed by a staged artifact';
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id
    OR NEW.stage_id IS DISTINCT FROM OLD.stage_id
    OR NEW.vendor IS DISTINCT FROM OLD.vendor
    OR NEW.account_reference IS DISTINCT FROM OLD.account_reference
    OR NEW.source_environment IS DISTINCT FROM OLD.source_environment
    OR NEW.canonical_payer_id IS DISTINCT FROM OLD.canonical_payer_id
    OR NEW.program_id IS DISTINCT FROM OLD.program_id
    OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
    THEN
    RAISE EXCEPTION 'medicaid_era_review assessment identity is immutable';
  END IF;
  IF (NEW.assessment_fingerprint IS DISTINCT FROM OLD.assessment_fingerprint
    OR NEW.assessment_version IS DISTINCT FROM OLD.assessment_version
    OR NEW.decision_status IS DISTINCT FROM OLD.decision_status
    OR NEW.reason_codes IS DISTINCT FROM OLD.reason_codes
    OR NEW.claim_match_status IS DISTINCT FROM OLD.claim_match_status
    OR NEW.duplicate_status IS DISTINCT FROM OLD.duplicate_status
    OR NEW.safe_summary IS DISTINCT FROM OLD.safe_summary)
    AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'medicaid_era_review reassessment requires a version increment';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER medicaid_era_review_identity_immutable BEFORE INSERT OR UPDATE ON medicaid_era_review
  FOR EACH ROW EXECUTE FUNCTION guard_medicaid_era_review_identity();
--> statement-breakpoint
CREATE TABLE medicaid_era_review_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  review_id uuid NOT NULL REFERENCES medicaid_era_review(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  action varchar(32) NOT NULL CHECK (action IN ('assessed', 'reassessed', 'note', 'investigating', 'follow_up_required', 'reviewed_not_posted', 'reopened')),
  reason_code varchar(64),
  note varchar(1000),
  actor_membership_id uuid NOT NULL,
  idempotency_key_hash varchar(64) CHECK (idempotency_key_hash IS NULL OR idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medicaid_era_review_history_version_uq UNIQUE (review_id, version),
  CONSTRAINT medicaid_era_review_history_idempotency_uq UNIQUE (organization_id, idempotency_key_hash),
  CONSTRAINT medicaid_era_review_history_owner_ck CHECK (organization_id IS NOT NULL AND provider_entity_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX medicaid_era_review_history_read_ix ON medicaid_era_review_history
  (organization_id, provider_entity_id, review_id, version);
--> statement-breakpoint
ALTER TABLE medicaid_era_review_history ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE medicaid_era_review_history FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY medicaid_era_review_history_org_read ON medicaid_era_review_history FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY medicaid_era_review_history_org_insert ON medicaid_era_review_history FOR INSERT TO chartwarden_app
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid AND EXISTS (
    SELECT 1 FROM medicaid_era_review review WHERE review.id = medicaid_era_review_history.review_id
      AND review.organization_id = medicaid_era_review_history.organization_id
      AND review.provider_entity_id = medicaid_era_review_history.provider_entity_id
  ));
--> statement-breakpoint
GRANT SELECT ON medicaid_era_review_history TO chartwarden_app;
REVOKE ALL ON medicaid_era_review_history FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    GRANT SELECT, INSERT ON medicaid_era_review_history TO chartwarden_platform;
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION reject_medicaid_era_review_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'medicaid_era_review_history is append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER medicaid_era_review_history_immutable BEFORE UPDATE OR DELETE ON medicaid_era_review_history
  FOR EACH ROW EXECUTE FUNCTION reject_medicaid_era_review_history_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_audit_medicaid_era_review_history AFTER INSERT ON medicaid_era_review_history
  FOR EACH ROW EXECUTE FUNCTION chartwarden_audit_trigger();
