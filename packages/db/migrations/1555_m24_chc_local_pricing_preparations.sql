-- compat: contract
-- L8A.2C2: persist a narrowly supported home-CHC hourly local preparation separately from institutional
-- claim lines. It is append-only, never READY/submittable, and contains no clinical narrative or demographics.
-- CW-DS-01 remains open; this migration assigns no retention or erasure period.

ALTER TABLE medicaid_payer_rate_policy
  ADD COLUMN maximum_clinical_minutes integer;--> statement-breakpoint
ALTER TABLE medicaid_payer_rate_policy
  ADD CONSTRAINT medicaid_payer_rate_policy_maximum_clinical_minutes_valid
  CHECK (maximum_clinical_minutes IS NULL OR maximum_clinical_minutes BETWEEN 1 AND 1500);--> statement-breakpoint
ALTER TABLE medicaid_hospice_billing_evidence
  DROP CONSTRAINT medicaid_hospice_billing_evidence_state;--> statement-breakpoint
ALTER TABLE medicaid_hospice_billing_evidence
  ADD CONSTRAINT medicaid_hospice_billing_evidence_state CHECK (
    program_kind = 'managed_care' AND service_state = 'OR' AND service_category IN ('RHC', 'CHC')
  );--> statement-breakpoint
-- CHC local pricing has no qualified institutional revenue/HCPCS codes yet; keep both code facts absent.
-- The existing RHC evidence contract continues to require its code pair through the CHECK below.
ALTER TABLE medicaid_hospice_billing_evidence
  ALTER COLUMN revenue_code DROP NOT NULL,
  ALTER COLUMN hcpcs_code DROP NOT NULL;--> statement-breakpoint
ALTER TABLE medicaid_hospice_billing_evidence
  DROP CONSTRAINT medicaid_hospice_billing_evidence_pricing_facts;--> statement-breakpoint
ALTER TABLE medicaid_hospice_billing_evidence
  ADD CONSTRAINT medicaid_hospice_billing_evidence_pricing_facts CHECK (
    locality_code <> '' AND billed_charge_cents_per_unit > 0 AND coding_profile = 'local_draft_only' AND
    ((service_category = 'RHC' AND quantity_policy = 'active_rhc_loc_calendar_day' AND
      quantity_evidence_owner = 'm6_level_of_care_period' AND billing_unit = 'daily' AND
      revenue_code = '0651' AND hcpcs_code IN ('Q5001','Q5002')) OR
     (service_category = 'CHC' AND quantity_policy = 'm6_symptom_crisis_plus_signed_m8_rn_intervals_v1' AND
      quantity_evidence_owner = 'm6_loc_m8_encounter' AND billing_unit = 'hourly' AND
      revenue_code IS NULL AND hcpcs_code IS NULL))
  );--> statement-breakpoint

CREATE TABLE medicaid_chc_pricing_preparation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preparation_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL REFERENCES provider_entity(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL,
  admission_id uuid NOT NULL,
  service_date date NOT NULL,
  version integer NOT NULL,
  rate_policy_id uuid NOT NULL,
  billing_evidence_id uuid NOT NULL,
  assessed_at timestamptz NOT NULL,
  fingerprint text NOT NULL,
  snapshot jsonb NOT NULL,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medicaid_chc_pricing_preparation_scope_version_uq
    UNIQUE (organization_id, provider_entity_id, patient_id, admission_id, service_date, version),
  CONSTRAINT medicaid_chc_pricing_preparation_id_version_uq UNIQUE (preparation_id, version),
  CONSTRAINT medicaid_chc_pricing_preparation_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT medicaid_chc_pricing_preparation_rate_fk
    FOREIGN KEY (organization_id, rate_policy_id)
    REFERENCES medicaid_payer_rate_policy (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT medicaid_chc_pricing_preparation_billing_evidence_fk
    FOREIGN KEY (organization_id, billing_evidence_id)
    REFERENCES medicaid_hospice_billing_evidence (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT medicaid_chc_pricing_preparation_version_valid CHECK (version > 0),
  CONSTRAINT medicaid_chc_pricing_preparation_fingerprint_valid CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT medicaid_chc_pricing_preparation_snapshot_shape CHECK (
    jsonb_typeof(snapshot) = 'object' AND snapshot ->> 'schemaVersion' = '1' AND
    snapshot ->> 'profile' = 'home_chc_hourly_local_v1' AND
    snapshot ->> 'postingAuthorized' = 'false' AND
    snapshot ->> 'institutionalFormatQualified' = 'false' AND
    snapshot ->> 'institutionalUnits' = 'unqualified' AND
    snapshot ->> 'serviceDate' = service_date::text AND
    snapshot ->> 'preparationId' = preparation_id::text AND
    (snapshot ->> 'preparationVersion')::integer = version AND
    snapshot ->> 'organizationId' = organization_id::text AND
    snapshot ->> 'providerEntityId' = provider_entity_id::text AND
    snapshot ->> 'patientId' = patient_id::text AND snapshot ->> 'admissionId' = admission_id::text AND
    snapshot ->> 'ratePolicyId' = rate_policy_id::text AND
    snapshot ->> 'billingEvidenceId' = billing_evidence_id::text AND
    snapshot ->> 'integrityFingerprint' = fingerprint AND
    (snapshot ->> 'observedMinutes')::integer > 0 AND
    (snapshot ->> 'qualifiedMinutes')::integer = (snapshot ->> 'observedMinutes')::integer AND
    (snapshot ->> 'qualifiedMinutes')::integer % 60 = 0 AND
    (snapshot ->> 'qualifiedMinutes')::integer <= (snapshot ->> 'maximumClinicalMinutes')::integer AND
    ((snapshot ->> 'minimumClinicalMinutes') IS NULL OR
      (snapshot ->> 'qualifiedMinutes')::integer >= (snapshot ->> 'minimumClinicalMinutes')::integer) AND
    (snapshot ->> 'rateCentsPerHour')::integer > 0 AND
    (snapshot ->> 'billedChargeCentsPerHour')::integer > 0 AND
    (snapshot ->> 'estimatedReimbursementCents')::integer >= 0 AND
    (snapshot ->> 'billedChargeCents')::integer > 0 AND
    (snapshot ->> 'billedChargeCents')::bigint =
      (snapshot ->> 'billedChargeCentsPerHour')::bigint *
      ((snapshot ->> 'qualifiedMinutes')::bigint / 60) AND
    snapshot ->> 'codingProfile' = 'local_draft_only' AND
    snapshot ->> 'programKind' = 'managed_care' AND snapshot ->> 'serviceState' = 'OR' AND
    jsonb_typeof(snapshot -> 'programAssignment') = 'object' AND
    jsonb_typeof(snapshot -> 'payerProgramClassification') = 'object' AND
    jsonb_typeof(snapshot -> 'encounterSources') = 'array' AND
    jsonb_array_length(snapshot -> 'encounterSources') > 0
  )
);--> statement-breakpoint
CREATE INDEX medicaid_chc_pricing_preparation_scope_ix ON medicaid_chc_pricing_preparation
  (organization_id, provider_entity_id, patient_id, admission_id, service_date, version DESC);--> statement-breakpoint
CREATE INDEX medicaid_chc_pricing_preparation_rate_fk_ix ON medicaid_chc_pricing_preparation
  (organization_id, rate_policy_id);--> statement-breakpoint
CREATE INDEX medicaid_chc_pricing_preparation_evidence_fk_ix ON medicaid_chc_pricing_preparation
  (organization_id, billing_evidence_id);--> statement-breakpoint
ALTER TABLE medicaid_chc_pricing_preparation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE medicaid_chc_pricing_preparation FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY medicaid_chc_pricing_preparation_org ON medicaid_chc_pricing_preparation FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON medicaid_chc_pricing_preparation TO chartwarden_app;--> statement-breakpoint
GRANT SELECT ON medicaid_chc_pricing_preparation TO chartwarden_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_chc_pricing_preparation_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_org uuid;
  v_rate medicaid_payer_rate_policy%ROWTYPE;
  v_evidence medicaid_hospice_billing_evidence%ROWTYPE;
BEGIN
  SELECT organization_id INTO v_org FROM provider_entity WHERE id = NEW.provider_entity_id;
  IF v_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'CHC preparation provider entity must belong to its organization' USING ERRCODE='23514';
  END IF;
  IF (NEW.snapshot ->> 'assessedAt')::timestamptz IS DISTINCT FROM NEW.assessed_at THEN
    RAISE EXCEPTION 'CHC preparation assessment timestamp mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.snapshot ->> 'serviceTimeZone' IS NULL OR NEW.snapshot ->> 'serviceTimeZone' = '' OR
     NEW.snapshot ->> 'clinicalMethod' <> 'm6_symptom_crisis_plus_signed_m8_rn_intervals_v1' OR
     NEW.snapshot ->> 'locReason' <> 'symptom_crisis' OR
     NEW.snapshot ->> 'quantityConversionMethod' NOT IN ('hourly_prorated_minutes','hourly_each_hour_or_part') THEN
    RAISE EXCEPTION 'CHC preparation does not match the supported local profile' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_rate FROM medicaid_payer_rate_policy
   WHERE organization_id = NEW.organization_id AND id = NEW.rate_policy_id;
  IF NOT FOUND OR v_rate.provider_entity_id IS DISTINCT FROM NEW.provider_entity_id OR
     v_rate.canonical_payer_id::text IS DISTINCT FROM NEW.snapshot ->> 'canonicalPayerId' OR
     v_rate.program_kind <> 'managed_care' OR v_rate.service_state <> 'OR' OR
     v_rate.service_category <> 'CHC' OR v_rate.unit_basis <> 'per_hour' OR
     v_rate.verification_status <> 'verified' OR v_rate.effective_from > NEW.service_date OR
     v_rate.verified_at IS NULL OR v_rate.verified_at > NEW.assessed_at OR
     (v_rate.effective_to IS NOT NULL AND v_rate.effective_to < NEW.service_date) OR
     v_rate.version <> (NEW.snapshot ->> 'ratePolicyVersion')::integer OR
     v_rate.rate_cents <> (NEW.snapshot ->> 'rateCentsPerHour')::integer OR
     v_rate.quantity_conversion_method <> NEW.snapshot ->> 'quantityConversionMethod' OR
     v_rate.maximum_clinical_minutes IS DISTINCT FROM (NEW.snapshot ->> 'maximumClinicalMinutes')::integer OR
     v_rate.source_document_ref IS DISTINCT FROM NEW.snapshot ->> 'rateSourceReference' OR
     v_rate.quality_reporting_applicability IS DISTINCT FROM NEW.snapshot ->> 'qualityApplicability' OR
     v_rate.quality_reporting_status IS DISTINCT FROM NEW.snapshot ->> 'qualityStatus' THEN
    RAISE EXCEPTION 'CHC preparation rate evidence identity mismatch' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_evidence FROM medicaid_hospice_billing_evidence
   WHERE organization_id = NEW.organization_id AND id = NEW.billing_evidence_id;
  IF NOT FOUND OR v_evidence.provider_entity_id IS DISTINCT FROM NEW.provider_entity_id OR
     v_evidence.patient_id IS DISTINCT FROM NEW.patient_id OR
     v_evidence.admission_id IS DISTINCT FROM NEW.admission_id OR
     v_evidence.canonical_payer_id::text IS DISTINCT FROM NEW.snapshot ->> 'canonicalPayerId' OR
     v_evidence.program_kind <> 'managed_care' OR v_evidence.service_state <> 'OR' OR
     v_evidence.service_category <> 'CHC' OR v_evidence.billing_unit <> 'hourly' OR
     v_evidence.quantity_policy IS DISTINCT FROM NEW.snapshot ->> 'clinicalMethod' OR
     v_evidence.verification_status <> 'verified' OR v_evidence.effective_from > NEW.service_date OR
     v_evidence.verified_at IS NULL OR v_evidence.verified_at > NEW.assessed_at OR
     (v_evidence.effective_to IS NOT NULL AND v_evidence.effective_to < NEW.service_date) OR
     v_evidence.version <> (NEW.snapshot ->> 'billingEvidenceVersion')::integer OR
     v_evidence.locality_code IS DISTINCT FROM NEW.snapshot ->> 'localityCode' OR
     v_evidence.locality_evidence_reference IS DISTINCT FROM NEW.snapshot ->> 'localityEvidenceReference' OR
     v_evidence.locality_evidence_version <> (NEW.snapshot ->> 'localityEvidenceVersion')::integer OR
     v_evidence.quality_evidence_reference IS DISTINCT FROM NEW.snapshot ->> 'qualityEvidenceReference' OR
     v_evidence.quality_evidence_version <> (NEW.snapshot ->> 'qualityEvidenceVersion')::integer OR
     v_evidence.billed_charge_cents_per_unit <> (NEW.snapshot ->> 'billedChargeCentsPerHour')::integer OR
     v_evidence.charge_evidence_reference IS DISTINCT FROM NEW.snapshot ->> 'billedChargeEvidenceReference' OR
     v_evidence.charge_evidence_version <> (NEW.snapshot ->> 'billedChargeEvidenceVersion')::integer OR
     v_evidence.coding_profile IS DISTINCT FROM NEW.snapshot ->> 'codingProfile' OR
     v_evidence.coding_evidence_reference IS DISTINCT FROM NEW.snapshot ->> 'codingEvidenceReference' OR
     v_evidence.coding_evidence_version <> (NEW.snapshot ->> 'codingEvidenceVersion')::integer THEN
    RAISE EXCEPTION 'CHC preparation billing evidence identity mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_chc_pricing_preparation_identity
  BEFORE INSERT ON medicaid_chc_pricing_preparation FOR EACH ROW
  EXECUTE FUNCTION guard_medicaid_chc_pricing_preparation_identity();--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_medicaid_chc_pricing_preparation_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN RAISE EXCEPTION 'medicaid_chc_pricing_preparation is append-only'; END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_chc_pricing_preparation_append_only
  BEFORE UPDATE OR DELETE ON medicaid_chc_pricing_preparation FOR EACH ROW
  EXECUTE FUNCTION guard_medicaid_chc_pricing_preparation_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_insert_medicaid_chc_pricing_preparation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    NEW.organization_id, NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'medicaid_chc_pricing_preparation.insert', TG_TABLE_NAME, NEW.id,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', NULL,
    jsonb_build_object('preparation_id', NEW.preparation_id, 'version', NEW.version,
      'service_date', NEW.service_date, 'rate_policy_id', NEW.rate_policy_id,
      'billing_evidence_id', NEW.billing_evidence_id, 'fingerprint', NEW.fingerprint,
      'institutional_format_qualified', false, 'posting_authorized', false),
    '{}'::jsonb, 'compliance'
  );
  RETURN NEW;
END $$;--> statement-breakpoint
ALTER FUNCTION audit_insert_medicaid_chc_pricing_preparation() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER trg_audit_medicaid_chc_pricing_preparation
  AFTER INSERT ON medicaid_chc_pricing_preparation FOR EACH ROW
  EXECUTE FUNCTION audit_insert_medicaid_chc_pricing_preparation();--> statement-breakpoint
COMMENT ON TABLE medicaid_chc_pricing_preparation IS
  'Append-only M24 local home-CHC hourly pricing preparation. Never an institutional claim line, READY claim, or submission authorization.';
