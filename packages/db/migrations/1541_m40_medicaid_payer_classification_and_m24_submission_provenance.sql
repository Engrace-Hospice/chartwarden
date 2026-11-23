-- compat: contract
-- L6A: source-backed M40 payer classification and nullable, unqualified M24 attempt provenance.
-- No catalog records are seeded and no historical M24 submissions are promoted.
CREATE TABLE mdm_medicaid_payer_program_classification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_payer_id uuid NOT NULL REFERENCES payer(id) ON DELETE RESTRICT,
  state_code text NOT NULL,
  classification text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  verification_status text NOT NULL DEFAULT 'unverified',
  source_kind text NOT NULL,
  source_reference text,
  verified_at timestamptz,
  verified_by text,
  supersedes_id uuid REFERENCES mdm_medicaid_payer_program_classification(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mdm_medicaid_payer_program_classification_state_ck CHECK (length(state_code) = 2),
  CONSTRAINT mdm_medicaid_payer_program_classification_class_ck CHECK
    (classification IN ('oregon_ffs', 'medicaid_cco', 'other_managed_care', 'unsupported')),
  CONSTRAINT mdm_medicaid_payer_program_classification_oregon_ffs_state_ck CHECK
    (classification <> 'oregon_ffs' OR state_code = 'OR'),
  CONSTRAINT mdm_medicaid_payer_program_classification_status_ck CHECK
    (verification_status IN ('unverified', 'verified', 'rejected', 'revoked', 'superseded')),
  CONSTRAINT mdm_medicaid_payer_program_classification_source_ck CHECK
    (source_kind IN ('state_registry', 'state_contract', 'payer_confirmation', 'other_authoritative')),
  CONSTRAINT mdm_medicaid_payer_program_classification_period_ck CHECK
    (effective_to IS NULL OR effective_from <= effective_to),
  CONSTRAINT mdm_medicaid_payer_program_classification_verified_evidence_ck CHECK
    (verification_status <> 'verified' OR (source_reference IS NOT NULL AND verified_at IS NOT NULL AND verified_by IS NOT NULL)),
  CONSTRAINT mdm_medicaid_payer_program_classification_source_ref_ck CHECK
    (source_reference IS NULL OR source_reference ~ '^(doc|registry|contract|approval):[A-Za-z0-9._/-]{1,190}$')
);--> statement-breakpoint
CREATE INDEX mdm_medicaid_payer_program_classification_lookup_ix
  ON mdm_medicaid_payer_program_classification(canonical_payer_id, state_code, effective_from, effective_to, verification_status);--> statement-breakpoint
CREATE INDEX mdm_medicaid_payer_program_classification_supersedes_ix
  ON mdm_medicaid_payer_program_classification(supersedes_id);--> statement-breakpoint
ALTER TABLE mdm_medicaid_payer_program_classification ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY mdm_medicaid_payer_program_classification_read ON mdm_medicaid_payer_program_classification
  FOR SELECT TO chartwarden_app USING (true);--> statement-breakpoint
CREATE POLICY mdm_medicaid_payer_program_classification_writer ON mdm_medicaid_payer_program_classification
  FOR ALL TO mdm_canonical_writer USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE mdm_medicaid_payer_program_classification FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT ON mdm_medicaid_payer_program_classification TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON mdm_medicaid_payer_program_classification TO mdm_canonical_writer;--> statement-breakpoint
GRANT ALL ON mdm_medicaid_payer_program_classification TO chartwarden_admin;--> statement-breakpoint
CREATE TRIGGER trg_audit_mdm_medicaid_payer_program_classification
  AFTER INSERT OR UPDATE OR DELETE ON mdm_medicaid_payer_program_classification
  FOR EACH ROW EXECUTE FUNCTION chartwarden_audit_trigger();--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_mdm_medicaid_payer_program_classification_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'M40 payer classifications are append-only'; END $$;--> statement-breakpoint
CREATE TRIGGER trg_mdm_medicaid_payer_program_classification_append_only
  BEFORE UPDATE OR DELETE ON mdm_medicaid_payer_program_classification
  FOR EACH ROW EXECUTE FUNCTION guard_mdm_medicaid_payer_program_classification_append_only();--> statement-breakpoint

ALTER TABLE medicaid_submission
  ADD COLUMN source_account_ref varchar(128),
  ADD COLUMN source_environment varchar(16),
  ADD COLUMN canonical_payer_id_snapshot uuid,
  ADD COLUMN payer_classification_id_snapshot uuid,
  ADD COLUMN program_kind_snapshot varchar(32),
  ADD COLUMN program_assignment_id_snapshot uuid,
  ADD COLUMN program_assignment_version_snapshot integer,
  ADD COLUMN submitted_claim_version integer,
  ADD COLUMN source_provenance_status varchar(16) NOT NULL DEFAULT 'unverified';--> statement-breakpoint
ALTER TABLE medicaid_submission ADD CONSTRAINT medicaid_submission_source_environment_ck
  CHECK (source_environment IS NULL OR source_environment IN ('test', 'production'));--> statement-breakpoint
ALTER TABLE medicaid_submission ADD CONSTRAINT medicaid_submission_source_provenance_status_ck
  CHECK (source_provenance_status IN ('unverified', 'verified'));--> statement-breakpoint
ALTER TABLE medicaid_submission ADD CONSTRAINT medicaid_submission_verified_provenance_ck CHECK (
  source_provenance_status <> 'verified' OR
  (source_account_ref IS NOT NULL AND source_environment IS NOT NULL AND canonical_payer_id_snapshot IS NOT NULL
    AND payer_classification_id_snapshot IS NOT NULL
    AND program_kind_snapshot IS NOT NULL
    AND program_assignment_id_snapshot IS NOT NULL AND program_assignment_version_snapshot > 0
    AND submitted_claim_version IS NOT NULL
    AND submitted_claim_version > 0 AND submitted_at IS NOT NULL AND vendor_transaction_id IS NOT NULL)
);--> statement-breakpoint
-- (medicaid_program_assignment.canonical_payer_classification_id is created with the table in 1535, beside its column grant and guards.)
ALTER TABLE medicaid_submission ADD CONSTRAINT medicaid_submission_program_kind_snapshot_ck
  CHECK (program_kind_snapshot IS NULL OR program_kind_snapshot IN ('ffs_open_card', 'managed_care', 'other_managed_care', 'unsupported', 'unresolved', 'ambiguous'));--> statement-breakpoint
CREATE INDEX medicaid_submission_source_identity_ix
  ON medicaid_submission (organization_id, provider_entity_id, adapter_vendor, source_account_ref, source_environment, canonical_payer_id_snapshot)
  WHERE source_account_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX medicaid_submission_source_transaction_uq
  ON medicaid_submission (organization_id, provider_entity_id, adapter_vendor, source_account_ref, source_environment, vendor_transaction_id)
  WHERE source_account_ref IS NOT NULL AND source_environment IS NOT NULL AND vendor_transaction_id IS NOT NULL;--> statement-breakpoint
-- The application role never writes verified provenance: it cannot insert a verified attempt or promote an unverified one
-- (only a qualified server-owned path, which does not run as chartwarden_app, may). It DOES keep updating an attempt that
-- is already verified (result, error detail, polling and terminal time, acknowledgment handling), so the guard looks at OLD:
-- on UPDATE it refuses only a promotion, or a change to a column the verification stands on. Those are the provenance
-- columns the verified CHECK relies on AND the columns that say which attempt the row is (its claim, provider entity,
-- state, channel, MCO, control number, attempt index and adapter): the seam joins an attempt to its claim by
-- medicaid_claim_id, so without the second group the application could repoint a verified attempt at another claim of the
-- same organization and provider entity and keep it verified. The worker writes the adapter vendor and version before it
-- sends, while the attempt is still unverified, so no application path writes any frozen column afterwards.
CREATE OR REPLACE FUNCTION guard_medicaid_submission_provenance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'chartwarden_app' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_provenance_status = 'verified' THEN
      RAISE EXCEPTION 'M24 submission provenance requires a qualified server-owned path';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_provenance_status = 'verified' AND OLD.source_provenance_status IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'M24 submission provenance requires a qualified server-owned path';
  END IF;
  IF OLD.source_provenance_status = 'verified'
     AND ROW(NEW.id, NEW.organization_id, NEW.medicaid_claim_id, NEW.provider_entity_id, NEW.service_state, NEW.channel,
             NEW.mco_id_snapshot, NEW.medicaid_claim_control_number, NEW.attempt_index, NEW.adapter_vendor,
             NEW.adapter_version, NEW.source_provenance_status, NEW.source_account_ref, NEW.source_environment,
             NEW.canonical_payer_id_snapshot, NEW.payer_classification_id_snapshot, NEW.program_kind_snapshot,
             NEW.program_assignment_id_snapshot, NEW.program_assignment_version_snapshot, NEW.submitted_claim_version,
             NEW.submitted_at, NEW.vendor_transaction_id)
         IS DISTINCT FROM
         ROW(OLD.id, OLD.organization_id, OLD.medicaid_claim_id, OLD.provider_entity_id, OLD.service_state, OLD.channel,
             OLD.mco_id_snapshot, OLD.medicaid_claim_control_number, OLD.attempt_index, OLD.adapter_vendor,
             OLD.adapter_version, OLD.source_provenance_status, OLD.source_account_ref, OLD.source_environment,
             OLD.canonical_payer_id_snapshot, OLD.payer_classification_id_snapshot, OLD.program_kind_snapshot,
             OLD.program_assignment_id_snapshot, OLD.program_assignment_version_snapshot, OLD.submitted_claim_version,
             OLD.submitted_at, OLD.vendor_transaction_id) THEN
    RAISE EXCEPTION 'M24 submission provenance of a verified attempt changes only through a qualified server-owned path';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_submission_provenance
  BEFORE INSERT OR UPDATE ON medicaid_submission
  FOR EACH ROW EXECUTE FUNCTION guard_medicaid_submission_provenance();
