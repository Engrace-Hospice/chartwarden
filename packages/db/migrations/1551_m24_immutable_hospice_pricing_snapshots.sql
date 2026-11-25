-- compat: contract
-- L8A.2R: introduce a narrowly scoped, source-verified daily RHC billing evidence profile and immutable
-- payer-rate line snapshots. Historical claim lines keep their legacy schedule identity and are never
-- backfilled. The snapshot is a local-draft pricing record, not payer-format or submission qualification.
-- CW-DS-01 remains open: these rows are patient-linked and no retention period or erasure policy is inferred.
--
-- What the database guards do and do not stop (the application stays the authority for pricing):
--   * The snapshot insert guard binds the claim line, the verified rate row, the verified evidence row, the
--     snapshot's identities and versions, its service dates (compared as UTC calendar days), units and the
--     stored rate/charge amounts, and ties the fingerprint to the JSON. It does NOT recompute reimbursement
--     (reimbursementEstimateCents, baseReimbursementCents, applied ceilings): that would duplicate the pricing
--     engine in SQL. A coherent snapshot with a wrong estimate is bound only by the fingerprint and by the
--     application's re-derivation at validation time.
--   * The temporal, successor and rate/evidence agreement checks are insert-time backstops. The application
--     serializes pricing against rate and evidence writes with the advisory locks taken below. assessed_at must
--     equal the snapshot's assessmentTimestamp and may not be more than five minutes ahead of the database clock
--     (clock_timestamp(), not now(): the application clock may run slightly ahead).
--   * Row triggers do not fire on TRUNCATE. Not covered, stated plainly: TRUNCATE (like DROP or
--     session_replication_role = replica) by the table owner or chartwarden_admin, which holds GRANT ALL, is
--     outside what the append-only and immutability guards stop (procedural control, as in 1138 and 1144).
--     chartwarden_app holds no TRUNCATE privilege.

ALTER TABLE medicaid_claim_line
  ADD COLUMN payer_rate_policy_id_snapshot uuid;--> statement-breakpoint
ALTER TABLE medicaid_claim_line
  DROP CONSTRAINT medicaid_claim_line_rate_schedule_requires_non_rb;--> statement-breakpoint
ALTER TABLE medicaid_claim_line
  ADD CONSTRAINT medicaid_claim_line_rate_source_exactly_one CHECK (
    (is_rb = true AND state_rate_schedule_id_snapshot IS NULL AND payer_rate_policy_id_snapshot IS NULL) OR
    (is_rb = false AND (
      (state_rate_schedule_id_snapshot IS NOT NULL AND payer_rate_policy_id_snapshot IS NULL) OR
      (state_rate_schedule_id_snapshot IS NULL AND payer_rate_policy_id_snapshot IS NOT NULL)
    ))
  );--> statement-breakpoint
ALTER TABLE medicaid_claim_line
  ADD CONSTRAINT medicaid_claim_line_payer_rate_snapshot_fk
  FOREIGN KEY (organization_id, payer_rate_policy_id_snapshot)
  REFERENCES medicaid_payer_rate_policy (organization_id, id) ON DELETE RESTRICT;--> statement-breakpoint
CREATE INDEX medicaid_claim_line_payer_rate_snapshot_fk_ix
  ON medicaid_claim_line (organization_id, payer_rate_policy_id_snapshot)
  WHERE payer_rate_policy_id_snapshot IS NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION lock_medicaid_rate_policy_pricing_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'm24-rate-policy:' || NEW.organization_id::text || ':' || NEW.provider_entity_id::text || ':' ||
    NEW.canonical_payer_id::text || ':' || NEW.service_state, 0));
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_lock_medicaid_rate_policy_pricing_identity
  BEFORE INSERT ON medicaid_payer_rate_policy FOR EACH ROW
  EXECUTE FUNCTION lock_medicaid_rate_policy_pricing_identity();--> statement-breakpoint

CREATE TABLE medicaid_hospice_billing_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL REFERENCES provider_entity(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL,
  admission_id uuid NOT NULL,
  admission_version integer NOT NULL,
  canonical_payer_id uuid NOT NULL,
  program_kind text NOT NULL,
  service_state text NOT NULL,
  locality_code text NOT NULL,
  locality_evidence_reference text NOT NULL,
  locality_evidence_version integer NOT NULL,
  quality_reporting_applicability text NOT NULL,
  quality_reporting_status text NOT NULL,
  quality_evidence_reference text NOT NULL,
  quality_evidence_version integer NOT NULL,
  service_category text NOT NULL,
  quantity_policy text NOT NULL,
  quantity_evidence_owner text NOT NULL,
  billing_unit text NOT NULL,
  revenue_code text NOT NULL,
  hcpcs_code text NOT NULL,
  coding_profile text NOT NULL,
  coding_evidence_reference text NOT NULL,
  coding_evidence_version integer NOT NULL,
  billed_charge_cents_per_unit integer NOT NULL,
  charge_evidence_reference text NOT NULL,
  charge_evidence_version integer NOT NULL,
  verification_status text NOT NULL DEFAULT 'unverified',
  effective_from date NOT NULL,
  effective_to date,
  source_document_reference text NOT NULL,
  verified_at timestamptz,
  verified_by_membership_id uuid,
  recorded_by_membership_id uuid NOT NULL,
  supersedes_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medicaid_hospice_billing_evidence_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT medicaid_hospice_billing_evidence_supersedes_org_fk
    FOREIGN KEY (organization_id, supersedes_id)
    REFERENCES medicaid_hospice_billing_evidence (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT medicaid_hospice_billing_evidence_identity_uq UNIQUE NULLS NOT DISTINCT
    (organization_id, provider_entity_id, admission_id, canonical_payer_id, service_state,
     service_category, effective_from, supersedes_id),
  CONSTRAINT medicaid_hospice_billing_evidence_state CHECK
    (program_kind = 'managed_care' AND service_state = 'OR' AND service_category = 'RHC'),
  CONSTRAINT medicaid_hospice_billing_evidence_period CHECK
    (effective_to IS NULL OR effective_from <= effective_to),
  CONSTRAINT medicaid_hospice_billing_evidence_version CHECK
    (version > 0 AND admission_version >= 0 AND locality_evidence_version > 0 AND
     quality_evidence_version > 0 AND coding_evidence_version > 0 AND charge_evidence_version > 0),
  CONSTRAINT medicaid_hospice_billing_evidence_pricing_facts CHECK
    (locality_code <> '' AND billed_charge_cents_per_unit > 0 AND
     quantity_policy = 'active_rhc_loc_calendar_day' AND
     quantity_evidence_owner = 'm6_level_of_care_period' AND billing_unit = 'daily' AND
     revenue_code = '0651' AND hcpcs_code = 'Q5001' AND coding_profile = 'local_draft_only'),
  CONSTRAINT medicaid_hospice_billing_evidence_quality CHECK
    ((quality_reporting_applicability = 'not_required' AND quality_reporting_status = 'not_applicable') OR
     (quality_reporting_applicability = 'required' AND quality_reporting_status IN ('meets', 'does_not_meet'))),
  CONSTRAINT medicaid_hospice_billing_evidence_status CHECK
    (verification_status IN ('unverified', 'pending', 'verified', 'revoked', 'superseded')),
  CONSTRAINT medicaid_hospice_billing_evidence_verified_provenance CHECK
    (verification_status <> 'verified' OR
     (verified_at IS NOT NULL AND verified_by_membership_id IS NOT NULL AND
      verified_by_membership_id <> recorded_by_membership_id)),
  -- A revoked or superseded row closes its predecessor, so it must carry the instant it was decided.
  CONSTRAINT medicaid_hospice_billing_evidence_closed_provenance CHECK
    (verification_status NOT IN ('revoked', 'superseded') OR verified_at IS NOT NULL),
  CONSTRAINT medicaid_hospice_billing_evidence_references CHECK
    (locality_evidence_reference ~ '^(doc|evidence):[A-Za-z0-9._/-]{1,190}$' AND
     quality_evidence_reference ~ '^(doc|evidence):[A-Za-z0-9._/-]{1,190}$' AND
     coding_evidence_reference ~ '^(doc|evidence):[A-Za-z0-9._/-]{1,190}$' AND
     charge_evidence_reference ~ '^(doc|evidence):[A-Za-z0-9._/-]{1,190}$' AND
     source_document_reference ~ '^(doc|evidence):[A-Za-z0-9._/-]{1,190}$')
);--> statement-breakpoint
CREATE INDEX medicaid_hospice_billing_evidence_lookup_ix ON medicaid_hospice_billing_evidence
  (organization_id, provider_entity_id, admission_id, canonical_payer_id, effective_from, effective_to);--> statement-breakpoint
CREATE INDEX medicaid_hospice_billing_evidence_supersedes_ix ON medicaid_hospice_billing_evidence
  (organization_id, supersedes_id);--> statement-breakpoint
ALTER TABLE medicaid_hospice_billing_evidence ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE medicaid_hospice_billing_evidence FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY medicaid_hospice_billing_evidence_org ON medicaid_hospice_billing_evidence FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON medicaid_hospice_billing_evidence TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON medicaid_hospice_billing_evidence TO chartwarden_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_hospice_billing_evidence_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_provider_org uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'm24-hospice-evidence:' || NEW.organization_id::text || ':' || NEW.provider_entity_id::text || ':' ||
    NEW.patient_id::text || ':' || NEW.admission_id::text || ':' || NEW.canonical_payer_id::text || ':' ||
    NEW.service_state || ':RHC', 0));
  SELECT organization_id INTO v_provider_org FROM provider_entity WHERE id = NEW.provider_entity_id;
  IF v_provider_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'hospice billing evidence provider entity must belong to its organization' USING ERRCODE='23514';
  END IF;
  IF current_user = 'chartwarden_app' THEN
    RAISE EXCEPTION 'hospice billing evidence requires the authorized evidence-verification writer' USING ERRCODE='42501';
  END IF;
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM medicaid_hospice_billing_evidence prior
     WHERE prior.organization_id = NEW.organization_id AND prior.id = NEW.supersedes_id
       AND prior.provider_entity_id = NEW.provider_entity_id AND prior.admission_id = NEW.admission_id
       AND prior.canonical_payer_id = NEW.canonical_payer_id AND prior.service_state = NEW.service_state
       AND prior.service_category = NEW.service_category AND prior.effective_from = NEW.effective_from
  ) THEN
    RAISE EXCEPTION 'hospice billing evidence correction must preserve the source identity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_hospice_billing_evidence_insert
  BEFORE INSERT ON medicaid_hospice_billing_evidence FOR EACH ROW
  EXECUTE FUNCTION guard_medicaid_hospice_billing_evidence_insert();--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_medicaid_hospice_billing_evidence_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN RAISE EXCEPTION 'medicaid_hospice_billing_evidence is append-only'; END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_hospice_billing_evidence_append_only
  BEFORE UPDATE OR DELETE ON medicaid_hospice_billing_evidence FOR EACH ROW
  EXECUTE FUNCTION guard_medicaid_hospice_billing_evidence_append_only();--> statement-breakpoint

CREATE TABLE medicaid_claim_line_pricing_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL REFERENCES provider_entity(id) ON DELETE RESTRICT,
  medicaid_claim_id uuid NOT NULL,
  medicaid_claim_line_id uuid NOT NULL,
  payer_rate_policy_id uuid NOT NULL,
  billing_evidence_id uuid NOT NULL,
  snapshot_schema_version integer NOT NULL DEFAULT 1,
  assessed_at timestamptz NOT NULL,
  fingerprint text NOT NULL,
  snapshot jsonb NOT NULL,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medicaid_claim_line_pricing_snapshot_line_uq UNIQUE (provider_entity_id, medicaid_claim_line_id),
  CONSTRAINT medicaid_claim_line_pricing_snapshot_line_fk
    FOREIGN KEY (medicaid_claim_line_id, provider_entity_id)
    REFERENCES medicaid_claim_line (id, provider_entity_id) ON DELETE RESTRICT,
  CONSTRAINT medicaid_claim_line_pricing_snapshot_rate_fk
    FOREIGN KEY (organization_id, payer_rate_policy_id)
    REFERENCES medicaid_payer_rate_policy (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT medicaid_claim_line_pricing_snapshot_evidence_fk
    FOREIGN KEY (organization_id, billing_evidence_id)
    REFERENCES medicaid_hospice_billing_evidence (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT medicaid_claim_line_pricing_snapshot_fingerprint CHECK
    (fingerprint ~ '^[0-9a-f]{64}$' AND snapshot_schema_version = 1),
  CONSTRAINT medicaid_claim_line_pricing_snapshot_shape CHECK
    (jsonb_typeof(snapshot) = 'object' AND snapshot ->> 'schemaVersion' = '1' AND
     snapshot ->> 'postingAuthorized' = 'false' AND snapshot ? 'assessmentTimestamp')
);--> statement-breakpoint
CREATE INDEX medicaid_claim_line_pricing_snapshot_claim_ix ON medicaid_claim_line_pricing_snapshot
  (organization_id, provider_entity_id, medicaid_claim_id);--> statement-breakpoint
CREATE INDEX medicaid_claim_line_pricing_snapshot_line_fk_ix ON medicaid_claim_line_pricing_snapshot
  (medicaid_claim_line_id, provider_entity_id);--> statement-breakpoint
CREATE INDEX medicaid_claim_line_pricing_snapshot_rate_fk_ix ON medicaid_claim_line_pricing_snapshot
  (organization_id, payer_rate_policy_id);--> statement-breakpoint
CREATE INDEX medicaid_claim_line_pricing_snapshot_evidence_fk_ix ON medicaid_claim_line_pricing_snapshot
  (organization_id, billing_evidence_id);--> statement-breakpoint
ALTER TABLE medicaid_claim_line_pricing_snapshot ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE medicaid_claim_line_pricing_snapshot FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY medicaid_claim_line_pricing_snapshot_org ON medicaid_claim_line_pricing_snapshot FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON medicaid_claim_line_pricing_snapshot TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON medicaid_claim_line_pricing_snapshot TO chartwarden_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_claim_line_pricing_snapshot_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_line medicaid_claim_line%ROWTYPE;
  v_rate medicaid_payer_rate_policy%ROWTYPE;
  v_evidence medicaid_hospice_billing_evidence%ROWTYPE;
  v_claim medicaid_claim%ROWTYPE;
BEGIN
  -- assessed_at is the column the temporal checks below use, so it must be the instant the JSON records, and it
  -- cannot lie in the future (five minutes of application clock skew are tolerated; clock_timestamp(), not now()).
  IF NEW.assessed_at IS DISTINCT FROM (NEW.snapshot ->> 'assessmentTimestamp')::timestamptz OR
     NEW.assessed_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'pricing snapshot assessed_at must equal its assessmentTimestamp and cannot be in the future' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_line FROM medicaid_claim_line
   WHERE id = NEW.medicaid_claim_line_id AND provider_entity_id = NEW.provider_entity_id;
  IF NOT FOUND OR v_line.organization_id IS DISTINCT FROM NEW.organization_id OR
     v_line.medicaid_claim_id IS DISTINCT FROM NEW.medicaid_claim_id OR
     v_line.payer_rate_policy_id_snapshot IS DISTINCT FROM NEW.payer_rate_policy_id OR
     v_line.is_rb OR v_line.state_rate_schedule_id_snapshot IS NOT NULL OR
     v_line.rate_at_assembly_cents IS DISTINCT FROM (NEW.snapshot ->> 'rateCents')::integer OR
     v_line.charges_cents IS DISTINCT FROM (NEW.snapshot ->> 'billedChargeCents')::integer OR
     (v_line.units::bigint * (NEW.snapshot ->> 'billedChargeCentsPerUnit')::bigint) IS DISTINCT FROM v_line.charges_cents::bigint OR
     v_line.units IS DISTINCT FROM (NEW.snapshot #>> '{quantity,units}')::integer OR
     NEW.snapshot #>> '{quantity,basis}' IS DISTINCT FROM 'per_day' OR
     v_line.level_of_care::text IS DISTINCT FROM NEW.snapshot ->> 'levelOfCare' OR
     v_line.revenue_code IS DISTINCT FROM NEW.snapshot ->> 'revenueCode' OR
     v_line.q_code IS DISTINCT FROM NEW.snapshot ->> 'hcpcsCode' OR
     v_line.level_of_care::text IS DISTINCT FROM 'RHC' OR
     (v_line.service_date AT TIME ZONE 'UTC')::date IS DISTINCT FROM (NEW.snapshot ->> 'serviceFrom')::date OR
     (v_line.service_date_to AT TIME ZONE 'UTC')::date IS DISTINCT FROM (NEW.snapshot ->> 'serviceTo')::date OR
     NEW.snapshot ->> 'claimLineId' IS DISTINCT FROM NEW.medicaid_claim_line_id::text OR
     NEW.snapshot ->> 'medicaidClaimId' IS DISTINCT FROM NEW.medicaid_claim_id::text OR
     NEW.snapshot ->> 'payerRatePolicyId' IS DISTINCT FROM NEW.payer_rate_policy_id::text OR
     NEW.snapshot ->> 'billingEvidenceId' IS DISTINCT FROM NEW.billing_evidence_id::text THEN
    RAISE EXCEPTION 'pricing snapshot identity or amounts do not match its claim line' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_rate FROM medicaid_payer_rate_policy
   WHERE organization_id = NEW.organization_id AND id = NEW.payer_rate_policy_id;
  IF NOT FOUND OR v_rate.provider_entity_id IS DISTINCT FROM NEW.provider_entity_id OR
     v_rate.verification_status IS DISTINCT FROM 'verified' OR
     v_rate.id IS DISTINCT FROM NEW.payer_rate_policy_id OR
     NEW.snapshot ->> 'rateVersion' IS DISTINCT FROM v_rate.version::text OR
     v_rate.rate_cents IS DISTINCT FROM (NEW.snapshot ->> 'rateCents')::integer OR
     v_rate.created_at > NEW.assessed_at OR
     v_rate.verified_at IS NULL OR v_rate.verified_at > NEW.assessed_at OR
     -- the per-day methodology the RHC snapshot supports (the application prices per_day and per_day
     -- fixed_contract_unit rates alike; the unit basis is compared with the other rate facts below)
     v_rate.pricing_method NOT IN ('per_day', 'fixed_contract_unit') OR
     v_rate.quantity_conversion_method IS DISTINCT FROM 'daily_units' OR
     -- a rate with a successor is no longer the head, as the pricing engine reads the chain; only a rejected
     -- draft never supersedes the active head (the engine skips rejected rows too)
     EXISTS (SELECT 1 FROM medicaid_payer_rate_policy successor
              WHERE successor.organization_id = v_rate.organization_id
                AND successor.supersedes_id = v_rate.id
                AND successor.verification_status <> 'rejected') THEN
    RAISE EXCEPTION 'pricing snapshot rate evidence is not current verified evidence' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_evidence FROM medicaid_hospice_billing_evidence
   WHERE organization_id = NEW.organization_id AND id = NEW.billing_evidence_id;
  IF NOT FOUND OR v_evidence.provider_entity_id IS DISTINCT FROM NEW.provider_entity_id OR
     v_evidence.verification_status IS DISTINCT FROM 'verified' OR
     EXISTS (SELECT 1 FROM medicaid_hospice_billing_evidence successor
              WHERE successor.organization_id = v_evidence.organization_id
                AND successor.supersedes_id = v_evidence.id) OR
     NEW.snapshot ->> 'billingEvidenceVersion' IS DISTINCT FROM v_evidence.version::text OR
     NEW.snapshot -> 'locality' ->> 'code' IS DISTINCT FROM v_evidence.locality_code OR
     NEW.snapshot -> 'locality' ->> 'evidenceReference' IS DISTINCT FROM v_evidence.locality_evidence_reference OR
     NEW.snapshot -> 'locality' ->> 'evidenceVersion' IS DISTINCT FROM v_evidence.locality_evidence_version::text OR
     NEW.snapshot -> 'qualityReporting' ->> 'evidenceReference' IS DISTINCT FROM v_evidence.quality_evidence_reference OR
     NEW.snapshot -> 'qualityReporting' ->> 'evidenceVersion' IS DISTINCT FROM v_evidence.quality_evidence_version::text OR
     NEW.snapshot ->> 'revenueCode' IS DISTINCT FROM v_evidence.revenue_code OR
     NEW.snapshot ->> 'hcpcsCode' IS DISTINCT FROM v_evidence.hcpcs_code OR
     NEW.snapshot ->> 'codingProfile' IS DISTINCT FROM v_evidence.coding_profile OR
     NEW.snapshot ->> 'codingEvidenceVersion' IS DISTINCT FROM v_evidence.coding_evidence_version::text OR
     NEW.snapshot ->> 'billedChargeCentsPerUnit' IS DISTINCT FROM v_evidence.billed_charge_cents_per_unit::text OR
     NEW.snapshot ->> 'chargeEvidenceVersion' IS DISTINCT FROM v_evidence.charge_evidence_version::text THEN
    RAISE EXCEPTION 'pricing snapshot billing evidence is not current verified evidence' USING ERRCODE='23514';
  END IF;
  IF v_evidence.verified_at IS NULL OR v_evidence.verified_at > NEW.assessed_at THEN
    RAISE EXCEPTION 'pricing snapshot cannot predate its billing evidence verification' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_claim FROM medicaid_claim
   WHERE organization_id = NEW.organization_id AND provider_entity_id = NEW.provider_entity_id
     AND id = NEW.medicaid_claim_id;
  IF NOT FOUND OR v_claim.patient_id IS DISTINCT FROM v_evidence.patient_id OR
     v_claim.admission_id IS DISTINCT FROM v_evidence.admission_id OR
     v_claim.canonical_payer_id IS DISTINCT FROM v_rate.canonical_payer_id OR
     v_claim.canonical_payer_id IS DISTINCT FROM v_evidence.canonical_payer_id OR
     v_claim.medicaid_program_kind::text IS DISTINCT FROM v_evidence.program_kind OR
     v_claim.service_state IS DISTINCT FROM v_evidence.service_state OR
     v_evidence.effective_from > (v_line.service_date AT TIME ZONE 'UTC')::date OR
     (v_evidence.effective_to IS NOT NULL AND v_evidence.effective_to < (v_line.service_date_to AT TIME ZONE 'UTC')::date) OR
     v_rate.canonical_payer_id IS DISTINCT FROM v_evidence.canonical_payer_id OR
     v_rate.program_kind IS DISTINCT FROM v_evidence.program_kind OR
     v_rate.service_state IS DISTINCT FROM v_evidence.service_state OR
     v_rate.locality_code IS DISTINCT FROM v_evidence.locality_code OR
     v_rate.quality_reporting_applicability IS DISTINCT FROM v_evidence.quality_reporting_applicability OR
     v_rate.quality_reporting_status IS DISTINCT FROM v_evidence.quality_reporting_status OR
     v_rate.service_category IS DISTINCT FROM 'RHC' OR v_rate.unit_basis IS DISTINCT FROM 'per_day' OR
     v_rate.effective_from > (v_line.service_date AT TIME ZONE 'UTC')::date OR
     (v_rate.effective_to IS NOT NULL AND v_rate.effective_to < (v_line.service_date_to AT TIME ZONE 'UTC')::date) OR
     NEW.fingerprint IS DISTINCT FROM encode(digest((NEW.snapshot - 'assessmentTimestamp')::text, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'pricing snapshot payer, service, range or integrity evidence does not match' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_claim_line_pricing_snapshot_insert
  BEFORE INSERT ON medicaid_claim_line_pricing_snapshot FOR EACH ROW
  EXECUTE FUNCTION guard_medicaid_claim_line_pricing_snapshot_insert();--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_medicaid_claim_line_pricing_snapshot_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN RAISE EXCEPTION 'medicaid_claim_line_pricing_snapshot is append-only'; END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_claim_line_pricing_snapshot_append_only
  BEFORE UPDATE OR DELETE ON medicaid_claim_line_pricing_snapshot FOR EACH ROW
  EXECUTE FUNCTION guard_medicaid_claim_line_pricing_snapshot_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION require_medicaid_priced_line_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.payer_rate_policy_id_snapshot IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM medicaid_claim_line_pricing_snapshot s
     WHERE s.provider_entity_id = NEW.provider_entity_id AND s.medicaid_claim_line_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'payer-rate-priced claim line requires an immutable pricing snapshot' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_medicaid_priced_line_requires_snapshot
  AFTER INSERT OR UPDATE ON medicaid_claim_line DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_medicaid_priced_line_snapshot();--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_priced_claim_line_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.payer_rate_policy_id_snapshot IS NOT NULL OR EXISTS (
    SELECT 1 FROM medicaid_claim_line_pricing_snapshot s
     WHERE s.provider_entity_id = OLD.provider_entity_id AND s.medicaid_claim_line_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'payer-rate-priced claim lines are immutable; assemble a new draft to correct pricing';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_priced_claim_line_immutable
  BEFORE UPDATE OR DELETE ON medicaid_claim_line FOR EACH ROW
  EXECUTE FUNCTION guard_medicaid_priced_claim_line_immutable();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_insert_medicaid_hospice_billing_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_after jsonb;
BEGIN
  v_after := audit_scrub(to_jsonb(NEW), ARRAY[
    'patient_id','admission_id','locality_evidence_reference','quality_evidence_reference',
    'coding_evidence_reference','charge_evidence_reference','source_document_reference'
  ]::text[]);
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    NEW.organization_id, NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'medicaid_hospice_billing_evidence.insert', TG_TABLE_NAME, NEW.id,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', NULL, v_after, '{}'::jsonb, 'compliance'
  );
  RETURN NEW;
END $$;--> statement-breakpoint
ALTER FUNCTION audit_insert_medicaid_hospice_billing_evidence() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER trg_audit_medicaid_hospice_billing_evidence
  AFTER INSERT ON medicaid_hospice_billing_evidence FOR EACH ROW
  EXECUTE FUNCTION audit_insert_medicaid_hospice_billing_evidence();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_insert_medicaid_claim_line_pricing_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    NEW.organization_id, NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'medicaid_claim_line_pricing_snapshot.insert', TG_TABLE_NAME, NEW.id,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', NULL,
    jsonb_build_object('medicaid_claim_id', NEW.medicaid_claim_id,
      'medicaid_claim_line_id', NEW.medicaid_claim_line_id, 'fingerprint', NEW.fingerprint,
      'snapshot_schema_version', NEW.snapshot_schema_version, 'posting_authorized', false),
    '{}'::jsonb, 'compliance'
  );
  RETURN NEW;
END $$;--> statement-breakpoint
ALTER FUNCTION audit_insert_medicaid_claim_line_pricing_snapshot() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER trg_audit_medicaid_claim_line_pricing_snapshot
  AFTER INSERT ON medicaid_claim_line_pricing_snapshot FOR EACH ROW
  EXECUTE FUNCTION audit_insert_medicaid_claim_line_pricing_snapshot();
