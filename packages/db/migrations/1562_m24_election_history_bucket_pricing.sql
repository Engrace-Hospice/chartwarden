-- compat: contract
-- L8A.2C3 Checkpoint A: retain M6-owned, versioned evidence that election history is complete for a
-- bounded service window; permit only an explicit synthetic managed-care election-day methodology;
-- and add the local home-RHC bucket snapshot v3. Historical rate, claim and snapshot rows are not
-- promoted or rewritten. The history evidence contains references/statuses only, not clinical narrative.

ALTER TABLE medicaid_payer_rate_policy
  ADD COLUMN election_day_basis text NOT NULL DEFAULT 'unqualified';--> statement-breakpoint
ALTER TABLE medicaid_payer_rate_policy
  ADD CONSTRAINT medicaid_payer_rate_policy_election_day_basis_valid
    CHECK (election_day_basis IN ('unqualified', 'current_signed_election_calendar_days_v1'));--> statement-breakpoint
ALTER TABLE medicaid_payer_rate_policy
  ADD CONSTRAINT medicaid_payer_rate_policy_bucket_election_basis_required CHECK (
    verification_status <> 'verified' OR (bucket_from IS NULL AND bucket_to IS NULL) OR
    (service_category = 'RHC' AND program_kind = 'managed_care' AND
     source_kind IN ('cco_contract', 'other_payer_contract') AND
     election_day_basis = 'current_signed_election_calendar_days_v1')
  ) NOT VALID;--> statement-breakpoint

-- The same bounded migration adds one daily IRC local-draft profile. Existing RHC/CHC rows are unchanged;
-- all other service categories and coding/unit combinations remain rejected.
ALTER TABLE medicaid_hospice_billing_evidence
  DROP CONSTRAINT medicaid_hospice_billing_evidence_state;--> statement-breakpoint
ALTER TABLE medicaid_hospice_billing_evidence
  ADD CONSTRAINT medicaid_hospice_billing_evidence_state CHECK (
    program_kind = 'managed_care' AND service_state = 'OR' AND service_category IN ('RHC', 'CHC', 'IRC')
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
      revenue_code = '0655' AND hcpcs_code = 'Q5005'))
  ) IS TRUE);--> statement-breakpoint

CREATE TABLE medicaid_election_history_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL REFERENCES provider_entity(id) ON DELETE RESTRICT,
  location_id uuid REFERENCES location(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL,
  admission_id uuid NOT NULL REFERENCES admission(id) ON DELETE RESTRICT,
  election_period_id uuid NOT NULL REFERENCES election_period(id) ON DELETE RESTRICT,
  coverage_from date NOT NULL,
  coverage_through date NOT NULL,
  completeness_status text NOT NULL,
  prior_hospice_status text NOT NULL,
  transfer_status text NOT NULL,
  interruption_status text NOT NULL,
  source_reference text NOT NULL,
  source_version integer NOT NULL,
  verification_status text NOT NULL,
  verified_at timestamptz,
  verified_by_membership_id uuid,
  recorded_by_membership_id uuid NOT NULL,
  version integer NOT NULL,
  supersedes_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medicaid_election_history_evidence_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT medicaid_election_history_evidence_scope_version_uq
    UNIQUE (organization_id, provider_entity_id, patient_id, admission_id, election_period_id, version),
  CONSTRAINT medicaid_election_history_evidence_supersedes_org_fk
    FOREIGN KEY (organization_id, supersedes_id)
    REFERENCES medicaid_election_history_evidence (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT medicaid_election_history_evidence_coverage_valid CHECK (coverage_from <= coverage_through),
  CONSTRAINT medicaid_election_history_evidence_statuses_valid CHECK (
    completeness_status IN ('complete', 'partial', 'unknown', 'conflicting') AND
    prior_hospice_status IN ('none_confirmed', 'documented', 'unknown') AND
    transfer_status IN ('none_confirmed', 'complete', 'unknown') AND
    interruption_status IN ('none_confirmed', 'complete', 'unknown') AND
    verification_status IN ('pending', 'verified', 'revoked', 'superseded')
  ),
  CONSTRAINT medicaid_election_history_evidence_source_valid CHECK (
    source_reference ~ '^(doc|evidence):[A-Za-z0-9._/-]{1,190}$' AND source_version > 0 AND version > 0
  ),
  CONSTRAINT medicaid_election_history_evidence_verified_provenance CHECK (
    verification_status <> 'verified' OR
    (completeness_status = 'complete' AND verified_at IS NOT NULL AND verified_by_membership_id IS NOT NULL AND
     verified_by_membership_id <> recorded_by_membership_id)
  )
);--> statement-breakpoint
CREATE INDEX medicaid_election_history_evidence_scope_ix
  ON medicaid_election_history_evidence
  (organization_id, provider_entity_id, patient_id, admission_id, election_period_id, version DESC);--> statement-breakpoint
ALTER TABLE medicaid_election_history_evidence ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE medicaid_election_history_evidence FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY medicaid_election_history_evidence_org ON medicaid_election_history_evidence
  FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON medicaid_election_history_evidence TO chartwarden_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_election_history_evidence_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_admission admission%ROWTYPE; v_period election_period%ROWTYPE; v_prior medicaid_election_history_evidence%ROWTYPE;
BEGIN
  -- chartwarden_app has SELECT but deliberately no UPDATE on this append-only evidence table, so
  -- SELECT ... FOR SHARE cannot be used by the M6 reader. Serialize version-head inserts and pricing
  -- reads on the same admission-scoped transaction lock instead.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'm6-medicaid-election-history:' || NEW.organization_id::text || ':' || NEW.admission_id::text, 0));
  SELECT * INTO v_admission FROM admission
   WHERE id = NEW.admission_id AND organization_id = NEW.organization_id FOR SHARE;
  SELECT * INTO v_period FROM election_period
   WHERE id = NEW.election_period_id AND organization_id = NEW.organization_id
     AND admission_id = NEW.admission_id FOR SHARE;
  IF NOT FOUND OR v_admission.provider_entity_id IS DISTINCT FROM NEW.provider_entity_id OR
     v_admission.patient_id IS DISTINCT FROM NEW.patient_id OR
     v_admission.location_id IS DISTINCT FROM NEW.location_id OR
     v_period.status NOT IN ('active', 'completed') OR v_period.effective_at IS NULL THEN
    RAISE EXCEPTION 'election history evidence source scope is inconsistent' USING ERRCODE = '23514';
  END IF;
  IF NEW.supersedes_id IS NULL THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'initial election history evidence version must be one' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO v_prior FROM medicaid_election_history_evidence
     WHERE organization_id = NEW.organization_id AND id = NEW.supersedes_id FOR SHARE;
    IF NOT FOUND OR ROW(v_prior.provider_entity_id, v_prior.location_id, v_prior.patient_id,
        v_prior.admission_id, v_prior.election_period_id, v_prior.version)
       IS DISTINCT FROM ROW(NEW.provider_entity_id, NEW.location_id, NEW.patient_id,
        NEW.admission_id, NEW.election_period_id, NEW.version - 1) THEN
      RAISE EXCEPTION 'election history evidence correction lineage is inconsistent' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.verification_status = 'verified' AND
     (NEW.coverage_from > v_period.effective_at OR NEW.completeness_status <> 'complete') THEN
    RAISE EXCEPTION 'verified election history does not cover its signed election anchor' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_election_history_evidence_identity
  BEFORE INSERT ON medicaid_election_history_evidence FOR EACH ROW
  EXECUTE FUNCTION guard_medicaid_election_history_evidence_identity();--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_medicaid_election_history_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'election history evidence is append-only; record a superseding version' USING ERRCODE = '55000';
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_election_history_evidence_immutable
  BEFORE UPDATE OR DELETE ON medicaid_election_history_evidence FOR EACH ROW
  EXECUTE FUNCTION guard_medicaid_election_history_evidence_immutable();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_insert_medicaid_election_history_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    NEW.organization_id, NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'medicaid_election_history_evidence.insert', TG_TABLE_NAME, NEW.id,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', NULL,
    jsonb_build_object('provider_entity_id', NEW.provider_entity_id, 'admission_id', NEW.admission_id,
      'election_period_id', NEW.election_period_id, 'version', NEW.version,
      'verification_status', NEW.verification_status, 'source_version', NEW.source_version),
    '{}'::jsonb, 'compliance'
  );
  RETURN NEW;
END $$;--> statement-breakpoint
ALTER FUNCTION audit_insert_medicaid_election_history_evidence() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER trg_audit_medicaid_election_history_evidence
  AFTER INSERT ON medicaid_election_history_evidence FOR EACH ROW
  EXECUTE FUNCTION audit_insert_medicaid_election_history_evidence();--> statement-breakpoint

CREATE OR REPLACE FUNCTION m6_election_history_evidence_for_pricing_locked(
  p_organization_id uuid, p_provider_entity_id uuid, p_patient_id uuid, p_admission_id uuid,
  p_election_period_id uuid, p_evidence_id uuid
) RETURNS TABLE (
  evidence_id uuid, election_period_id uuid, coverage_from date, coverage_through date,
  completeness_status text, prior_hospice_status text, transfer_status text, interruption_status text,
  source_reference text, source_version integer, verification_status text, verified_at timestamptz,
  evidence_version integer, evidence_created_at timestamptz, election_start_date date,
  election_statement_id uuid, election_statement_signed boolean, election_statement_provider_entity_id uuid,
  election_statement_effective_date date, election_statement_signed_at date,
  election_statement_updated_at timestamptz, admission_version bigint, admission_status text,
  election_period_sequence smallint, election_period_status text
) LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN QUERY
  SELECT h.id, h.election_period_id, h.coverage_from, h.coverage_through,
    h.completeness_status, h.prior_hospice_status, h.transfer_status, h.interruption_status,
    h.source_reference, h.source_version, h.verification_status, h.verified_at, h.version, h.created_at,
    ep.effective_at, ep.election_statement_id, (es.status = 'signed'), es.provider_entity_id,
    es.declared_effective_date, es.signed_at, es.updated_at, a.version, a.status::text,
    ep.sequence_number, ep.status::text
  FROM medicaid_election_history_evidence h
  JOIN election_period ep ON ep.id = h.election_period_id AND ep.organization_id = h.organization_id
    AND ep.admission_id = h.admission_id
  JOIN election_statement es ON es.id = ep.election_statement_id AND es.organization_id = h.organization_id
    AND es.election_period_id = ep.id AND es.patient_id = h.patient_id
  JOIN admission a ON a.id = h.admission_id AND a.organization_id = h.organization_id
    AND a.provider_entity_id = h.provider_entity_id AND a.patient_id = h.patient_id
  WHERE h.organization_id = p_organization_id AND h.provider_entity_id = p_provider_entity_id
    AND h.patient_id = p_patient_id AND h.admission_id = p_admission_id
    AND h.election_period_id = p_election_period_id AND h.id = p_evidence_id
    AND NOT EXISTS (SELECT 1 FROM medicaid_election_history_evidence newer
      WHERE newer.organization_id = h.organization_id AND newer.provider_entity_id = h.provider_entity_id
        AND newer.patient_id = h.patient_id AND newer.admission_id = h.admission_id
        AND newer.election_period_id = h.election_period_id AND newer.version > h.version)
  -- The evidence row is append-only and protected by the admission-scoped advisory lock; locking
  -- that row would require granting UPDATE on M6's SELECT-only evidence table to the application.
  FOR SHARE OF ep, es, a;
END $$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m6_election_history_evidence_for_pricing_locked(uuid, uuid, uuid, uuid, uuid, uuid)
  TO chartwarden_app;--> statement-breakpoint

ALTER TABLE medicaid_claim_line_pricing_snapshot
  DROP CONSTRAINT medicaid_claim_line_pricing_snapshot_fingerprint;--> statement-breakpoint
ALTER TABLE medicaid_claim_line_pricing_snapshot
  ADD CONSTRAINT medicaid_claim_line_pricing_snapshot_fingerprint CHECK (
    fingerprint ~ '^[0-9a-f]{64}$' AND snapshot_schema_version IN (1, 2, 3, 4)
  );--> statement-breakpoint
ALTER TABLE medicaid_claim_line_pricing_snapshot
  DROP CONSTRAINT medicaid_claim_line_pricing_snapshot_shape;--> statement-breakpoint
ALTER TABLE medicaid_claim_line_pricing_snapshot
  ADD CONSTRAINT medicaid_claim_line_pricing_snapshot_shape CHECK (
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
       snapshot ->> 'locPeriodVersion' ~ '^[0-9]+$' AND
       snapshot ->> 'locEvidenceUpdatedAt' IS NOT NULL AND
      snapshot #>> '{quantity,basis}' = 'per_day' AND
      snapshot #>> '{quantity,units}' ~ '^[1-9][0-9]*$' AND
      snapshot ->> 'reimbursementEstimateCents' ~ '^[0-9]+$' AND
      snapshot ->> 'billedChargeCents' ~ '^[1-9][0-9]*$'))
  );--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_claim_line_pricing_snapshot_supported_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_claim medicaid_claim%ROWTYPE;
  v_line medicaid_claim_line%ROWTYPE;
  v_address patient_address%ROWTYPE;
  v_address_id uuid;
  v_facility_id uuid;
  v_resolved_facility_id uuid;
  v_facility_kind facility_kind;
  v_facility_status mdm_entity_status;
  v_rate medicaid_payer_rate_policy%ROWTYPE;
  v_billing_evidence medicaid_hospice_billing_evidence%ROWTYPE;
  v_election record;
  v_day_from integer;
  v_day_to integer;
  v_units integer;
  v_service_from date;
  v_service_to date;
  v_episode_start date;
  v_snapshot_assessed_at timestamptz;
  v_reimbursement bigint;
  v_charge bigint;
BEGIN
  IF NEW.snapshot_schema_version = 1 THEN
    IF NEW.snapshot ->> 'hcpcsCode' IS DISTINCT FROM 'Q5001' OR
       NEW.snapshot #>> '{serviceLocation,kind}' IS DISTINCT FROM 'home' OR
       NEW.snapshot #>> '{serviceLocation,facilityId}' IS NOT NULL OR NEW.snapshot ? 'localBillingProfile' THEN
      RAISE EXCEPTION 'pricing snapshot v1 is restricted to the existing home RHC profile' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.snapshot_schema_version = 2 THEN
    IF NEW.snapshot ->> 'hcpcsCode' IS DISTINCT FROM 'Q5002' OR
       NEW.snapshot ->> 'localBillingProfile' IS DISTINCT FROM 'rhc_assisted_living_q5002_daily_v1' OR
       NEW.snapshot #>> '{serviceLocation,kind}' IS DISTINCT FROM 'facility' OR
       NEW.snapshot #>> '{serviceLocation,facilityKind}' IS DISTINCT FROM 'alf' THEN
      RAISE EXCEPTION 'pricing snapshot v2 is restricted to the assisted-living daily RHC profile' USING ERRCODE='23514';
    END IF;
    v_address_id := (NEW.snapshot #>> '{serviceLocation,patientAddressId}')::uuid;
    v_facility_id := (NEW.snapshot #>> '{serviceLocation,facilityId}')::uuid;
    SELECT * INTO v_claim FROM medicaid_claim WHERE organization_id = NEW.organization_id
      AND provider_entity_id = NEW.provider_entity_id AND id = NEW.medicaid_claim_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'pricing snapshot claim identity is unavailable' USING ERRCODE='23514'; END IF;
    SELECT * INTO v_address FROM patient_address WHERE id = v_address_id AND organization_id = NEW.organization_id
      AND patient_id = v_claim.patient_id AND is_primary = true FOR SHARE;
    -- Bind the snapshot to the billed segment, not to the full mutable residence-row bounds. A later
    -- move-out may close an open row after these service days without changing the evidence for them.
    IF NOT FOUND OR v_address.kind <> 'facility' OR v_address.facility_id IS DISTINCT FROM v_facility_id OR
       NEW.snapshot #>> '{serviceLocation,effectiveFrom}' IS DISTINCT FROM NEW.snapshot ->> 'serviceFrom' OR
       NEW.snapshot #>> '{serviceLocation,effectiveTo}' IS DISTINCT FROM NEW.snapshot ->> 'serviceTo' OR
       v_address.effective_from > (NEW.snapshot ->> 'serviceFrom')::date OR
       (v_address.effective_to IS NOT NULL AND v_address.effective_to < (NEW.snapshot ->> 'serviceTo')::date) THEN
      RAISE EXCEPTION 'pricing snapshot facility residence is not effective for this service range' USING ERRCODE='23514';
    END IF;
    SELECT resolved_facility_id, facility_kind, facility_status INTO v_resolved_facility_id, v_facility_kind, v_facility_status
      FROM m40_facility_kind_for_ids_locked(jsonb_build_array(v_facility_id));
    IF NOT FOUND OR v_resolved_facility_id IS DISTINCT FROM v_facility_id OR
       v_facility_kind <> 'alf' OR v_facility_status <> 'active' THEN
      RAISE EXCEPTION 'pricing snapshot requires an active M40 assisted-living facility identity' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.snapshot_schema_version = 4 THEN
    IF NEW.snapshot ->> 'profile' IS DISTINCT FROM 'irc_hospital_q5005_daily_local_v1' OR
       NEW.snapshot ->> 'localBillingProfile' IS DISTINCT FROM 'irc_hospital_q5005_daily_local_v1' OR
       NEW.snapshot ->> 'postingAuthorized' IS DISTINCT FROM 'false' OR
       NEW.snapshot ->> 'institutionalFormatQualified' IS DISTINCT FROM 'false' OR
       NEW.snapshot ->> 'levelOfCare' IS DISTINCT FROM 'IRC' OR
       NEW.snapshot ->> 'revenueCode' IS DISTINCT FROM '0655' OR
       NEW.snapshot ->> 'hcpcsCode' IS DISTINCT FROM 'Q5005' OR
       NEW.snapshot #>> '{serviceLocation,kind}' IS DISTINCT FROM 'facility' OR
       NEW.snapshot #>> '{serviceLocation,facilityKind}' IS DISTINCT FROM 'hospital' OR
       NEW.snapshot #>> '{quantity,basis}' IS DISTINCT FROM 'per_day' OR
       NEW.snapshot ->> 'organizationId' IS DISTINCT FROM NEW.organization_id::text OR
       NEW.snapshot ->> 'providerEntityId' IS DISTINCT FROM NEW.provider_entity_id::text OR
       NEW.snapshot ->> 'medicaidClaimId' IS DISTINCT FROM NEW.medicaid_claim_id::text OR
       NEW.snapshot ->> 'claimLineId' IS DISTINCT FROM NEW.medicaid_claim_line_id::text OR
       NEW.snapshot ->> 'payerRatePolicyId' IS DISTINCT FROM NEW.payer_rate_policy_id::text OR
       NEW.snapshot ->> 'billingEvidenceId' IS DISTINCT FROM NEW.billing_evidence_id::text THEN
      RAISE EXCEPTION 'pricing snapshot v4 is restricted to the nonposting local daily IRC profile' USING ERRCODE='23514';
    END IF;
    BEGIN
      v_service_from := (NEW.snapshot ->> 'serviceFrom')::date;
      v_service_to := (NEW.snapshot ->> 'serviceTo')::date;
      v_episode_start := (NEW.snapshot #>> '{episode,episodeStartLocalDate}')::date;
      v_day_from := (NEW.snapshot #>> '{episode,consecutiveDayFrom}')::integer;
      v_day_to := (NEW.snapshot #>> '{episode,consecutiveDayTo}')::integer;
      v_units := (NEW.snapshot #>> '{quantity,units}')::integer;
      v_reimbursement := (NEW.snapshot ->> 'reimbursementEstimateCents')::bigint;
      v_charge := (NEW.snapshot ->> 'billedChargeCents')::bigint;
      v_snapshot_assessed_at := (NEW.snapshot ->> 'assessmentTimestamp')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'pricing snapshot v4 contains invalid date or amount fields' USING ERRCODE='23514';
    END;
    SELECT * INTO v_claim FROM medicaid_claim WHERE organization_id = NEW.organization_id
      AND provider_entity_id = NEW.provider_entity_id AND id = NEW.medicaid_claim_id FOR SHARE;
    SELECT * INTO v_line FROM medicaid_claim_line WHERE organization_id = NEW.organization_id
      AND provider_entity_id = NEW.provider_entity_id AND id = NEW.medicaid_claim_line_id
      AND medicaid_claim_id = NEW.medicaid_claim_id FOR SHARE;
    IF NOT FOUND OR v_claim.id IS NULL OR v_claim.state <> 'DRAFT' OR v_claim.rb_arrangement_id IS NOT NULL OR
       v_claim.service_from::date > v_service_from OR v_claim.service_to::date < v_service_to OR
       v_claim.patient_id::text IS DISTINCT FROM NEW.snapshot ->> 'patientId' OR
       v_claim.admission_id::text IS DISTINCT FROM NEW.snapshot ->> 'admissionId' OR
       v_claim.canonical_payer_id::text IS DISTINCT FROM NEW.snapshot ->> 'canonicalPayerId' OR
       v_claim.medicaid_program_kind::text IS DISTINCT FROM 'managed_care' OR v_claim.service_state <> 'OR' OR
       v_line.level_of_care <> 'IRC' OR v_line.revenue_code <> '0655' OR v_line.q_code <> 'Q5005' OR
       v_line.is_rb OR v_line.rb_day_id IS NOT NULL OR v_line.loc_period_id::text IS DISTINCT FROM NEW.snapshot ->> 'locPeriodId' OR
       v_line.service_date::date <> v_service_from OR v_line.service_date_to IS NULL OR
       v_line.service_date_to::date <> v_service_to OR
       v_line.units <> v_units OR v_line.rate_at_assembly_cents <> (NEW.snapshot ->> 'rateCents')::integer OR
       v_line.payer_rate_policy_id_snapshot IS DISTINCT FROM NEW.payer_rate_policy_id OR
       v_line.state_rate_schedule_id_snapshot IS NOT NULL OR v_line.charges_cents <> v_charge OR
       v_service_from > v_service_to OR v_units <> (v_service_to - v_service_from + 1) OR
       v_day_from <> (v_service_from - v_episode_start + 1) OR
       v_day_to <> (v_service_to - v_episode_start + 1) OR
       v_day_to - v_day_from + 1 <> v_units OR v_day_from < 1 OR v_day_to > 5 OR
       v_day_to > (NEW.snapshot #>> '{episode,consecutiveDayCount}')::integer OR
       NEW.snapshot #>> '{episode,episodeState}' NOT IN ('active', 'approaching_cap', 'closed') OR
       NEW.snapshot #>> '{episode,ipuAdmissionState}' NOT IN ('active', 'discharged', 'closed') OR
       NEW.snapshot #>> '{episode,remoteStayStartedLocalDate}' > v_service_from::text OR
       (NEW.snapshot #>> '{episode,remoteStayEndLocalDate}') IS NOT NULL AND
         (NEW.snapshot #>> '{episode,remoteStayEndLocalDate}') < (v_service_to + 1)::text OR
       (NEW.snapshot #>> '{episode,episodeClosedLocalDate}') IS NOT NULL AND
         (NEW.snapshot #>> '{episode,episodeClosedLocalDate}') < (v_service_to + 1)::text OR
       (NEW.snapshot #>> '{episode,ipuAdmissionClosedLocalDate}') IS NOT NULL AND
         (NEW.snapshot #>> '{episode,ipuAdmissionClosedLocalDate}') < (v_service_to + 1)::text OR
       NOT EXISTS (SELECT 1 FROM pg_timezone_names tz WHERE tz.name = NEW.snapshot #>> '{episode,serviceTimeZone}') OR
       (((NEW.snapshot #>> '{episode,episodeStartAt}')::timestamptz AT TIME ZONE
          (NEW.snapshot #>> '{episode,serviceTimeZone}'))::date <> v_episode_start) OR
       (((NEW.snapshot #>> '{episode,actualStayStartAt}')::timestamptz AT TIME ZONE
          (NEW.snapshot #>> '{episode,serviceTimeZone}'))::date <
          (NEW.snapshot #>> '{episode,remoteStayStartedLocalDate}')::date) OR
       ((NEW.snapshot #>> '{episode,actualStayEndAt}') IS NOT NULL AND
         (NEW.snapshot #>> '{episode,actualStayEndAt}')::timestamptz <
         ((v_service_to + 1)::timestamp AT TIME ZONE (NEW.snapshot #>> '{episode,serviceTimeZone}'))) OR
       (NEW.snapshot #>> '{episode,actualStayEndAt}') IS NULL AND
         (NEW.snapshot #>> '{episode,remoteStayEndLocalDate}') IS NOT NULL OR
       (NEW.snapshot ->> 'estimatedReimbursementCents')::bigint < 0 OR v_charge <= 0 THEN
      RAISE EXCEPTION 'pricing snapshot v4 claim, service range, or episode sequence is inconsistent' USING ERRCODE='23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'm24-rate-policy:' || NEW.organization_id::text || ':' || NEW.provider_entity_id::text || ':' ||
      v_claim.canonical_payer_id::text || ':' || v_claim.service_state, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'm24-hospice-evidence:' || NEW.organization_id::text || ':' || NEW.provider_entity_id::text || ':' ||
      v_claim.patient_id::text || ':' || v_claim.admission_id::text || ':' ||
      v_claim.canonical_payer_id::text || ':managed_care:' || v_claim.service_state || ':IRC', 0));
    SELECT * INTO v_rate FROM medicaid_payer_rate_policy WHERE organization_id = NEW.organization_id
      AND id = NEW.payer_rate_policy_id AND provider_entity_id = NEW.provider_entity_id
      AND canonical_payer_id = v_claim.canonical_payer_id AND program_kind = 'managed_care'
      AND service_state = v_claim.service_state AND service_category = 'IRC' AND unit_basis = 'per_day'
      AND bucket_from IS NULL AND bucket_to IS NULL AND election_day_basis = 'unqualified'
      AND verification_status = 'verified' AND pricing_method = 'per_day'
      AND charge_ceiling_method = 'none' AND charge_ceiling_cents IS NULL
      AND effective_from <= v_service_from AND (effective_to IS NULL OR effective_to >= v_service_to)
      AND version = (NEW.snapshot ->> 'rateVersion')::integer
      AND rate_cents = (NEW.snapshot ->> 'rateCents')::integer
      AND NOT EXISTS (SELECT 1 FROM medicaid_payer_rate_policy newer
        WHERE newer.organization_id = medicaid_payer_rate_policy.organization_id
          AND newer.provider_entity_id = medicaid_payer_rate_policy.provider_entity_id
          AND newer.canonical_payer_id = medicaid_payer_rate_policy.canonical_payer_id
          AND newer.program_kind = medicaid_payer_rate_policy.program_kind
          AND newer.service_state = medicaid_payer_rate_policy.service_state
          AND newer.service_category = medicaid_payer_rate_policy.service_category
          AND newer.locality_code = medicaid_payer_rate_policy.locality_code
          AND newer.unit_basis = medicaid_payer_rate_policy.unit_basis
          AND newer.effective_from = medicaid_payer_rate_policy.effective_from
          AND newer.version > medicaid_payer_rate_policy.version);
    IF NOT FOUND THEN RAISE EXCEPTION 'pricing snapshot v4 payer rate is not the current qualified IRC rate' USING ERRCODE='23514'; END IF;
    SELECT * INTO v_billing_evidence FROM medicaid_hospice_billing_evidence WHERE organization_id = NEW.organization_id
      AND id = NEW.billing_evidence_id AND provider_entity_id = NEW.provider_entity_id
      AND patient_id = v_claim.patient_id AND admission_id = v_claim.admission_id
      AND canonical_payer_id = v_claim.canonical_payer_id AND program_kind = 'managed_care'
      AND service_state = v_claim.service_state AND service_category = 'IRC'
      AND verification_status = 'verified' AND quantity_policy = 'm37_irc_episode_daily_v1'
      AND quantity_evidence_owner = 'm37_irc_episode_and_remote_stay' AND billing_unit = 'daily'
      AND revenue_code = '0655' AND hcpcs_code = 'Q5005' AND coding_profile = 'local_draft_only'
      AND effective_from <= v_service_from AND (effective_to IS NULL OR effective_to >= v_service_to)
      AND version = (NEW.snapshot ->> 'billingEvidenceVersion')::integer
      AND verified_at <= NEW.assessed_at AND created_at <= NEW.assessed_at
      AND locality_code = NEW.snapshot #>> '{locality,code}'
      AND NOT EXISTS (SELECT 1 FROM medicaid_hospice_billing_evidence newer
        WHERE newer.organization_id = medicaid_hospice_billing_evidence.organization_id
          AND newer.provider_entity_id = medicaid_hospice_billing_evidence.provider_entity_id
          AND newer.patient_id = medicaid_hospice_billing_evidence.patient_id
          AND newer.admission_id = medicaid_hospice_billing_evidence.admission_id
          AND newer.canonical_payer_id = medicaid_hospice_billing_evidence.canonical_payer_id
          AND newer.program_kind = medicaid_hospice_billing_evidence.program_kind
          AND newer.service_state = medicaid_hospice_billing_evidence.service_state
          AND newer.service_category = medicaid_hospice_billing_evidence.service_category
          AND newer.effective_from = medicaid_hospice_billing_evidence.effective_from
          AND newer.version > medicaid_hospice_billing_evidence.version);
    IF NOT FOUND OR v_snapshot_assessed_at IS DISTINCT FROM NEW.assessed_at OR v_claim.created_at > NEW.assessed_at OR
       (NEW.snapshot ->> 'baseReimbursementCents')::bigint <> v_rate.rate_cents::bigint * v_units OR
       v_reimbursement <> v_rate.rate_cents::bigint * v_units OR
       v_charge <> v_billing_evidence.billed_charge_cents_per_unit::bigint * v_units OR
       (NEW.snapshot ->> 'billedChargeCentsPerUnit')::integer <> v_billing_evidence.billed_charge_cents_per_unit OR
       NEW.snapshot ->> 'codingEvidenceVersion' <> v_billing_evidence.coding_evidence_version::text OR
       NEW.snapshot ->> 'chargeEvidenceVersion' <> v_billing_evidence.charge_evidence_version::text OR
       NEW.snapshot #>> '{locality,evidenceReference}' IS DISTINCT FROM v_billing_evidence.locality_evidence_reference OR
       NEW.snapshot #>> '{locality,evidenceVersion}' <> v_billing_evidence.locality_evidence_version::text OR
       NEW.snapshot #>> '{qualityReporting,evidenceReference}' IS DISTINCT FROM v_billing_evidence.quality_evidence_reference OR
       NEW.snapshot #>> '{qualityReporting,evidenceVersion}' <> v_billing_evidence.quality_evidence_version::text OR
       NEW.snapshot ->> 'codingEvidenceReference' IS DISTINCT FROM v_billing_evidence.coding_evidence_reference OR
       NEW.snapshot ->> 'chargeEvidenceReference' IS DISTINCT FROM v_billing_evidence.charge_evidence_reference OR
       NEW.snapshot ->> 'sourceDocumentReference' IS DISTINCT FROM v_billing_evidence.source_document_reference OR
       NEW.snapshot #>> '{qualityReporting,applicability}' IS DISTINCT FROM v_billing_evidence.quality_reporting_applicability OR
       NEW.snapshot #>> '{qualityReporting,status}' IS DISTINCT FROM v_billing_evidence.quality_reporting_status OR
       NEW.snapshot #>> '{episode,facilityId}' IS DISTINCT FROM NEW.snapshot #>> '{serviceLocation,facilityId}' OR
       NEW.snapshot #>> '{episode,agreementDocumentId}' IS NULL OR
       NEW.snapshot #>> '{episode,transitionBeforeServiceEnd}' IS DISTINCT FROM 'false' OR
       NEW.snapshot #>> '{episode,carriedOverDays}' IS DISTINCT FROM '0' OR
       NEW.snapshot #>> '{episode,capOverrideInvoked}' IS DISTINCT FROM 'false' OR
       NEW.snapshot #>> '{appliedCeilings}' <> '[]'::text THEN
      RAISE EXCEPTION 'pricing snapshot v4 lacks current source-backed IRC billing facts or arithmetic' USING ERRCODE='23514';
    END IF;
    v_facility_id := (NEW.snapshot #>> '{serviceLocation,facilityId}')::uuid;
    SELECT resolved_facility_id, facility_kind, facility_status INTO v_resolved_facility_id, v_facility_kind, v_facility_status
      FROM m40_facility_kind_for_ids_locked(jsonb_build_array(v_facility_id));
    IF NOT FOUND OR v_resolved_facility_id IS DISTINCT FROM v_facility_id OR
       v_facility_kind <> 'hospital' OR v_facility_status <> 'active' THEN
      RAISE EXCEPTION 'pricing snapshot v4 requires the active M40 hospital facility identity' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.snapshot_schema_version <> 3 OR
     NEW.snapshot ->> 'hcpcsCode' IS DISTINCT FROM 'Q5001' OR
     NEW.snapshot ->> 'localBillingProfile' IS DISTINCT FROM 'rhc_home_election_bucket_daily_v1' OR
     NEW.snapshot #>> '{serviceLocation,kind}' IS DISTINCT FROM 'home' OR
     NEW.snapshot #>> '{serviceLocation,facilityId}' IS NOT NULL THEN
    RAISE EXCEPTION 'pricing snapshot v3 is restricted to the home RHC election-bucket profile' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_claim FROM medicaid_claim WHERE organization_id = NEW.organization_id
    AND provider_entity_id = NEW.provider_entity_id AND id = NEW.medicaid_claim_id;
  SELECT * INTO v_line FROM medicaid_claim_line WHERE organization_id = NEW.organization_id
    AND provider_entity_id = NEW.provider_entity_id AND id = NEW.medicaid_claim_line_id
    AND medicaid_claim_id = NEW.medicaid_claim_id FOR SHARE;
  IF NOT FOUND OR v_claim.id IS NULL OR v_line.level_of_care <> 'RHC' OR
     v_line.q_code <> 'Q5001' OR v_line.revenue_code <> '0651' OR v_line.is_rb OR
     v_line.service_date::date <> (NEW.snapshot ->> 'serviceFrom')::date OR
     v_line.service_date_to IS NULL OR v_line.service_date_to::date <> (NEW.snapshot ->> 'serviceTo')::date OR
     v_line.loc_period_id::text IS DISTINCT FROM NEW.snapshot ->> 'locPeriodId' OR
     v_line.payer_rate_policy_id_snapshot IS DISTINCT FROM NEW.payer_rate_policy_id OR
     v_line.units <> (NEW.snapshot #>> '{quantity,units}')::integer OR
     v_line.rate_at_assembly_cents <> (NEW.snapshot ->> 'rateCents')::integer OR
     v_line.charges_cents <> (NEW.snapshot ->> 'billedChargeCents')::integer OR
     v_claim.patient_id::text IS DISTINCT FROM NEW.snapshot ->> 'patientId' OR
     v_claim.admission_id::text IS DISTINCT FROM NEW.snapshot ->> 'admissionId' OR
     v_claim.canonical_payer_id::text IS DISTINCT FROM NEW.snapshot ->> 'canonicalPayerId' OR
     v_claim.medicaid_program_kind::text IS DISTINCT FROM 'managed_care' THEN
    RAISE EXCEPTION 'pricing snapshot v3 claim and line facts are inconsistent' USING ERRCODE='23514';
  END IF;
  -- Payer-rate rows are append-only and chartwarden_app is deliberately SELECT-only on that
  -- reference data. Serialize this validation with the same scope lock used by rate insertion and
  -- the M24 reader instead of requesting a row lock the application role cannot acquire.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'm24-rate-policy:' || NEW.organization_id::text || ':' || NEW.provider_entity_id::text || ':' ||
    v_claim.canonical_payer_id::text || ':' || v_claim.service_state, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'm24-hospice-evidence:' || NEW.organization_id::text || ':' || NEW.provider_entity_id::text || ':' ||
    v_claim.patient_id::text || ':' || v_claim.admission_id::text || ':' ||
    v_claim.canonical_payer_id::text || ':' || v_claim.medicaid_program_kind::text || ':' ||
    v_claim.service_state || ':RHC', 0));
  SELECT * INTO v_rate FROM medicaid_payer_rate_policy WHERE organization_id = NEW.organization_id
    AND id = NEW.payer_rate_policy_id AND provider_entity_id = NEW.provider_entity_id
    AND canonical_payer_id = v_claim.canonical_payer_id AND program_kind = 'managed_care'
    AND service_state = v_claim.service_state AND service_category = 'RHC' AND unit_basis = 'per_day'
    AND verification_status = 'verified' AND election_day_basis = 'current_signed_election_calendar_days_v1'
    AND effective_from <= (NEW.snapshot ->> 'serviceFrom')::date
    AND (effective_to IS NULL OR effective_to >= (NEW.snapshot ->> 'serviceTo')::date);
  IF NOT FOUND OR v_rate.rate_cents <> (NEW.snapshot ->> 'rateCents')::integer OR
     v_rate.bucket_from <> (NEW.snapshot #>> '{electionDay,rateBucketFrom}')::integer OR
     v_rate.bucket_to IS DISTINCT FROM NULLIF(NEW.snapshot #>> '{electionDay,rateBucketTo}', '')::integer THEN
    RAISE EXCEPTION 'pricing snapshot v3 rate bucket is not the qualified payer-rate row' USING ERRCODE='23514';
  END IF;
  v_day_from := (NEW.snapshot #>> '{electionDay,dayFrom}')::integer;
  v_day_to := (NEW.snapshot #>> '{electionDay,dayTo}')::integer;
  IF v_day_from <> ((NEW.snapshot ->> 'serviceFrom')::date - (NEW.snapshot #>> '{electionDay,electionStartDate}')::date + 1) OR
     v_day_to <> ((NEW.snapshot ->> 'serviceTo')::date - (NEW.snapshot #>> '{electionDay,electionStartDate}')::date + 1) OR
     v_day_from < v_rate.bucket_from OR (v_rate.bucket_to IS NOT NULL AND v_day_to > v_rate.bucket_to) THEN
    RAISE EXCEPTION 'pricing snapshot v3 election-day range does not match its service dates and rate bucket' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_election FROM m6_election_history_evidence_for_pricing_locked(
    NEW.organization_id, NEW.provider_entity_id, v_claim.patient_id, v_claim.admission_id,
    (NEW.snapshot #>> '{electionDay,electionPeriodId}')::uuid,
    (NEW.snapshot #>> '{electionDay,historyEvidenceId}')::uuid);
  IF NOT FOUND OR NOT v_election.election_statement_signed OR v_election.evidence_version <>
     (NEW.snapshot #>> '{electionDay,historyEvidenceVersion}')::integer OR
     v_election.verification_status <> 'verified' OR v_election.completeness_status <> 'complete' OR
     v_election.prior_hospice_status <> 'none_confirmed' OR v_election.transfer_status <> 'none_confirmed' OR
     v_election.interruption_status <> 'none_confirmed' OR
     v_election.coverage_from > v_election.election_start_date OR
     v_election.coverage_through < (NEW.snapshot ->> 'serviceTo')::date OR
     v_election.election_start_date::text IS DISTINCT FROM NEW.snapshot #>> '{electionDay,electionStartDate}' OR
     v_election.election_statement_id::text IS DISTINCT FROM NEW.snapshot #>> '{electionDay,electionStatementId}' OR
     v_election.election_period_sequence <> 1 OR v_election.election_period_status NOT IN ('active', 'completed') OR
     v_election.admission_version <> (NEW.snapshot ->> 'admissionVersion')::bigint OR
     v_election.admission_status <> 'active' OR
     v_election.election_statement_provider_entity_id IS DISTINCT FROM v_claim.provider_entity_id OR
     v_election.election_statement_effective_date IS DISTINCT FROM v_election.election_start_date OR
     v_election.election_statement_signed_at IS NULL OR
     v_election.election_statement_updated_at > NEW.assessed_at OR
     v_election.verified_at IS NULL OR v_election.verified_at > NEW.assessed_at OR
     v_election.evidence_created_at > NEW.assessed_at OR
     v_election.source_reference IS DISTINCT FROM NEW.snapshot #>> '{electionDay,sourceReference}' OR
     v_election.source_version <> (NEW.snapshot #>> '{electionDay,sourceVersion}')::integer THEN
    RAISE EXCEPTION 'pricing snapshot v3 lacks current complete M6 election-history evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- Keep the published RHC insert guard unchanged for snapshot v1/v2/v3, and route only the new
-- local IRC v4 profile through a category-aware insert guard. Both guards remain invoker-scoped;
-- the source-grounded M24 reader holds the M6/M37 facts through the surrounding transaction.
DROP TRIGGER IF EXISTS trg_medicaid_claim_line_pricing_snapshot_insert ON medicaid_claim_line_pricing_snapshot;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_claim_line_pricing_snapshot_insert
  BEFORE INSERT ON medicaid_claim_line_pricing_snapshot
  FOR EACH ROW WHEN (NEW.snapshot_schema_version <> 4)
  EXECUTE FUNCTION guard_medicaid_claim_line_pricing_snapshot_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_claim_line_pricing_snapshot_insert_irc() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_line medicaid_claim_line%ROWTYPE;
  v_rate medicaid_payer_rate_policy%ROWTYPE;
  v_evidence medicaid_hospice_billing_evidence%ROWTYPE;
  v_claim medicaid_claim%ROWTYPE;
  v_service_from date;
  v_service_to date;
  v_units integer;
BEGIN
  IF NEW.snapshot_schema_version <> 4 OR
     NEW.assessed_at IS DISTINCT FROM (NEW.snapshot ->> 'assessmentTimestamp')::timestamptz OR
     NEW.assessed_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'IRC pricing snapshot assessment identity is invalid' USING ERRCODE='23514';
  END IF;
  BEGIN
    v_service_from := (NEW.snapshot ->> 'serviceFrom')::date;
    v_service_to := (NEW.snapshot ->> 'serviceTo')::date;
    v_units := (NEW.snapshot #>> '{quantity,units}')::integer;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'IRC pricing snapshot service or quantity facts are invalid' USING ERRCODE='23514';
  END;
  SELECT * INTO v_claim FROM medicaid_claim
    WHERE organization_id = NEW.organization_id AND provider_entity_id = NEW.provider_entity_id
      AND id = NEW.medicaid_claim_id FOR SHARE;
  SELECT * INTO v_line FROM medicaid_claim_line
    WHERE organization_id = NEW.organization_id AND provider_entity_id = NEW.provider_entity_id
      AND id = NEW.medicaid_claim_line_id AND medicaid_claim_id = NEW.medicaid_claim_id FOR SHARE;
  IF NOT FOUND OR v_claim.id IS NULL OR v_claim.state <> 'DRAFT' OR v_claim.rb_arrangement_id IS NOT NULL OR
     v_claim.patient_id::text IS DISTINCT FROM NEW.snapshot ->> 'patientId' OR
     v_claim.admission_id::text IS DISTINCT FROM NEW.snapshot ->> 'admissionId' OR
     v_claim.canonical_payer_id::text IS DISTINCT FROM NEW.snapshot ->> 'canonicalPayerId' OR
     v_claim.medicaid_program_kind::text IS DISTINCT FROM 'managed_care' OR v_claim.service_state <> 'OR' OR
     v_line.is_rb OR v_line.rb_day_id IS NOT NULL OR v_line.level_of_care <> 'IRC' OR
     v_line.revenue_code <> '0655' OR v_line.q_code <> 'Q5005' OR
     v_line.loc_period_id::text IS DISTINCT FROM NEW.snapshot ->> 'locPeriodId' OR
     v_line.service_date IS NULL OR v_line.service_date_to IS NULL OR
     v_line.service_date::date <> v_service_from OR v_line.service_date_to::date <> v_service_to OR
     v_service_from > v_service_to OR v_units <> (v_service_to - v_service_from + 1) OR
     v_line.units <> v_units OR v_line.rate_at_assembly_cents <> (NEW.snapshot ->> 'rateCents')::integer OR
     v_line.charges_cents <> (NEW.snapshot ->> 'billedChargeCents')::integer OR
     v_line.payer_rate_policy_id_snapshot IS DISTINCT FROM NEW.payer_rate_policy_id OR
     v_line.state_rate_schedule_id_snapshot IS NOT NULL OR
     v_line.charges_cents::bigint IS DISTINCT FROM
       v_line.units::bigint * (NEW.snapshot ->> 'billedChargeCentsPerUnit')::bigint OR
     NEW.snapshot #>> '{quantity,basis}' IS DISTINCT FROM 'per_day' OR
     NEW.snapshot ->> 'levelOfCare' IS DISTINCT FROM 'IRC' OR
     NEW.snapshot ->> 'revenueCode' IS DISTINCT FROM '0655' OR
     NEW.snapshot ->> 'hcpcsCode' IS DISTINCT FROM 'Q5005' OR
     NEW.snapshot ->> 'claimLineId' IS DISTINCT FROM NEW.medicaid_claim_line_id::text OR
     NEW.snapshot ->> 'medicaidClaimId' IS DISTINCT FROM NEW.medicaid_claim_id::text OR
     NEW.snapshot ->> 'payerRatePolicyId' IS DISTINCT FROM NEW.payer_rate_policy_id::text OR
     NEW.snapshot ->> 'billingEvidenceId' IS DISTINCT FROM NEW.billing_evidence_id::text THEN
    RAISE EXCEPTION 'IRC pricing snapshot identity or amounts do not match its draft line' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'm24-rate-policy:' || NEW.organization_id::text || ':' || NEW.provider_entity_id::text || ':' ||
    v_claim.canonical_payer_id::text || ':' || v_claim.service_state, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'm24-hospice-evidence:' || NEW.organization_id::text || ':' || NEW.provider_entity_id::text || ':' ||
    v_claim.patient_id::text || ':' || v_claim.admission_id::text || ':' ||
    v_claim.canonical_payer_id::text || ':managed_care:' || v_claim.service_state || ':IRC', 0));
  SELECT * INTO v_rate FROM medicaid_payer_rate_policy
    WHERE organization_id = NEW.organization_id AND id = NEW.payer_rate_policy_id;
  IF NOT FOUND OR v_rate.provider_entity_id IS DISTINCT FROM NEW.provider_entity_id OR
     v_rate.canonical_payer_id IS DISTINCT FROM v_claim.canonical_payer_id OR
     v_rate.program_kind <> 'managed_care' OR v_rate.service_state <> 'OR' OR
     v_rate.service_category <> 'IRC' OR v_rate.unit_basis <> 'per_day' OR
     v_rate.bucket_from IS NOT NULL OR v_rate.bucket_to IS NOT NULL OR
     v_rate.election_day_basis <> 'unqualified' OR v_rate.verification_status <> 'verified' OR
     v_rate.pricing_method <> 'per_day' OR v_rate.quantity_conversion_method <> 'daily_units' OR
     v_rate.charge_ceiling_method <> 'none' OR v_rate.charge_ceiling_cents IS NOT NULL OR
     v_rate.effective_from > v_service_from OR
     (v_rate.effective_to IS NOT NULL AND v_rate.effective_to < v_service_to) OR
     v_rate.version <> (NEW.snapshot ->> 'rateVersion')::integer OR
     v_rate.rate_cents <> (NEW.snapshot ->> 'rateCents')::integer OR
     v_rate.created_at > NEW.assessed_at OR v_rate.verified_at IS NULL OR v_rate.verified_at > NEW.assessed_at OR
     NEW.snapshot ->> 'pricingMethod' IS DISTINCT FROM v_rate.pricing_method OR
     NEW.snapshot ->> 'methodologyVersion' IS DISTINCT FROM v_rate.methodology_version::text OR
     NEW.snapshot ->> 'quantityConversionMethod' IS DISTINCT FROM v_rate.quantity_conversion_method OR
     NEW.snapshot ->> 'roundingMode' IS DISTINCT FROM v_rate.rounding_mode OR
     NEW.snapshot ->> 'roundingBoundary' IS DISTINCT FROM v_rate.rounding_boundary OR
     NEW.snapshot ->> 'chargeCeilingMethod' IS DISTINCT FROM v_rate.charge_ceiling_method OR
     NEW.snapshot ->> 'chargeCeilingBoundary' IS DISTINCT FROM v_rate.charge_ceiling_boundary OR
     EXISTS (SELECT 1 FROM medicaid_payer_rate_policy newer
       WHERE newer.organization_id = v_rate.organization_id AND newer.provider_entity_id = v_rate.provider_entity_id
         AND newer.canonical_payer_id = v_rate.canonical_payer_id AND newer.program_kind = v_rate.program_kind
         AND newer.service_state = v_rate.service_state AND newer.service_category = v_rate.service_category
         AND newer.locality_code = v_rate.locality_code AND newer.unit_basis = v_rate.unit_basis
         AND newer.effective_from = v_rate.effective_from AND newer.version > v_rate.version) THEN
    RAISE EXCEPTION 'IRC pricing snapshot rate is not the current verified payer rate' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_evidence FROM medicaid_hospice_billing_evidence
    WHERE organization_id = NEW.organization_id AND id = NEW.billing_evidence_id;
  IF NOT FOUND OR v_evidence.provider_entity_id IS DISTINCT FROM NEW.provider_entity_id OR
     v_evidence.patient_id IS DISTINCT FROM v_claim.patient_id OR
     v_evidence.admission_id IS DISTINCT FROM v_claim.admission_id OR
     v_evidence.canonical_payer_id IS DISTINCT FROM v_claim.canonical_payer_id OR
     v_evidence.program_kind <> 'managed_care' OR v_evidence.service_state <> 'OR' OR
     v_evidence.service_category <> 'IRC' OR v_evidence.verification_status <> 'verified' OR
     v_evidence.quantity_policy <> 'm37_irc_episode_daily_v1' OR
     v_evidence.quantity_evidence_owner <> 'm37_irc_episode_and_remote_stay' OR
     v_evidence.billing_unit <> 'daily' OR v_evidence.revenue_code <> '0655' OR
     v_evidence.hcpcs_code <> 'Q5005' OR v_evidence.coding_profile <> 'local_draft_only' OR
     v_evidence.effective_from > v_service_from OR
     (v_evidence.effective_to IS NOT NULL AND v_evidence.effective_to < v_service_to) OR
     v_evidence.version <> (NEW.snapshot ->> 'billingEvidenceVersion')::integer OR
     v_evidence.verified_at IS NULL OR v_evidence.verified_at > NEW.assessed_at OR
     v_evidence.created_at > NEW.assessed_at OR
     v_rate.locality_code IS DISTINCT FROM v_evidence.locality_code OR
     v_rate.quality_reporting_applicability IS DISTINCT FROM v_evidence.quality_reporting_applicability OR
     v_rate.quality_reporting_status IS DISTINCT FROM v_evidence.quality_reporting_status OR
     NEW.snapshot ->> 'localBillingProfile' IS DISTINCT FROM 'irc_hospital_q5005_daily_local_v1' OR
     NEW.snapshot ->> 'rateSourceKind' IS DISTINCT FROM v_rate.source_kind OR
     NEW.snapshot ->> 'rateDocumentReference' IS DISTINCT FROM v_rate.source_document_ref OR
     NEW.snapshot ->> 'rateVersion' IS DISTINCT FROM v_rate.version::text OR
     NEW.snapshot ->> 'rateCents' IS DISTINCT FROM v_rate.rate_cents::text OR
     NEW.snapshot ->> 'billingEvidenceVersion' IS DISTINCT FROM v_evidence.version::text OR
     NEW.snapshot ->> 'billedChargeCentsPerUnit' IS DISTINCT FROM v_evidence.billed_charge_cents_per_unit::text OR
     NEW.snapshot #>> '{locality,code}' IS DISTINCT FROM v_evidence.locality_code OR
     NEW.snapshot #>> '{locality,evidenceReference}' IS DISTINCT FROM v_evidence.locality_evidence_reference OR
     NEW.snapshot #>> '{locality,evidenceVersion}' IS DISTINCT FROM v_evidence.locality_evidence_version::text OR
     NEW.snapshot #>> '{qualityReporting,applicability}' IS DISTINCT FROM v_evidence.quality_reporting_applicability OR
     NEW.snapshot #>> '{qualityReporting,status}' IS DISTINCT FROM v_evidence.quality_reporting_status OR
     NEW.snapshot #>> '{qualityReporting,evidenceReference}' IS DISTINCT FROM v_evidence.quality_evidence_reference OR
     NEW.snapshot #>> '{qualityReporting,evidenceVersion}' IS DISTINCT FROM v_evidence.quality_evidence_version::text OR
     NEW.snapshot ->> 'codingEvidenceReference' IS DISTINCT FROM v_evidence.coding_evidence_reference OR
     NEW.snapshot ->> 'codingEvidenceVersion' IS DISTINCT FROM v_evidence.coding_evidence_version::text OR
     NEW.snapshot ->> 'chargeEvidenceReference' IS DISTINCT FROM v_evidence.charge_evidence_reference OR
     NEW.snapshot ->> 'chargeEvidenceVersion' IS DISTINCT FROM v_evidence.charge_evidence_version::text OR
     NEW.snapshot ->> 'sourceDocumentReference' IS DISTINCT FROM v_evidence.source_document_reference OR
     NEW.snapshot ->> 'billedChargeCents' IS DISTINCT FROM
       (v_evidence.billed_charge_cents_per_unit::bigint * v_units::bigint)::text OR
     v_claim.canonical_payer_id IS DISTINCT FROM v_rate.canonical_payer_id OR
     v_claim.service_state IS DISTINCT FROM v_rate.service_state OR
     NEW.fingerprint IS DISTINCT FROM encode(digest((NEW.snapshot - 'assessmentTimestamp')::text, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'IRC pricing snapshot source identity, charge or integrity evidence does not match' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER trg_medicaid_claim_line_pricing_snapshot_insert_irc
  BEFORE INSERT ON medicaid_claim_line_pricing_snapshot
  FOR EACH ROW WHEN (NEW.snapshot_schema_version = 4)
  EXECUTE FUNCTION guard_medicaid_claim_line_pricing_snapshot_insert_irc();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_medicaid_claim_line_pricing_snapshot_supported_profile ON medicaid_claim_line_pricing_snapshot;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_claim_line_pricing_snapshot_supported_profile
  BEFORE INSERT ON medicaid_claim_line_pricing_snapshot FOR EACH ROW
  EXECUTE FUNCTION guard_medicaid_claim_line_pricing_snapshot_supported_profile();--> statement-breakpoint
COMMENT ON FUNCTION guard_medicaid_claim_line_pricing_snapshot_supported_profile() IS
  'Restricts v1/v2 to their historical home/ALF RHC profiles and v3 to the source-backed local home RHC election-day bucket profile; no profile qualifies institutional transmission.';
