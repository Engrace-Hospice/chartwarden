-- compat: expand
-- M24-1075-L1: distinguish explicit, effective-dated Medicaid program responsibility from M5 coverage
-- and from transport credentials. Existing claim rows remain NULL and are therefore legacy-unresolved;
-- no historical financial or payer snapshot is rewritten. Enrollment evidence remains separate from
-- credential configuration and cannot unlock electronic submission.
--
-- Both tables are mutable (verify / revoke), so the database, not only the write service, holds the rules the
-- append-only evidence tables of 1538/1539 hold by trigger: the verifier is never the recorder (four-eyes CHECK), the
-- application role may UPDATE only the columns those two paths write, a row's identity never changes, and a status
-- only moves forward (verify from an open status, a verified row only to revoked/superseded/expired, a closed row is
-- final, and the verification evidence is frozen once the row leaves its open status). A provider entity must belong
-- to the row's organization (a foreign key alone would accept, and so reveal the existence of, another tenant's). The
-- application role also records a row only as candidate or pending: it cannot INSERT an already verified or closed row.
--
-- ERASURE (open constraint, owner decision; medicaid_program_assignment only, the enrollment table is provider-keyed and holds
-- no patient identifier): the assignment is patient-keyed (patient_id, patient_payer_id, admission_id) and carries
-- evidence_reference and a payer_snapshot, but it has no destruction-role grant, the identity guard below refuses a change to
-- any of those keys for every role, and the per-patient eraser (medicaid-eraser.ts) does not know this table, so a patient's
-- assignments cannot be erased or de-identified by the existing erasure path. Unlike 1538 a writer exists today (the write
-- service records and verifies assignments), so rows accumulate. Whoever owns the erasure path must decide it (a destruction
-- grant plus a guard that admits only that role's DELETE, or column-level crypto-shredding of the references) before the
-- first patient-erasure request touches M24.
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
  location_id uuid REFERENCES location(id) ON DELETE RESTRICT,
  service_state varchar(2) NOT NULL,
  program_kind m24_medicaid_program_kind NOT NULL,
  canonical_payer_id uuid,
  canonical_payer_classification_id uuid,
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
  CONSTRAINT medicaid_program_assignment_four_eyes CHECK (
    status <> 'verified' OR verified_by_membership_id <> recorded_by_membership_id
  ),
  CONSTRAINT medicaid_program_assignment_ffs_identity CHECK (
    program_kind <> 'ffs_open_card' OR canonical_payer_id IS NOT NULL
  ),
  CONSTRAINT medicaid_program_assignment_evidence_reference_shape CHECK (
    evidence_reference IS NULL OR evidence_reference ~ '^(doc|registry|approval|ticket):[A-Za-z0-9._/-]{1,190}$'
  ),
  CONSTRAINT medicaid_program_assignment_revocation_reason CHECK (
    revocation_reason IS NULL OR revocation_reason IN ('source_corrected', 'payer_withdrawal', 'coverage_changed', 'other')
  ),
  -- unresolved and ambiguous say "no concrete program": a verified row cannot carry either (it would resolve as verified).
  CONSTRAINT medicaid_program_assignment_verified_program_kind CHECK (
    status <> 'verified' OR program_kind NOT IN ('unresolved', 'ambiguous')
  ),
  -- A successor must name a row of the same organization (the foreign key alone would accept another tenant's id).
  CONSTRAINT medicaid_program_assignment_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT medicaid_program_assignment_supersedes_org_fk
    FOREIGN KEY (organization_id, supersedes_id)
    REFERENCES medicaid_program_assignment (organization_id, id) ON DELETE RESTRICT
);--> statement-breakpoint
CREATE INDEX medicaid_program_assignment_patient_range_ix ON medicaid_program_assignment
  (organization_id, patient_id, patient_payer_id, admission_id, provider_entity_id, effective_from, effective_to);--> statement-breakpoint
CREATE INDEX medicaid_program_assignment_supersedes_ix ON medicaid_program_assignment
  (organization_id, supersedes_id);--> statement-breakpoint

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
  CONSTRAINT medicaid_enrollment_evidence_four_eyes CHECK (
    status <> 'verified' OR verified_by_membership_id <> recorded_by_membership_id
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
  ),
  CONSTRAINT medicaid_enrollment_verified_program_kind CHECK (
    status <> 'verified' OR program_kind IS NULL OR program_kind NOT IN ('unresolved', 'ambiguous')
  ),
  CONSTRAINT medicaid_enrollment_evidence_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT medicaid_enrollment_evidence_supersedes_org_fk
    FOREIGN KEY (organization_id, supersedes_id)
    REFERENCES medicaid_enrollment_evidence (organization_id, id) ON DELETE RESTRICT
);--> statement-breakpoint
CREATE INDEX medicaid_enrollment_provider_payer_range_ix ON medicaid_enrollment_evidence
  (organization_id, provider_entity_id, service_state, canonical_payer_id, evidence_kind, effective_from, effective_to);--> statement-breakpoint
CREATE INDEX medicaid_enrollment_supersedes_ix ON medicaid_enrollment_evidence
  (organization_id, supersedes_id);--> statement-breakpoint

-- Org-only tenant policy per ADR-0010; provider/entity scope is enforced by M3 ABAC at route boundaries.
ALTER TABLE medicaid_program_assignment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE medicaid_program_assignment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY medicaid_program_assignment_org ON medicaid_program_assignment FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- UPDATE is granted per column: exactly what the verify and revoke paths write. The row's identity, siting, payer, period
-- and recorder are not updatable by the application role at all (the guard trigger below holds for every role).
GRANT SELECT, INSERT ON medicaid_program_assignment TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE (status, canonical_payer_classification_id, verification_source, evidence_reference, verified_at,
  verified_by_membership_id, revocation_reason, version, updated_at) ON medicaid_program_assignment TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON medicaid_program_assignment TO chartwarden_admin;--> statement-breakpoint

ALTER TABLE medicaid_enrollment_evidence ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE medicaid_enrollment_evidence FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY medicaid_enrollment_evidence_org ON medicaid_enrollment_evidence FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON medicaid_enrollment_evidence TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE (status, verification_source, evidence_reference, verified_at, verified_by_membership_id,
  revocation_reason, version, updated_at) ON medicaid_enrollment_evidence TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON medicaid_enrollment_evidence TO chartwarden_admin;--> statement-breakpoint

-- A provider entity must belong to the row's organization. The foreign key accepts any provider_entity id, so without this a
-- tenant could write a row naming another tenant's provider entity, and success versus failure would reveal that it exists.
-- The function reads provider_entity as the caller (under RLS), so another tenant's provider entity is simply not visible and
-- an unknown id looks the same: one message for both. Shared by both tables (1538 and 1539 carry the same rule).
CREATE OR REPLACE FUNCTION guard_m24_readiness_provider_entity_org() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_provider_org uuid;
BEGIN
  SELECT organization_id INTO v_provider_org FROM provider_entity WHERE id = NEW.provider_entity_id;
  IF v_provider_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION '% provider entity must belong to the record organization', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_program_assignment_provider_entity
  BEFORE INSERT ON medicaid_program_assignment
  FOR EACH ROW EXECUTE FUNCTION guard_m24_readiness_provider_entity_org();--> statement-breakpoint
CREATE TRIGGER trg_medicaid_enrollment_evidence_provider_entity
  BEFORE INSERT ON medicaid_enrollment_evidence
  FOR EACH ROW EXECUTE FUNCTION guard_m24_readiness_provider_entity_org();--> statement-breakpoint

-- location_id is a foreign key only, and referential integrity bypasses RLS, so a row could name another tenant's
-- location. The siting must be one of THIS row's provider entity (already proven to belong to the row's organization);
-- another tenant's location is invisible to the caller and reads as not found. Shared with 1538's authorization event.
CREATE OR REPLACE FUNCTION guard_m24_readiness_location_provider() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_location_provider uuid;
BEGIN
  IF NEW.location_id IS NULL THEN RETURN NEW; END IF;
  SELECT provider_entity_id INTO v_location_provider FROM location WHERE id = NEW.location_id;
  IF v_location_provider IS DISTINCT FROM NEW.provider_entity_id THEN
    RAISE EXCEPTION '% location must belong to the record provider entity', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_program_assignment_location
  BEFORE INSERT ON medicaid_program_assignment
  FOR EACH ROW EXECUTE FUNCTION guard_m24_readiness_location_provider();--> statement-breakpoint

-- The application role records a row as candidate or pending and nothing else (a pending row is what the write service
-- inserts; candidate exists on the assignment only, hence the text comparison, which the other table's enum would refuse
-- to cast). The guard refuses a ONE-statement verified or closed INSERT: without it the role could INSERT an already
-- verified, rejected, revoked, superseded or expired row in one statement, and the four-eyes CHECK would not stop it (it
-- compares two values the same caller supplies). 1538 and 1539 refuse the same insert by the same role.
-- Verification is an UPDATE from an open status, which the update guards below admit.
-- KNOWN LIMIT: this does not make verification route-only. The database cannot tell the verify route from other
-- application SQL (a trigger has no caller-bound identity), so the application role can still INSERT a pending row and
-- UPDATE it to verified in a second statement, naming any verifier but the recorder. Verification itself (the M40
-- classification match, the source allow-list, step-up) is enforced by the verify service, not by the database. What the
-- database guarantees is the four-eyes arithmetic (the verifier column differs from the recorder column), the freeze of
-- identity and verification evidence, and the transition table below: not WHO the verifier is.
CREATE OR REPLACE FUNCTION guard_m24_readiness_insert_status() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user = 'chartwarden_app' AND NEW.status::text NOT IN ('candidate', 'pending') THEN
    RAISE EXCEPTION '% must be recorded as an open row: verification requires a separate reviewer path', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_program_assignment_insert_status
  BEFORE INSERT ON medicaid_program_assignment
  FOR EACH ROW EXECUTE FUNCTION guard_m24_readiness_insert_status();--> statement-breakpoint
CREATE TRIGGER trg_medicaid_enrollment_evidence_insert_status
  BEFORE INSERT ON medicaid_enrollment_evidence
  FOR EACH ROW EXECUTE FUNCTION guard_m24_readiness_insert_status();--> statement-breakpoint

-- UPDATE guards, for every role (the column grants above already keep the application role off the identity columns).
--   1. Identity never changes: what the row IS (organization, patient, coverage, admission, provider entity, siting, state,
--      program, payer, period, source, recorder, lineage, creation time).
--   2. A rejected, revoked or superseded row is final.
--   3. A verified row can only be revoked or superseded: never back to candidate/pending/rejected, and never re-verified.
--   4. The verification evidence (source, reference, time, verifier, the M40 classification relied on) is frozen once a
--      row has left candidate/pending, so a verified row cannot have its evidence swapped under the verification. While
--      the row is still open the application role can write it (the database does not tell the verify route from other
--      application SQL; see the known limit above).
-- Verification therefore happens only from candidate/pending, which is also what the write service enforces.
CREATE OR REPLACE FUNCTION guard_medicaid_program_assignment_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF ROW(NEW.id, NEW.organization_id, NEW.patient_id, NEW.patient_payer_id, NEW.admission_id, NEW.provider_entity_id,
         NEW.location_id, NEW.service_state, NEW.program_kind, NEW.canonical_payer_id, NEW.payer_snapshot,
         NEW.effective_from, NEW.effective_to, NEW.source_kind, NEW.recorded_by_membership_id, NEW.supersedes_id,
         NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.organization_id, OLD.patient_id, OLD.patient_payer_id, OLD.admission_id, OLD.provider_entity_id,
         OLD.location_id, OLD.service_state, OLD.program_kind, OLD.canonical_payer_id, OLD.payer_snapshot,
         OLD.effective_from, OLD.effective_to, OLD.source_kind, OLD.recorded_by_membership_id, OLD.supersedes_id,
         OLD.created_at) THEN
    RAISE EXCEPTION 'medicaid_program_assignment: the identity of an assignment cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('rejected', 'revoked', 'superseded') THEN
    RAISE EXCEPTION 'medicaid_program_assignment: a rejected, revoked or superseded assignment is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'verified' AND NEW.status NOT IN ('verified', 'revoked', 'superseded') THEN
    RAISE EXCEPTION 'medicaid_program_assignment: a verified assignment can only be revoked or superseded' USING ERRCODE = '23514';
  END IF;
  IF OLD.status NOT IN ('candidate', 'pending')
     AND ROW(NEW.verification_source, NEW.evidence_reference, NEW.verified_at, NEW.verified_by_membership_id,
             NEW.canonical_payer_classification_id)
         IS DISTINCT FROM
         ROW(OLD.verification_source, OLD.evidence_reference, OLD.verified_at, OLD.verified_by_membership_id,
             OLD.canonical_payer_classification_id) THEN
    RAISE EXCEPTION 'medicaid_program_assignment: verification evidence cannot change once the assignment has left candidate or pending' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_program_assignment_update_guard
  BEFORE UPDATE ON medicaid_program_assignment
  FOR EACH ROW EXECUTE FUNCTION guard_medicaid_program_assignment_update();--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_enrollment_evidence_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF ROW(NEW.id, NEW.organization_id, NEW.provider_entity_id, NEW.service_state, NEW.program_kind, NEW.canonical_payer_id,
         NEW.clearinghouse, NEW.vendor_payer_id, NEW.transaction_type, NEW.evidence_kind, NEW.effective_from,
         NEW.effective_to, NEW.recorded_by_membership_id, NEW.supersedes_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.organization_id, OLD.provider_entity_id, OLD.service_state, OLD.program_kind, OLD.canonical_payer_id,
         OLD.clearinghouse, OLD.vendor_payer_id, OLD.transaction_type, OLD.evidence_kind, OLD.effective_from,
         OLD.effective_to, OLD.recorded_by_membership_id, OLD.supersedes_id, OLD.created_at) THEN
    RAISE EXCEPTION 'medicaid_enrollment_evidence: the identity of an evidence row cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('rejected', 'expired', 'revoked', 'superseded') THEN
    RAISE EXCEPTION 'medicaid_enrollment_evidence: a rejected, expired, revoked or superseded evidence row is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'verified' AND NEW.status NOT IN ('verified', 'revoked', 'expired', 'superseded') THEN
    RAISE EXCEPTION 'medicaid_enrollment_evidence: a verified evidence row can only be revoked, expired or superseded' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending'
     AND ROW(NEW.verification_source, NEW.evidence_reference, NEW.verified_at, NEW.verified_by_membership_id)
         IS DISTINCT FROM
         ROW(OLD.verification_source, OLD.evidence_reference, OLD.verified_at, OLD.verified_by_membership_id) THEN
    RAISE EXCEPTION 'medicaid_enrollment_evidence: verification evidence cannot change once the row has left pending' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_enrollment_evidence_update_guard
  BEFORE UPDATE ON medicaid_enrollment_evidence
  FOR EACH ROW EXECUTE FUNCTION guard_medicaid_enrollment_evidence_update();--> statement-breakpoint

-- Audit only stable, non-sensitive fields. Patient id and evidence/document pointers are excluded.
CREATE OR REPLACE FUNCTION audit_phi_write_medicaid_program_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
