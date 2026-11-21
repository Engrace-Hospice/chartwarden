-- compat: expand
-- M24-1075-L1: distinguish explicit, effective-dated Medicaid program responsibility from M5 coverage
-- and from transport credentials. Existing claim rows remain NULL and are therefore legacy-unresolved;
-- no historical financial or payer snapshot is rewritten. Enrollment evidence remains separate from
-- credential configuration and cannot unlock electronic submission.
CREATE TYPE m24_medicaid_program_kind AS ENUM (
  'ffs_open_card', 'managed_care', 'other_managed_care', 'unsupported', 'unresolved', 'ambiguous'
);--> statement-breakpoint
CREATE TYPE m24_program_assignment_status AS ENUM (
  'candidate', 'pending', 'verified', 'rejected', 'revoked', 'superseded'
);--> statement-breakpoint
CREATE TYPE m24_enrollment_evidence_kind AS ENUM (
  'state_medicaid_provider_enrollment', 'mco_participation', '837i_enrollment', '835_era_enrollment',
  'clearinghouse_payer_route', 'institutional_format_qualification', 'payer_transport_certification', 'production_activation_approval'
);--> statement-breakpoint
CREATE TYPE m24_enrollment_evidence_status AS ENUM (
  'pending', 'verified', 'rejected', 'expired', 'revoked', 'superseded'
);--> statement-breakpoint

ALTER TABLE medicaid_claim
  ADD COLUMN medicaid_program_kind m24_medicaid_program_kind,
  ADD COLUMN canonical_payer_id uuid,
  ADD COLUMN program_assignment_id uuid,
  ADD COLUMN program_resolution_snapshot jsonb;--> statement-breakpoint
COMMENT ON COLUMN medicaid_claim.mco_id IS 'Logical M40 MCO identity; NULL is not evidence of FFS/Open Card.';--> statement-breakpoint
COMMENT ON COLUMN medicaid_claim.medicaid_program_kind IS 'Explicit program identity on new claims; NULL on historical rows means legacy unresolved.';--> statement-breakpoint
COMMENT ON COLUMN medicaid_claim.program_assignment_id IS 'Logical M24 reference to effective-dated responsibility evidence; historical claims remain NULL.';--> statement-breakpoint

CREATE TABLE medicaid_program_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL,
  patient_payer_id uuid NOT NULL,
  admission_id uuid NOT NULL,
  provider_entity_id uuid NOT NULL REFERENCES provider_entity(id) ON DELETE RESTRICT,
  service_state varchar(2) NOT NULL,
  program_kind m24_medicaid_program_kind NOT NULL,
  canonical_payer_id uuid,
  payer_snapshot jsonb,
  status m24_program_assignment_status NOT NULL DEFAULT 'candidate',
  effective_from date NOT NULL,
  effective_to date,
  source_kind varchar(40) NOT NULL,
  verification_source varchar(80),
  evidence_reference text,
  verified_at timestamptz,
  verified_by_membership_id uuid,
  revocation_reason varchar(40),
  recorded_by_membership_id uuid NOT NULL,
  supersedes_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medicaid_program_assignment_range_valid CHECK (effective_to IS NULL OR effective_from <= effective_to),
  CONSTRAINT medicaid_program_assignment_verified_provenance CHECK (
    status <> 'verified' OR (verified_at IS NOT NULL AND verified_by_membership_id IS NOT NULL AND evidence_reference IS NOT NULL)
  ),
  CONSTRAINT medicaid_program_assignment_ffs_identity CHECK (
    program_kind <> 'ffs_open_card' OR canonical_payer_id IS NOT NULL
  ),
  CONSTRAINT medicaid_program_assignment_evidence_reference_shape CHECK (
    evidence_reference IS NULL OR evidence_reference ~ '^(doc|registry|approval|ticket):[A-Za-z0-9._/-]{1,190}$'
  ),
  CONSTRAINT medicaid_program_assignment_revocation_reason CHECK (
    revocation_reason IS NULL OR revocation_reason IN ('source_corrected', 'payer_withdrawal', 'coverage_changed', 'other')
  )
);--> statement-breakpoint
CREATE INDEX medicaid_program_assignment_patient_range_ix ON medicaid_program_assignment
  (organization_id, patient_id, patient_payer_id, admission_id, provider_entity_id, effective_from, effective_to);--> statement-breakpoint

CREATE TABLE medicaid_enrollment_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL REFERENCES provider_entity(id) ON DELETE RESTRICT,
  service_state varchar(2) NOT NULL,
  program_kind m24_medicaid_program_kind,
  canonical_payer_id uuid,
  clearinghouse varchar(40),
  vendor_payer_id varchar(80),
  transaction_type varchar(8),
  evidence_kind m24_enrollment_evidence_kind NOT NULL,
  status m24_enrollment_evidence_status NOT NULL DEFAULT 'pending',
  effective_from date NOT NULL,
  effective_to date,
  verification_source varchar(80),
  evidence_reference text,
  verified_at timestamptz,
  verified_by_membership_id uuid,
  revocation_reason varchar(40),
  recorded_by_membership_id uuid NOT NULL,
  supersedes_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medicaid_enrollment_evidence_range_valid CHECK (effective_to IS NULL OR effective_from <= effective_to),
  CONSTRAINT medicaid_enrollment_evidence_verified_provenance CHECK (
    status <> 'verified' OR (verified_at IS NOT NULL AND verified_by_membership_id IS NOT NULL
      AND verification_source IS NOT NULL AND evidence_reference IS NOT NULL)
  ),
  CONSTRAINT medicaid_enrollment_evidence_transaction_type CHECK (
    transaction_type IS NULL OR transaction_type IN ('837I', '835')
  ),
  CONSTRAINT medicaid_enrollment_verified_payer_route_is_mapped CHECK (
    evidence_kind <> 'clearinghouse_payer_route' OR status <> 'verified' OR
      (clearinghouse IS NOT NULL AND canonical_payer_id IS NOT NULL AND vendor_payer_id IS NOT NULL AND transaction_type IS NOT NULL)
  ),
  CONSTRAINT medicaid_enrollment_evidence_reference_shape CHECK (
    evidence_reference IS NULL OR evidence_reference ~ '^(doc|registry|approval|ticket):[A-Za-z0-9._/-]{1,190}$'
  ),
  CONSTRAINT medicaid_enrollment_evidence_revocation_reason CHECK (
    revocation_reason IS NULL OR revocation_reason IN ('source_corrected', 'payer_withdrawal', 'coverage_changed', 'other')
  )
);--> statement-breakpoint
CREATE INDEX medicaid_enrollment_provider_payer_range_ix ON medicaid_enrollment_evidence
  (organization_id, provider_entity_id, service_state, canonical_payer_id, evidence_kind, effective_from, effective_to);--> statement-breakpoint

-- Org-only tenant policy per ADR-0010; provider/entity scope is enforced by M3 ABAC at route boundaries.
ALTER TABLE medicaid_program_assignment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE medicaid_program_assignment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY medicaid_program_assignment_org ON medicaid_program_assignment FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON medicaid_program_assignment TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON medicaid_program_assignment TO chartwarden_admin;--> statement-breakpoint

ALTER TABLE medicaid_enrollment_evidence ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE medicaid_enrollment_evidence FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY medicaid_enrollment_evidence_org ON medicaid_enrollment_evidence FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON medicaid_enrollment_evidence TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON medicaid_enrollment_evidence TO chartwarden_admin;--> statement-breakpoint

-- Audit only stable, non-sensitive fields. Patient id and evidence/document pointers are excluded.
CREATE OR REPLACE FUNCTION audit_phi_write_medicaid_program_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), ARRAY['patient_id','patient_payer_id','admission_id','evidence_reference','payer_snapshot']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), ARRAY['patient_id','patient_payer_id','admission_id','evidence_reference','payer_snapshot']::text[]) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'medicaid_program_assignment.' || lower(TG_OP), TG_TABLE_NAME, COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_medicaid_program_assignment() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER trg_audit_medicaid_program_assignment AFTER INSERT OR UPDATE OR DELETE ON medicaid_program_assignment
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medicaid_program_assignment();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_medicaid_enrollment_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), ARRAY['evidence_reference']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), ARRAY['evidence_reference']::text[]) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'medicaid_enrollment_evidence.' || lower(TG_OP), TG_TABLE_NAME, COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_medicaid_enrollment_evidence() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER trg_audit_medicaid_enrollment_evidence AFTER INSERT OR UPDATE OR DELETE ON medicaid_enrollment_evidence
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medicaid_enrollment_evidence();
