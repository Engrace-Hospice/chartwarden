-- compat: contract
-- L8A.2C2: persist a narrowly supported home-CHC hourly local preparation separately from institutional
-- claim lines. It is append-only, never READY/submittable, and contains no clinical narrative or demographics.
-- CW-DS-01 remains open; this migration assigns no retention or erasure period.
-- Not database-enforced end to end: the guards are triggers, so a superuser or the table owner can disable them,
-- and row triggers do not fire on TRUNCATE (the same limit as migrations 1138, 1144 and 1551). The fingerprint is
-- bound to the snapshot's own copy and is not recomputed in SQL. Every table here is created by this batch or by
-- 1551, so a constraint added below scans no production row.

ALTER TABLE medicaid_payer_rate_policy
  ADD COLUMN maximum_clinical_minutes integer;--> statement-breakpoint
-- The pricing engine refuses more than 1440 clinical minutes in a service day, so no rate may promise more; a
-- maximum belongs only to a per-hour rate and never lies below its own minimum.
ALTER TABLE medicaid_payer_rate_policy
  ADD CONSTRAINT medicaid_payer_rate_policy_maximum_clinical_minutes_valid
  CHECK (maximum_clinical_minutes IS NULL OR (
    unit_basis = 'per_hour' AND maximum_clinical_minutes BETWEEN 1 AND 1440 AND
    (minimum_clinical_minutes IS NULL OR minimum_clinical_minutes <= maximum_clinical_minutes)
  ));--> statement-breakpoint
ALTER TABLE medicaid_hospice_billing_evidence
  DROP CONSTRAINT medicaid_hospice_billing_evidence_state;--> statement-breakpoint
ALTER TABLE medicaid_hospice_billing_evidence
  ADD CONSTRAINT medicaid_hospice_billing_evidence_state CHECK (
    program_kind = 'managed_care' AND service_state = 'OR' AND service_category IN ('RHC', 'CHC')
  );--> statement-breakpoint
-- CHC local pricing has no qualified institutional revenue/HCPCS codes yet; keep both code facts absent.
-- The existing RHC evidence contract continues to require its code pair through the CHECK below. IS TRUE: an RHC
-- row whose code is NULL makes its branch NULL, and a CHECK accepts NULL, so without it the pair would not be
-- required at all.
ALTER TABLE medicaid_hospice_billing_evidence
  ALTER COLUMN revenue_code DROP NOT NULL,
  ALTER COLUMN hcpcs_code DROP NOT NULL;--> statement-breakpoint
ALTER TABLE medicaid_hospice_billing_evidence
  DROP CONSTRAINT medicaid_hospice_billing_evidence_pricing_facts;--> statement-breakpoint
ALTER TABLE medicaid_hospice_billing_evidence
  ADD CONSTRAINT medicaid_hospice_billing_evidence_pricing_facts CHECK ((
    locality_code <> '' AND billed_charge_cents_per_unit > 0 AND coding_profile = 'local_draft_only' AND
    ((service_category = 'RHC' AND quantity_policy = 'active_rhc_loc_calendar_day' AND
      quantity_evidence_owner = 'm6_level_of_care_period' AND billing_unit = 'daily' AND
      revenue_code = '0651' AND hcpcs_code IN ('Q5001','Q5002')) OR
     (service_category = 'CHC' AND quantity_policy = 'm6_symptom_crisis_plus_signed_m8_rn_intervals_v1' AND
      quantity_evidence_owner = 'm6_loc_m8_encounter' AND billing_unit = 'hourly' AND
      revenue_code IS NULL AND hcpcs_code IS NULL))
  ) IS TRUE);--> statement-breakpoint

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
  -- IS TRUE: a snapshot missing a key makes an operand NULL, and a CHECK accepts NULL, so without it a
  -- document lacking postingAuthorized, the amounts or the identity would pass.
  CONSTRAINT medicaid_chc_pricing_preparation_snapshot_shape CHECK ((
    jsonb_typeof(snapshot) = 'object' AND snapshot ->> 'schemaVersion' = '1' AND
    snapshot ->> 'profile' = 'home_chc_hourly_local_v1' AND
    snapshot ->> 'postingAuthorized' = 'false' AND
    snapshot ->> 'institutionalFormatQualified' = 'false' AND
    snapshot ->> 'institutionalUnits' = 'unqualified' AND
    snapshot ->> 'serviceDate' = to_char(service_date, 'YYYY-MM-DD') AND
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
  ) IS TRUE)
);--> statement-breakpoint
CREATE INDEX medicaid_chc_pricing_preparation_scope_ix ON medicaid_chc_pricing_preparation
  (organization_id, provider_entity_id, patient_id, admission_id, service_date, version DESC);--> statement-breakpoint
CREATE INDEX medicaid_chc_pricing_preparation_patient_ix ON medicaid_chc_pricing_preparation
  (organization_id, patient_id, service_date DESC);--> statement-breakpoint
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
  v_prior_version integer;
  v_prior_preparation uuid;
BEGIN
  -- Well-formedness first: a malformed number or timestamp is a 23514 refusal here, not a 22xxx cast error from
  -- the CHECK or from a comparison below.
  BEGIN
    PERFORM (NEW.snapshot ->> 'assessedAt')::timestamptz,
            (NEW.snapshot ->> 'preparationVersion')::integer,
            (NEW.snapshot ->> 'observedMinutes')::integer,
            (NEW.snapshot ->> 'qualifiedMinutes')::integer,
            (NEW.snapshot ->> 'maximumClinicalMinutes')::integer,
            (NEW.snapshot ->> 'minimumClinicalMinutes')::integer,
            (NEW.snapshot ->> 'rateCentsPerHour')::integer,
            (NEW.snapshot ->> 'billedChargeCentsPerHour')::integer,
            (NEW.snapshot ->> 'estimatedReimbursementCents')::integer,
            (NEW.snapshot ->> 'billedChargeCents')::integer,
            (NEW.snapshot ->> 'ratePolicyVersion')::integer,
            (NEW.snapshot ->> 'billingEvidenceVersion')::integer,
            (NEW.snapshot ->> 'localityEvidenceVersion')::integer,
            (NEW.snapshot ->> 'qualityEvidenceVersion')::integer,
            (NEW.snapshot ->> 'billedChargeEvidenceVersion')::integer,
            (NEW.snapshot ->> 'codingEvidenceVersion')::integer;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR
                 invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'CHC preparation snapshot has a malformed number or timestamp' USING ERRCODE='23514';
  END;
  SELECT organization_id INTO v_org FROM provider_entity WHERE id = NEW.provider_entity_id;
  IF v_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'CHC preparation provider entity must belong to its organization' USING ERRCODE='23514';
  END IF;
  -- assessed_at is the instant the temporal checks below use, so it is the one the snapshot records, and it
  -- cannot lie in the future (five minutes of application clock skew are tolerated; clock_timestamp(), not now()).
  IF (NEW.snapshot ->> 'assessedAt')::timestamptz IS DISTINCT FROM NEW.assessed_at OR
     NEW.assessed_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'CHC preparation assessment timestamp mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.snapshot ->> 'serviceTimeZone' IS NULL OR NEW.snapshot ->> 'serviceTimeZone' = '' OR
     NEW.snapshot ->> 'clinicalMethod' IS DISTINCT FROM 'm6_symptom_crisis_plus_signed_m8_rn_intervals_v1' OR
     NEW.snapshot ->> 'locReason' IS DISTINCT FROM 'symptom_crisis' OR
     COALESCE(NEW.snapshot ->> 'quantityConversionMethod' NOT IN ('hourly_prorated_minutes','hourly_each_hour_or_part'), true) THEN
    RAISE EXCEPTION 'CHC preparation does not match the supported local profile' USING ERRCODE='23514';
  END IF;
  -- Versions of one service day are consecutive and share one preparation identity, and an identity belongs to
  -- one service day.
  SELECT COALESCE(max(p.version), 0) INTO v_prior_version FROM medicaid_chc_pricing_preparation p
   WHERE p.organization_id = NEW.organization_id AND p.provider_entity_id = NEW.provider_entity_id
     AND p.patient_id = NEW.patient_id AND p.admission_id = NEW.admission_id AND p.service_date = NEW.service_date;
  SELECT p.preparation_id INTO v_prior_preparation FROM medicaid_chc_pricing_preparation p
   WHERE p.organization_id = NEW.organization_id AND p.provider_entity_id = NEW.provider_entity_id
     AND p.patient_id = NEW.patient_id AND p.admission_id = NEW.admission_id AND p.service_date = NEW.service_date
   ORDER BY p.version DESC LIMIT 1;
  IF NEW.version IS DISTINCT FROM v_prior_version + 1 OR
     (v_prior_preparation IS NOT NULL AND v_prior_preparation IS DISTINCT FROM NEW.preparation_id) OR
     EXISTS (SELECT 1 FROM medicaid_chc_pricing_preparation p
              WHERE p.preparation_id = NEW.preparation_id
                AND (p.organization_id, p.provider_entity_id, p.patient_id, p.admission_id, p.service_date)
                    IS DISTINCT FROM
                    (NEW.organization_id, NEW.provider_entity_id, NEW.patient_id, NEW.admission_id, NEW.service_date)) THEN
    RAISE EXCEPTION 'CHC preparation versions must be consecutive within one service day and one identity' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_rate FROM medicaid_payer_rate_policy
   WHERE organization_id = NEW.organization_id AND id = NEW.rate_policy_id;
  IF NOT FOUND OR v_rate.provider_entity_id IS DISTINCT FROM NEW.provider_entity_id OR
     v_rate.canonical_payer_id::text IS DISTINCT FROM NEW.snapshot ->> 'canonicalPayerId' OR
     v_rate.program_kind IS DISTINCT FROM 'managed_care' OR v_rate.service_state IS DISTINCT FROM 'OR' OR
     v_rate.service_category IS DISTINCT FROM 'CHC' OR v_rate.unit_basis IS DISTINCT FROM 'per_hour' OR
     v_rate.verification_status IS DISTINCT FROM 'verified' OR v_rate.effective_from > NEW.service_date OR
     v_rate.verified_at IS NULL OR v_rate.verified_at > NEW.assessed_at OR
     v_rate.created_at > NEW.assessed_at OR
     (v_rate.effective_to IS NOT NULL AND v_rate.effective_to < NEW.service_date) OR
     v_rate.version IS DISTINCT FROM (NEW.snapshot ->> 'ratePolicyVersion')::integer OR
     v_rate.rate_cents IS DISTINCT FROM (NEW.snapshot ->> 'rateCentsPerHour')::integer OR
     v_rate.quantity_conversion_method IS DISTINCT FROM NEW.snapshot ->> 'quantityConversionMethod' OR
     -- the cap is mandatory for a CHC preparation, and the snapshot records the rate's own minimum and maximum
     v_rate.maximum_clinical_minutes IS NULL OR
     v_rate.maximum_clinical_minutes IS DISTINCT FROM (NEW.snapshot ->> 'maximumClinicalMinutes')::integer OR
     v_rate.minimum_clinical_minutes IS DISTINCT FROM (NEW.snapshot ->> 'minimumClinicalMinutes')::integer OR
     v_rate.source_document_ref IS DISTINCT FROM NEW.snapshot ->> 'rateSourceReference' OR
     v_rate.quality_reporting_applicability IS DISTINCT FROM NEW.snapshot ->> 'qualityApplicability' OR
     v_rate.quality_reporting_status IS DISTINCT FROM NEW.snapshot ->> 'qualityStatus' OR
     -- a rate with a successor is no longer the head; only a rejected draft never supersedes the active head
     EXISTS (SELECT 1 FROM medicaid_payer_rate_policy successor
              WHERE successor.organization_id = v_rate.organization_id
                AND successor.supersedes_id = v_rate.id
                AND successor.verification_status <> 'rejected') THEN
    RAISE EXCEPTION 'CHC preparation rate evidence identity mismatch' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_evidence FROM medicaid_hospice_billing_evidence
   WHERE organization_id = NEW.organization_id AND id = NEW.billing_evidence_id;
  IF NOT FOUND OR v_evidence.provider_entity_id IS DISTINCT FROM NEW.provider_entity_id OR
     v_evidence.patient_id IS DISTINCT FROM NEW.patient_id OR
     v_evidence.admission_id IS DISTINCT FROM NEW.admission_id OR
     v_evidence.canonical_payer_id::text IS DISTINCT FROM NEW.snapshot ->> 'canonicalPayerId' OR
     v_evidence.program_kind IS DISTINCT FROM 'managed_care' OR v_evidence.service_state IS DISTINCT FROM 'OR' OR
     v_evidence.service_category IS DISTINCT FROM 'CHC' OR v_evidence.billing_unit IS DISTINCT FROM 'hourly' OR
     v_evidence.quantity_policy IS DISTINCT FROM NEW.snapshot ->> 'clinicalMethod' OR
     v_evidence.verification_status IS DISTINCT FROM 'verified' OR v_evidence.effective_from > NEW.service_date OR
     v_evidence.verified_at IS NULL OR v_evidence.verified_at > NEW.assessed_at OR
     v_evidence.created_at > NEW.assessed_at OR
     (v_evidence.effective_to IS NOT NULL AND v_evidence.effective_to < NEW.service_date) OR
     EXISTS (SELECT 1 FROM medicaid_hospice_billing_evidence successor
              WHERE successor.organization_id = v_evidence.organization_id
                AND successor.supersedes_id = v_evidence.id) OR
     v_evidence.version IS DISTINCT FROM (NEW.snapshot ->> 'billingEvidenceVersion')::integer OR
     v_evidence.locality_code IS DISTINCT FROM NEW.snapshot ->> 'localityCode' OR
     v_evidence.locality_evidence_reference IS DISTINCT FROM NEW.snapshot ->> 'localityEvidenceReference' OR
     v_evidence.locality_evidence_version IS DISTINCT FROM (NEW.snapshot ->> 'localityEvidenceVersion')::integer OR
     v_evidence.quality_evidence_reference IS DISTINCT FROM NEW.snapshot ->> 'qualityEvidenceReference' OR
     v_evidence.quality_evidence_version IS DISTINCT FROM (NEW.snapshot ->> 'qualityEvidenceVersion')::integer OR
     v_evidence.billed_charge_cents_per_unit IS DISTINCT FROM (NEW.snapshot ->> 'billedChargeCentsPerHour')::integer OR
     v_evidence.charge_evidence_reference IS DISTINCT FROM NEW.snapshot ->> 'billedChargeEvidenceReference' OR
     v_evidence.charge_evidence_version IS DISTINCT FROM (NEW.snapshot ->> 'billedChargeEvidenceVersion')::integer OR
     v_evidence.coding_profile IS DISTINCT FROM NEW.snapshot ->> 'codingProfile' OR
     v_evidence.coding_evidence_reference IS DISTINCT FROM NEW.snapshot ->> 'codingEvidenceReference' OR
     v_evidence.coding_evidence_version IS DISTINCT FROM (NEW.snapshot ->> 'codingEvidenceVersion')::integer OR
     -- the rate and the evidence describe the same locality and quality-reporting variant
     v_rate.locality_code IS DISTINCT FROM v_evidence.locality_code OR
     v_rate.quality_reporting_applicability IS DISTINCT FROM v_evidence.quality_reporting_applicability OR
     v_rate.quality_reporting_status IS DISTINCT FROM v_evidence.quality_reporting_status OR
     v_rate.canonical_payer_id IS DISTINCT FROM v_evidence.canonical_payer_id THEN
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
      'rate_policy_id', NEW.rate_policy_id,
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
