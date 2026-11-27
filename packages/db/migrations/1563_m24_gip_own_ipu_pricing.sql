-- compat: contract
-- L8A.2C4 Checkpoint A: add one narrowly qualified own-IPU GIP daily local profile. The M37 reader
-- supplies the source projection inside the assembly/revalidation transaction; this SQL guard independently
-- binds the durable snapshot to the current M37 identity/version rows. No tariff or payer transmission is enabled.

ALTER TABLE medicaid_hospice_billing_evidence
  DROP CONSTRAINT medicaid_hospice_billing_evidence_state;--> statement-breakpoint
ALTER TABLE medicaid_hospice_billing_evidence
  ADD CONSTRAINT medicaid_hospice_billing_evidence_state CHECK (
    program_kind = 'managed_care' AND service_state = 'OR' AND
    service_category IN ('RHC', 'CHC', 'IRC', 'GIP')
  );--> statement-breakpoint
ALTER TABLE medicaid_hospice_billing_evidence
  DROP CONSTRAINT medicaid_hospice_billing_evidence_pricing_facts;--> statement-breakpoint
ALTER TABLE medicaid_hospice_billing_evidence
  ADD CONSTRAINT medicaid_hospice_billing_evidence_pricing_facts CHECK ((
    locality_code <> '' AND billed_charge_cents_per_unit > 0 AND coding_profile = 'local_draft_only' AND
    ((service_category = 'RHC' AND quantity_policy = 'active_rhc_loc_calendar_day' AND
      quantity_evidence_owner = 'm6_level_of_care_period' AND billing_unit = 'daily' AND
      revenue_code = '0651' AND hcpcs_code IN ('Q5001', 'Q5002')) OR
     (service_category = 'CHC' AND quantity_policy = 'm6_symptom_crisis_plus_signed_m8_rn_intervals_v1' AND
      quantity_evidence_owner = 'm6_loc_m8_encounter' AND billing_unit = 'hourly' AND
      revenue_code IS NULL AND hcpcs_code IS NULL) OR
     (service_category = 'IRC' AND quantity_policy = 'm37_irc_episode_daily_v1' AND
      quantity_evidence_owner = 'm37_irc_episode_and_remote_stay' AND billing_unit = 'daily' AND
      revenue_code = '0655' AND hcpcs_code = 'Q5005') OR
     (service_category = 'GIP' AND quantity_policy = 'm37_gip_own_unit_daily_v1' AND
      quantity_evidence_owner = 'm37_gip_admission_criteria_and_confirmed_bed_history' AND
      billing_unit = 'daily' AND revenue_code = '0656' AND hcpcs_code = 'Q5006'))
  ) IS TRUE);--> statement-breakpoint

ALTER TABLE medicaid_claim_line_pricing_snapshot
  DROP CONSTRAINT medicaid_claim_line_pricing_snapshot_fingerprint;--> statement-breakpoint
ALTER TABLE medicaid_claim_line_pricing_snapshot
  ADD CONSTRAINT medicaid_claim_line_pricing_snapshot_fingerprint CHECK (
    fingerprint ~ '^[0-9a-f]{64}$' AND snapshot_schema_version IN (1, 2, 3, 4, 5)
  );--> statement-breakpoint
ALTER TABLE medicaid_claim_line_pricing_snapshot
  DROP CONSTRAINT medicaid_claim_line_pricing_snapshot_shape;--> statement-breakpoint
ALTER TABLE medicaid_claim_line_pricing_snapshot
  ADD CONSTRAINT medicaid_claim_line_pricing_snapshot_shape CHECK ((
    jsonb_typeof(snapshot) = 'object' AND snapshot ->> 'schemaVersion' = snapshot_schema_version::text AND
    snapshot ->> 'postingAuthorized' = 'false' AND snapshot ? 'assessmentTimestamp' AND
    ((snapshot_schema_version = 1 AND snapshot ->> 'hcpcsCode' = 'Q5001' AND
      snapshot #>> '{serviceLocation,kind}' = 'home' AND snapshot #>> '{serviceLocation,facilityId}' IS NULL AND
      NOT (snapshot ? 'localBillingProfile')) OR
     (snapshot_schema_version = 2 AND snapshot ->> 'hcpcsCode' = 'Q5002' AND
      snapshot ->> 'localBillingProfile' = 'rhc_assisted_living_q5002_daily_v1' AND
      snapshot #>> '{serviceLocation,kind}' = 'facility' AND
      snapshot #>> '{serviceLocation,facilityKind}' = 'alf' AND snapshot #>> '{serviceLocation,facilityId}' IS NOT NULL) OR
     (snapshot_schema_version = 3 AND snapshot ->> 'hcpcsCode' = 'Q5001' AND
      snapshot ->> 'localBillingProfile' = 'rhc_home_election_bucket_daily_v1' AND
      snapshot #>> '{serviceLocation,kind}' = 'home' AND snapshot #>> '{serviceLocation,facilityId}' IS NULL AND
      snapshot #>> '{electionDay,basis}' = 'current_signed_election_calendar_days_v1' AND
      snapshot #>> '{electionDay,historyEvidenceId}' IS NOT NULL AND
      snapshot #>> '{electionDay,historyEvidenceVersion}' ~ '^[1-9][0-9]*$' AND
      snapshot #>> '{electionDay,historyFingerprint}' ~ '^[0-9a-f]{64}$' AND
      snapshot #>> '{electionDay,dayFrom}' ~ '^[1-9][0-9]*$' AND
      snapshot #>> '{electionDay,dayTo}' ~ '^[1-9][0-9]*$' AND
      (snapshot #>> '{electionDay,dayTo}')::integer >= (snapshot #>> '{electionDay,dayFrom}')::integer AND
      snapshot #>> '{electionDay,rateBucketFrom}' ~ '^[1-9][0-9]*$' AND
      (snapshot #>> '{electionDay,dayFrom}')::integer >= (snapshot #>> '{electionDay,rateBucketFrom}')::integer AND
      ((snapshot #>> '{electionDay,rateBucketTo}') IS NULL OR
       (snapshot #>> '{electionDay,dayTo}')::integer <= (snapshot #>> '{electionDay,rateBucketTo}')::integer)) OR
     (snapshot_schema_version = 4 AND snapshot ->> 'profile' = 'irc_hospital_q5005_daily_local_v1' AND
      snapshot ->> 'localBillingProfile' = 'irc_hospital_q5005_daily_local_v1' AND
      snapshot ->> 'institutionalFormatQualified' = 'false' AND snapshot ->> 'levelOfCare' = 'IRC' AND
      snapshot ->> 'revenueCode' = '0655' AND snapshot ->> 'hcpcsCode' = 'Q5005' AND
      snapshot #>> '{serviceLocation,kind}' = 'facility' AND
      snapshot #>> '{serviceLocation,facilityKind}' = 'hospital' AND
      snapshot #>> '{serviceLocation,facilityId}' IS NOT NULL AND
      snapshot #>> '{episode,episodeId}' IS NOT NULL AND snapshot #>> '{episode,remoteStayId}' IS NOT NULL AND
      snapshot #>> '{episode,serviceTimeZone}' IS NOT NULL AND
      snapshot #>> '{episode,consecutiveDayFrom}' ~ '^[1-9][0-9]*$' AND
      snapshot #>> '{episode,consecutiveDayTo}' ~ '^[1-9][0-9]*$' AND
      snapshot ->> 'locPeriodVersion' ~ '^[0-9]+$' AND snapshot ->> 'locEvidenceUpdatedAt' IS NOT NULL AND
      snapshot #>> '{quantity,basis}' = 'per_day' AND
      snapshot #>> '{quantity,units}' ~ '^[1-9][0-9]*$' AND
      snapshot ->> 'reimbursementEstimateCents' ~ '^[0-9]+$' AND
      snapshot ->> 'billedChargeCents' ~ '^[1-9][0-9]*$') OR
     (snapshot_schema_version = 5 AND snapshot ->> 'profile' = 'gip_own_ipu_q5006_daily_local_v1' AND
      snapshot ->> 'localBillingProfile' = 'gip_own_ipu_q5006_daily_local_v1' AND
      snapshot ->> 'institutionalFormatQualified' = 'false' AND snapshot ->> 'levelOfCare' = 'GIP' AND
      snapshot ->> 'revenueCode' = '0656' AND snapshot ->> 'hcpcsCode' = 'Q5006' AND
      snapshot #>> '{serviceLocation,kind}' = 'facility' AND
      snapshot #>> '{serviceLocation,facilityKind}' = 'ipu' AND
      snapshot #>> '{serviceLocation,facilityId}' IS NOT NULL AND
      snapshot #>> '{serviceLocation,unitId}' IS NOT NULL AND
      snapshot #>> '{serviceLocation,locationId}' IS NOT NULL AND
      snapshot #>> '{serviceLocation,timeZone}' IS NOT NULL AND
      snapshot #>> '{gipStay,ipuAdmissionId}' IS NOT NULL AND
      snapshot #>> '{gipStay,bedAssignmentId}' IS NOT NULL AND
      snapshot #>> '{gipStay,criteriaId}' IS NOT NULL AND
      snapshot #>> '{quantity,basis}' = 'per_day' AND
      snapshot #>> '{quantity,units}' ~ '^[1-9][0-9]*$' AND
      snapshot ->> 'reimbursementEstimateCents' ~ '^[0-9]+$' AND
      snapshot ->> 'billedChargeCents' ~ '^[1-9][0-9]*$'))
  ) IS TRUE);--> statement-breakpoint

-- Preserve the published v1-v3 and v4 validators. Version 5 gets its own profile and source guards.
DROP TRIGGER IF EXISTS trg_medicaid_claim_line_pricing_snapshot_insert ON medicaid_claim_line_pricing_snapshot;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_claim_line_pricing_snapshot_insert
  BEFORE INSERT ON medicaid_claim_line_pricing_snapshot
  FOR EACH ROW WHEN (NEW.snapshot_schema_version NOT IN (4, 5))
  EXECUTE FUNCTION guard_medicaid_claim_line_pricing_snapshot_insert();--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_medicaid_claim_line_pricing_snapshot_supported_profile ON medicaid_claim_line_pricing_snapshot;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_claim_line_pricing_snapshot_supported_profile
  BEFORE INSERT ON medicaid_claim_line_pricing_snapshot
  FOR EACH ROW WHEN (NEW.snapshot_schema_version <> 5)
  EXECUTE FUNCTION guard_medicaid_claim_line_pricing_snapshot_supported_profile();--> statement-breakpoint

CREATE OR REPLACE FUNCTION m37_gip_own_unit_pricing_source_valid(
  p_organization_id uuid, p_provider_entity_id uuid, p_patient_id uuid, p_admission_id uuid,
  p_loc_period_id uuid, p_snapshot jsonb, p_assessed_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_ipu_id uuid;
  v_unit_id uuid;
  v_bed_id uuid;
  v_assignment_id uuid;
  v_location_id uuid;
  v_facility_id uuid;
  v_criteria_id uuid;
  v_service_from date;
  v_service_to date;
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
  v_admission record;
  v_criteria record;
  v_item jsonb;
  v_item_date date;
  v_item_id uuid;
  v_item_version integer;
  v_item_verified_at timestamptz;
  v_matches integer;
  v_facility record;
  v_latest_reassessment record;
  v_day_start timestamptz;
  v_day_end timestamptz;
BEGIN
  BEGIN
    v_ipu_id := (p_snapshot #>> '{gipStay,ipuAdmissionId}')::uuid;
    v_unit_id := (p_snapshot #>> '{gipStay,unitId}')::uuid;
    v_bed_id := (p_snapshot #>> '{gipStay,bedId}')::uuid;
    v_assignment_id := (p_snapshot #>> '{gipStay,bedAssignmentId}')::uuid;
    v_location_id := (p_snapshot #>> '{gipStay,locationId}')::uuid;
    v_facility_id := (p_snapshot #>> '{gipStay,facilityId}')::uuid;
    v_criteria_id := (p_snapshot #>> '{gipStay,criteriaId}')::uuid;
    v_service_from := (p_snapshot ->> 'serviceFrom')::date;
    v_service_to := (p_snapshot ->> 'serviceTo')::date;
    v_item_version := 0;
  EXCEPTION WHEN OTHERS THEN
    RETURN false;
  END;
  IF v_service_from > v_service_to OR jsonb_typeof(p_snapshot #> '{gipStay,dailyEvidence}') <> 'array' THEN
    RETURN false;
  END IF;
  SELECT i.id, i.organization_id, i.provider_entity_id, i.patient_id, i.admission_id,
         i.level_of_care_period_id, i.kind, i.state, i.activated_at, i.closed_at, i.version, i.updated_at,
         u.id AS unit_id, u.facility_id, u.version AS unit_version, u.updated_at AS unit_updated_at,
         loc.id AS location_id, loc.provider_entity_id AS location_provider_id, loc.state AS location_state,
         loc.status AS location_status, loc.timezone
    INTO v_admission
    FROM ipu_admission i
    JOIN inpatient_unit u ON u.id = i.unit_id AND u.organization_id = i.organization_id
    JOIN ipu_bed_assignment ba ON ba.ipu_admission_id = i.id AND ba.id = v_assignment_id
      AND ba.bed_id = v_bed_id AND ba.organization_id = i.organization_id
    JOIN ipu_bed b ON b.id = ba.bed_id AND b.unit_id = u.id AND b.organization_id = i.organization_id
    JOIN ipu_room r ON r.id = b.room_id AND r.unit_id = u.id AND r.organization_id = i.organization_id
    JOIN location loc ON loc.id = i.location_id
   WHERE i.id = v_ipu_id AND i.organization_id = p_organization_id AND
     i.provider_entity_id = p_provider_entity_id AND i.patient_id = p_patient_id AND
     i.admission_id = p_admission_id AND i.level_of_care_period_id = p_loc_period_id AND i.kind = 'gip' AND
     u.id = v_unit_id AND u.facility_id = v_facility_id AND loc.id = v_location_id
   FOR SHARE OF i, u, ba, b, r, loc;
  IF NOT FOUND OR v_admission.state NOT IN ('active', 'discharged', 'deceased', 'closed') OR
     v_admission.activated_at IS NULL OR v_admission.activated_at > p_assessed_at OR
     v_admission.updated_at > p_assessed_at OR v_admission.unit_updated_at > p_assessed_at OR
     v_admission.version <> (p_snapshot #>> '{gipStay,ipuAdmissionVersion}')::bigint OR
     v_admission.unit_version <> (p_snapshot #>> '{gipStay,unitVersion}')::bigint OR
     v_admission.location_provider_id IS DISTINCT FROM p_provider_entity_id OR
     v_admission.location_state <> 'OR' OR v_admission.location_status <> 'active' OR
     v_admission.timezone IS DISTINCT FROM p_snapshot #>> '{gipStay,serviceTimeZone}' OR
     v_admission.facility_id IS DISTINCT FROM (p_snapshot #>> '{serviceLocation,facilityId}')::uuid OR
     v_admission.closed_at IS NOT NULL AND v_admission.closed_at <
       ((v_service_to + 1)::timestamp AT TIME ZONE v_admission.timezone) OR
     v_admission.activated_at > (v_service_from::timestamp AT TIME ZONE v_admission.timezone) THEN
    RETURN false;
  END IF;
  v_start := v_service_from::timestamp AT TIME ZONE v_admission.timezone;
  v_end := (v_service_to + 1)::timestamp AT TIME ZONE v_admission.timezone;
  SELECT count(*)::integer INTO v_matches FROM ipu_bed_assignment ba
   WHERE ba.organization_id = p_organization_id AND ba.ipu_admission_id = v_ipu_id AND
     ba.assigned_at < v_end AND (ba.ended_at IS NULL OR ba.ended_at > v_start);
  IF v_matches <> 1 OR NOT EXISTS (
    SELECT 1 FROM ipu_bed_assignment ba WHERE ba.organization_id = p_organization_id AND
      ba.ipu_admission_id = v_ipu_id AND ba.id = v_assignment_id AND ba.bed_id = v_bed_id AND
      ba.assigned_at <= v_start AND (ba.ended_at IS NULL OR ba.ended_at >= v_end) AND
      ba.version = (p_snapshot #>> '{gipStay,bedAssignmentVersion}')::bigint AND ba.updated_at <= p_assessed_at
  ) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM ipu_admission_transition t WHERE t.organization_id = p_organization_id AND
      t.ipu_admission_id = v_ipu_id AND t.initiated_at < v_end AND
      COALESCE(t.completed_at, t.initiated_at) >= v_start) THEN RETURN false; END IF;
  SELECT c.id, c.version, c.criterion_kind, c.attested_at, c.updated_at INTO v_criteria
    FROM gip_admission_criteria c WHERE c.organization_id = p_organization_id AND
      c.ipu_admission_id = v_ipu_id AND c.id = v_criteria_id FOR SHARE;
  IF NOT FOUND OR v_criteria.version <> (p_snapshot #>> '{gipStay,criteriaVersion}')::bigint OR
     v_criteria.criterion_kind::text IS DISTINCT FROM p_snapshot #>> '{gipStay,criteriaKind}' OR
     v_criteria.attested_at > p_assessed_at OR v_criteria.updated_at > p_assessed_at THEN RETURN false; END IF;
  IF jsonb_array_length(p_snapshot #> '{gipStay,dailyEvidence}') <> (v_service_to - v_service_from + 1) OR
     (SELECT count(DISTINCT e.value ->> 'serviceDate') FROM jsonb_array_elements(p_snapshot #> '{gipStay,dailyEvidence}') e)
       <> (v_service_to - v_service_from + 1) THEN RETURN false; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_snapshot #> '{gipStay,dailyEvidence}') LOOP
    BEGIN
      v_item_date := (v_item ->> 'serviceDate')::date;
      v_item_id := (v_item ->> 'sourceId')::uuid;
      v_item_version := (v_item ->> 'sourceVersion')::integer;
      v_item_verified_at := (v_item ->> 'verifiedAt')::timestamptz;
    EXCEPTION WHEN OTHERS THEN RETURN false; END;
    v_day_start := v_item_date::timestamp AT TIME ZONE v_admission.timezone;
    v_day_end := (v_item_date + 1)::timestamp AT TIME ZONE v_admission.timezone;
    IF v_item_date < v_service_from OR v_item_date > v_service_to OR v_item_version <= 0 OR
       v_item_verified_at > p_assessed_at OR
       v_item_verified_at < v_day_start OR v_item_verified_at >= v_day_end THEN RETURN false; END IF;
    SELECT count(*)::integer INTO v_matches FROM gip_criteria_reassessment cr
      WHERE cr.organization_id = p_organization_id AND cr.ipu_admission_id = v_ipu_id
        AND cr.gip_admission_criteria_id = v_criteria_id AND cr.assessed_at < v_day_end
        AND cr.assessed_at <= p_assessed_at;
    IF v_matches > 0 THEN
      SELECT cr.id, cr.version, cr.assessed_at, cr.criterion_still_met INTO v_latest_reassessment
        FROM gip_criteria_reassessment cr
       WHERE cr.organization_id = p_organization_id AND cr.ipu_admission_id = v_ipu_id
         AND cr.gip_admission_criteria_id = v_criteria_id AND cr.assessed_at < v_day_end
         AND cr.assessed_at <= p_assessed_at
       ORDER BY cr.assessed_at DESC LIMIT 1 FOR SHARE;
      IF EXISTS (
        SELECT 1 FROM gip_criteria_reassessment cr
         WHERE cr.organization_id = p_organization_id AND cr.ipu_admission_id = v_ipu_id
           AND cr.gip_admission_criteria_id = v_criteria_id
           AND cr.assessed_at = v_latest_reassessment.assessed_at
           AND cr.id <> v_latest_reassessment.id
      ) OR NOT v_latest_reassessment.criterion_still_met OR
         v_item_id <> v_latest_reassessment.id OR
         v_item_version <> v_latest_reassessment.version OR
         v_item_verified_at <> v_latest_reassessment.assessed_at THEN RETURN false; END IF;
    ELSE
      IF v_criteria.attested_at < v_day_start OR v_criteria.attested_at >= v_day_end OR
         v_item_id <> v_criteria_id OR v_item_version <> v_criteria.version OR
         v_item_verified_at <> v_criteria.attested_at THEN RETURN false; END IF;
    END IF;
  END LOOP;
  SELECT resolved_facility_id, facility_kind, facility_status INTO v_facility
    FROM m40_facility_kind_for_ids_locked(jsonb_build_array(v_facility_id));
  RETURN FOUND AND v_facility.resolved_facility_id = v_facility_id AND
    v_facility.facility_kind = 'ipu' AND v_facility.facility_status = 'active';
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION m37_gip_own_unit_pricing_source_valid(uuid, uuid, uuid, uuid, uuid, jsonb, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m37_gip_own_unit_pricing_source_valid(uuid, uuid, uuid, uuid, uuid, jsonb, timestamptz) TO chartwarden_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_claim_line_pricing_snapshot_supported_profile_gip() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.snapshot_schema_version <> 5 OR
     NEW.snapshot ->> 'profile' IS DISTINCT FROM 'gip_own_ipu_q5006_daily_local_v1' OR
     NEW.snapshot ->> 'localBillingProfile' IS DISTINCT FROM 'gip_own_ipu_q5006_daily_local_v1' OR
     NEW.snapshot ->> 'levelOfCare' IS DISTINCT FROM 'GIP' OR
     NEW.snapshot ->> 'revenueCode' IS DISTINCT FROM '0656' OR
     NEW.snapshot ->> 'hcpcsCode' IS DISTINCT FROM 'Q5006' OR
     NEW.snapshot ->> 'institutionalFormatQualified' IS DISTINCT FROM 'false' OR
     NEW.snapshot #>> '{serviceLocation,facilityKind}' IS DISTINCT FROM 'ipu' OR
     NEW.snapshot #>> '{quantity,basis}' IS DISTINCT FROM 'per_day' OR
     NEW.snapshot #>> '{quantity,units}' !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'pricing snapshot v5 is restricted to the own-IPU GIP local daily profile' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_claim_line_pricing_snapshot_supported_profile_gip
  BEFORE INSERT ON medicaid_claim_line_pricing_snapshot
  FOR EACH ROW WHEN (NEW.snapshot_schema_version = 5)
  EXECUTE FUNCTION guard_medicaid_claim_line_pricing_snapshot_supported_profile_gip();--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_claim_line_pricing_snapshot_insert_gip() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_claim medicaid_claim%ROWTYPE;
  v_line medicaid_claim_line%ROWTYPE;
  v_rate medicaid_payer_rate_policy%ROWTYPE;
  v_evidence medicaid_hospice_billing_evidence%ROWTYPE;
  v_units integer;
  v_from date;
  v_to date;
BEGIN
  IF NEW.snapshot_schema_version <> 5 OR NEW.assessed_at IS DISTINCT FROM
      (NEW.snapshot ->> 'assessmentTimestamp')::timestamptz OR
      NEW.assessed_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'GIP pricing snapshot assessment identity is invalid' USING ERRCODE='23514';
  END IF;
  BEGIN
    v_from := (NEW.snapshot ->> 'serviceFrom')::date;
    v_to := (NEW.snapshot ->> 'serviceTo')::date;
    v_units := (NEW.snapshot #>> '{quantity,units}')::integer;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'GIP pricing snapshot service or quantity facts are invalid' USING ERRCODE='23514';
  END;
  SELECT * INTO v_claim FROM medicaid_claim WHERE organization_id = NEW.organization_id
    AND provider_entity_id = NEW.provider_entity_id AND id = NEW.medicaid_claim_id FOR SHARE;
  SELECT * INTO v_line FROM medicaid_claim_line WHERE organization_id = NEW.organization_id
    AND provider_entity_id = NEW.provider_entity_id AND id = NEW.medicaid_claim_line_id
    AND medicaid_claim_id = NEW.medicaid_claim_id FOR SHARE;
  IF NOT FOUND OR v_claim.id IS NULL OR v_claim.state <> 'DRAFT' OR v_claim.kind <> 'hospice_only' OR
     v_claim.rb_arrangement_id IS NOT NULL OR v_claim.patient_id::text IS DISTINCT FROM NEW.snapshot ->> 'patientId' OR
     v_claim.admission_id::text IS DISTINCT FROM NEW.snapshot ->> 'admissionId' OR
     v_claim.canonical_payer_id::text IS DISTINCT FROM NEW.snapshot ->> 'canonicalPayerId' OR
     v_claim.medicaid_program_kind::text <> 'managed_care' OR v_claim.service_state <> 'OR' OR
     v_line.is_rb OR v_line.level_of_care <> 'GIP' OR v_line.revenue_code <> '0656' OR
     v_line.q_code <> 'Q5006' OR v_line.service_date::date <> v_from OR
     v_line.service_date_to IS NULL OR v_line.service_date_to::date <> v_to OR
     v_from > v_to OR v_units <> v_to - v_from + 1 OR
     v_line.units <> v_units OR v_line.loc_period_id::text IS DISTINCT FROM NEW.snapshot ->> 'locPeriodId' OR
     v_line.rate_at_assembly_cents <> (NEW.snapshot ->> 'rateCents')::integer OR
     v_line.charges_cents <> (NEW.snapshot ->> 'billedChargeCents')::integer OR
     v_line.payer_rate_policy_id_snapshot IS DISTINCT FROM NEW.payer_rate_policy_id OR
     v_line.state_rate_schedule_id_snapshot IS NOT NULL OR NEW.snapshot ->> 'postingAuthorized' <> 'false' OR
     NEW.snapshot ->> 'claimLineId' IS DISTINCT FROM NEW.medicaid_claim_line_id::text OR
     NEW.snapshot ->> 'medicaidClaimId' IS DISTINCT FROM NEW.medicaid_claim_id::text OR
     NEW.snapshot ->> 'payerRatePolicyId' IS DISTINCT FROM NEW.payer_rate_policy_id::text OR
     NEW.snapshot ->> 'billingEvidenceId' IS DISTINCT FROM NEW.billing_evidence_id::text OR
     v_claim.created_at > NEW.assessed_at THEN
    RAISE EXCEPTION 'GIP pricing snapshot identity or amounts do not match its local draft line' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'm24-rate-policy:' || NEW.organization_id::text || ':' || NEW.provider_entity_id::text || ':' ||
    v_claim.canonical_payer_id::text || ':' || v_claim.service_state, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'm24-hospice-evidence:' || NEW.organization_id::text || ':' || NEW.provider_entity_id::text || ':' ||
    v_claim.patient_id::text || ':' || v_claim.admission_id::text || ':' || v_claim.canonical_payer_id::text ||
    ':managed_care:' || v_claim.service_state || ':GIP', 0));
  SELECT * INTO v_rate FROM medicaid_payer_rate_policy WHERE organization_id = NEW.organization_id
    AND id = NEW.payer_rate_policy_id AND provider_entity_id = NEW.provider_entity_id
    AND canonical_payer_id = v_claim.canonical_payer_id AND program_kind = 'managed_care' AND
    service_state = 'OR' AND service_category = 'GIP' AND unit_basis = 'per_day' AND
    bucket_from IS NULL AND bucket_to IS NULL AND election_day_basis = 'unqualified' AND
    verification_status = 'verified' AND pricing_method = 'per_day' AND
    quantity_conversion_method = 'daily_units' AND charge_ceiling_method = 'none' AND
    charge_ceiling_cents IS NULL AND effective_from <= v_from AND
    (effective_to IS NULL OR effective_to >= v_to) AND version = (NEW.snapshot ->> 'rateVersion')::integer
    AND verified_at <= NEW.assessed_at AND created_at <= NEW.assessed_at;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM medicaid_payer_rate_policy newer WHERE
    newer.organization_id = v_rate.organization_id AND newer.provider_entity_id = v_rate.provider_entity_id AND
    newer.canonical_payer_id = v_rate.canonical_payer_id AND newer.program_kind = v_rate.program_kind AND
    newer.service_state = v_rate.service_state AND newer.service_category = v_rate.service_category AND
    newer.locality_code = v_rate.locality_code AND newer.unit_basis = v_rate.unit_basis AND
    newer.effective_from = v_rate.effective_from AND newer.version > v_rate.version) OR
    v_rate.rate_cents <> (NEW.snapshot ->> 'rateCents')::integer OR
    v_rate.locality_code IS DISTINCT FROM NEW.snapshot #>> '{locality,code}' OR
    v_rate.rate_cents::bigint * v_units <> (NEW.snapshot ->> 'reimbursementEstimateCents')::bigint OR
    v_rate.rate_cents::bigint * v_units <> (NEW.snapshot ->> 'baseReimbursementCents')::bigint OR
    NEW.snapshot #>> '{appliedCeilings}' <> '[]'::text THEN
    RAISE EXCEPTION 'GIP pricing snapshot does not use the current qualified daily payer rate' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_evidence FROM medicaid_hospice_billing_evidence e WHERE e.organization_id = NEW.organization_id
    AND e.id = NEW.billing_evidence_id AND e.provider_entity_id = NEW.provider_entity_id AND
    e.patient_id = v_claim.patient_id AND e.admission_id = v_claim.admission_id AND
    e.canonical_payer_id = v_claim.canonical_payer_id AND e.program_kind = 'managed_care' AND
    e.service_state = 'OR' AND e.service_category = 'GIP' AND e.verification_status = 'verified' AND
    e.quantity_policy = 'm37_gip_own_unit_daily_v1' AND
    e.quantity_evidence_owner = 'm37_gip_admission_criteria_and_confirmed_bed_history' AND
    e.billing_unit = 'daily' AND e.revenue_code = '0656' AND e.hcpcs_code = 'Q5006' AND
    e.coding_profile = 'local_draft_only' AND e.effective_from <= v_from AND
    (e.effective_to IS NULL OR e.effective_to >= v_to) AND e.version = (NEW.snapshot ->> 'billingEvidenceVersion')::integer AND
    e.verified_at <= NEW.assessed_at AND e.created_at <= NEW.assessed_at
    AND NOT EXISTS (
      SELECT 1 FROM medicaid_hospice_billing_evidence newer
       WHERE newer.organization_id = e.organization_id AND newer.supersedes_id = e.id
    );
  IF NOT FOUND OR v_evidence.locality_code IS DISTINCT FROM v_rate.locality_code OR
     v_evidence.quality_reporting_applicability IS DISTINCT FROM v_rate.quality_reporting_applicability OR
     v_evidence.quality_reporting_status IS DISTINCT FROM v_rate.quality_reporting_status OR
     v_evidence.billed_charge_cents_per_unit::bigint * v_units < 1 OR
     v_evidence.billed_charge_cents_per_unit::bigint * v_units <> (NEW.snapshot ->> 'billedChargeCents')::bigint OR
     v_line.charges_cents::bigint <> v_evidence.billed_charge_cents_per_unit::bigint * v_units OR
    NEW.snapshot ->> 'billingEvidenceVersion' <> v_evidence.version::text OR
    NEW.snapshot ->> 'billedChargeCentsPerUnit' <> v_evidence.billed_charge_cents_per_unit::text OR
    NEW.snapshot ->> 'chargeEvidenceReference' IS DISTINCT FROM v_evidence.charge_evidence_reference OR
     NEW.snapshot ->> 'chargeEvidenceVersion' <> v_evidence.charge_evidence_version::text OR
     NEW.snapshot ->> 'codingEvidenceReference' IS DISTINCT FROM v_evidence.coding_evidence_reference OR
     NEW.snapshot ->> 'codingEvidenceVersion' <> v_evidence.coding_evidence_version::text OR
     NEW.snapshot ->> 'sourceDocumentReference' IS DISTINCT FROM v_evidence.source_document_reference OR
     NEW.snapshot #>> '{qualityReporting,evidenceReference}' IS DISTINCT FROM v_evidence.quality_evidence_reference OR
     NEW.snapshot #>> '{qualityReporting,evidenceVersion}' <> v_evidence.quality_evidence_version::text OR
     NEW.snapshot #>> '{qualityReporting,applicability}' IS DISTINCT FROM v_evidence.quality_reporting_applicability OR
     NEW.snapshot #>> '{qualityReporting,status}' IS DISTINCT FROM v_evidence.quality_reporting_status OR
     NEW.snapshot ->> 'revenueCode' <> '0656' OR NEW.snapshot ->> 'hcpcsCode' <> 'Q5006' OR
     NEW.snapshot ->> 'institutionalFormatQualified' <> 'false' OR
     NEW.fingerprint IS DISTINCT FROM encode(digest((NEW.snapshot - 'assessmentTimestamp')::text, 'sha256'), 'hex') OR
     NOT m37_gip_own_unit_pricing_source_valid(
       NEW.organization_id, NEW.provider_entity_id, v_claim.patient_id, v_claim.admission_id,
       (NEW.snapshot ->> 'locPeriodId')::uuid, NEW.snapshot, NEW.assessed_at
     ) THEN
    RAISE EXCEPTION 'GIP pricing snapshot source identity, charge or integrity evidence does not match' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_claim_line_pricing_snapshot_insert_gip
  BEFORE INSERT ON medicaid_claim_line_pricing_snapshot
  FOR EACH ROW WHEN (NEW.snapshot_schema_version = 5)
  EXECUTE FUNCTION guard_medicaid_claim_line_pricing_snapshot_insert_gip();--> statement-breakpoint

COMMENT ON FUNCTION guard_medicaid_claim_line_pricing_snapshot_insert_gip() IS
  'Binds v5 own-IPU GIP local daily pricing snapshots to a DRAFT line, current qualified M24 rate and billing evidence, M37 source versions, and M40 active IPU facility identity; never qualifies institutional format.';--> statement-breakpoint
