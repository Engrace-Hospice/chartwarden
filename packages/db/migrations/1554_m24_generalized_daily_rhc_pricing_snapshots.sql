-- compat: contract
-- L8A.2C1: preserve pricing snapshot v1 (home RHC/Q5001) and add one explicitly supported v2
-- local-draft profile (assisted-living RHC/Q5002). No historical snapshot is rewritten.

-- No privilege on the M40-owned `facility` table is granted here: the snapshot trigger reads it only through
-- 1553's SECURITY DEFINER function, and M23's established reader already reads it as the application role.

ALTER TABLE medicaid_hospice_billing_evidence
  DROP CONSTRAINT medicaid_hospice_billing_evidence_pricing_facts;--> statement-breakpoint
ALTER TABLE medicaid_hospice_billing_evidence
  ADD CONSTRAINT medicaid_hospice_billing_evidence_pricing_facts CHECK (
    locality_code <> '' AND billed_charge_cents_per_unit > 0 AND
    quantity_policy = 'active_rhc_loc_calendar_day' AND
    quantity_evidence_owner = 'm6_level_of_care_period' AND billing_unit = 'daily' AND
    revenue_code = '0651' AND hcpcs_code IN ('Q5001', 'Q5002') AND
    coding_profile = 'local_draft_only'
  );--> statement-breakpoint

ALTER TABLE medicaid_claim_line_pricing_snapshot
  DROP CONSTRAINT medicaid_claim_line_pricing_snapshot_fingerprint;--> statement-breakpoint
ALTER TABLE medicaid_claim_line_pricing_snapshot
  ADD CONSTRAINT medicaid_claim_line_pricing_snapshot_fingerprint CHECK (
    fingerprint ~ '^[0-9a-f]{64}$' AND snapshot_schema_version IN (1, 2)
  );--> statement-breakpoint
ALTER TABLE medicaid_claim_line_pricing_snapshot
  DROP CONSTRAINT medicaid_claim_line_pricing_snapshot_shape;--> statement-breakpoint
ALTER TABLE medicaid_claim_line_pricing_snapshot
  -- IS TRUE: a snapshot missing `schemaVersion` or `postingAuthorized` makes an operand NULL, and a
  -- CHECK accepts NULL, so without it a malformed document would pass.
  ADD CONSTRAINT medicaid_claim_line_pricing_snapshot_shape CHECK ((
    jsonb_typeof(snapshot) = 'object' AND
    snapshot ->> 'schemaVersion' = snapshot_schema_version::text AND
    snapshot ->> 'postingAuthorized' = 'false' AND snapshot ? 'assessmentTimestamp' AND
    ((snapshot_schema_version = 1 AND snapshot ->> 'hcpcsCode' = 'Q5001' AND
      snapshot #>> '{serviceLocation,kind}' = 'home' AND
      snapshot #>> '{serviceLocation,facilityId}' IS NULL AND
      NOT (snapshot ? 'localBillingProfile')) OR
     (snapshot_schema_version = 2 AND snapshot ->> 'hcpcsCode' = 'Q5002' AND
      snapshot ->> 'localBillingProfile' = 'rhc_assisted_living_q5002_daily_v1' AND
      snapshot #>> '{serviceLocation,kind}' = 'facility' AND
      snapshot #>> '{serviceLocation,facilityKind}' = 'alf' AND
      snapshot #>> '{serviceLocation,facilityId}' IS NOT NULL))
  ) IS TRUE);--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_claim_line_pricing_snapshot_supported_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_claim medicaid_claim%ROWTYPE;
  v_address patient_address%ROWTYPE;
  v_address_id uuid;
  v_facility_id uuid;
  v_resolved_facility_id uuid;
  v_facility_kind facility_kind;
  v_facility_status mdm_entity_status;
BEGIN
  IF NEW.snapshot_schema_version = 1 THEN
    IF NEW.snapshot ->> 'hcpcsCode' IS DISTINCT FROM 'Q5001' OR
       NEW.snapshot #>> '{serviceLocation,kind}' IS DISTINCT FROM 'home' OR
       NEW.snapshot #>> '{serviceLocation,facilityId}' IS NOT NULL OR
       NEW.snapshot ? 'localBillingProfile' THEN
      RAISE EXCEPTION 'pricing snapshot v1 is restricted to the existing home RHC profile' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.snapshot_schema_version <> 2 OR
     NEW.snapshot ->> 'hcpcsCode' IS DISTINCT FROM 'Q5002' OR
     NEW.snapshot ->> 'localBillingProfile' IS DISTINCT FROM 'rhc_assisted_living_q5002_daily_v1' OR
     NEW.snapshot #>> '{serviceLocation,kind}' IS DISTINCT FROM 'facility' OR
     NEW.snapshot #>> '{serviceLocation,facilityKind}' IS DISTINCT FROM 'alf' THEN
    RAISE EXCEPTION 'pricing snapshot v2 is restricted to the assisted-living daily RHC profile' USING ERRCODE='23514';
  END IF;

  -- Well-formedness first, so a missing or malformed field is a 23514 refusal here instead of a NULL
  -- comparison that skips the checks below: the service range's shape and both ids. (A calendar-impossible
  -- date such as 2026-02-30 still raises 22008 from the ::date cast below: refused either way.)
  IF (NEW.snapshot ->> 'serviceFrom' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') IS NOT TRUE OR
     (NEW.snapshot ->> 'serviceTo' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') IS NOT TRUE OR
     (NEW.snapshot #>> '{serviceLocation,patientAddressId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') IS NOT TRUE OR
     (NEW.snapshot #>> '{serviceLocation,facilityId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') IS NOT TRUE THEN
    RAISE EXCEPTION 'pricing snapshot v2 service range and residence identity must be well-formed' USING ERRCODE='23514';
  END IF;
  v_address_id := (NEW.snapshot #>> '{serviceLocation,patientAddressId}')::uuid;
  v_facility_id := (NEW.snapshot #>> '{serviceLocation,facilityId}')::uuid;
  SELECT * INTO v_claim FROM medicaid_claim
   WHERE organization_id = NEW.organization_id AND provider_entity_id = NEW.provider_entity_id
     AND id = NEW.medicaid_claim_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pricing snapshot claim identity is unavailable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_address FROM patient_address
   WHERE id = v_address_id AND organization_id = NEW.organization_id
     AND patient_id = v_claim.patient_id AND is_primary = true
   FOR SHARE;
  -- The snapshot binds the residence to the CLAIMED days: its recorded bounds are the line's own service
  -- days, and the live row must cover them. A later move-out that closes the open row changes no claimed
  -- day, so it must not make a stored snapshot unverifiable.
  IF NOT FOUND OR v_address.kind <> 'facility' OR v_address.facility_id IS DISTINCT FROM v_facility_id OR
     NEW.snapshot #>> '{serviceLocation,effectiveFrom}' IS DISTINCT FROM NEW.snapshot ->> 'serviceFrom' OR
     NEW.snapshot #>> '{serviceLocation,effectiveTo}' IS DISTINCT FROM NEW.snapshot ->> 'serviceTo' OR
     v_address.effective_from > (NEW.snapshot ->> 'serviceFrom')::date OR
     (v_address.effective_to IS NOT NULL AND v_address.effective_to < (NEW.snapshot ->> 'serviceTo')::date) THEN
    RAISE EXCEPTION 'pricing snapshot facility residence is not the effective M5 residence for this service range' USING ERRCODE='23514';
  END IF;
  SELECT resolved_facility_id, facility_kind, facility_status
    INTO v_resolved_facility_id, v_facility_kind, v_facility_status
    FROM m40_facility_kind_for_ids_locked(jsonb_build_array(v_facility_id));
  IF NOT FOUND OR v_resolved_facility_id IS DISTINCT FROM v_facility_id OR
     v_facility_kind <> 'alf' OR v_facility_status <> 'active' THEN
    RAISE EXCEPTION 'pricing snapshot requires an active M40 assisted-living facility identity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_claim_line_pricing_snapshot_supported_profile
  BEFORE INSERT ON medicaid_claim_line_pricing_snapshot FOR EACH ROW
  EXECUTE FUNCTION guard_medicaid_claim_line_pricing_snapshot_supported_profile();--> statement-breakpoint
COMMENT ON FUNCTION guard_medicaid_claim_line_pricing_snapshot_supported_profile() IS
  'Constrains snapshot v1 to legacy-compatible home RHC and v2 to source-backed assisted-living RHC. It does not qualify institutional transmission.';
