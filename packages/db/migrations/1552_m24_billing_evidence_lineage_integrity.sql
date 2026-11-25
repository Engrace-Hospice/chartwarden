-- compat: contract
-- L8A.2C: preserve full patient/program identity across append-only billing-evidence corrections and
-- prevent correction branches. This changes no historical evidence and does not promote any row.

ALTER TABLE medicaid_hospice_billing_evidence
  DROP CONSTRAINT medicaid_hospice_billing_evidence_identity_uq;--> statement-breakpoint
ALTER TABLE medicaid_hospice_billing_evidence
  ADD CONSTRAINT medicaid_hospice_billing_evidence_identity_uq UNIQUE NULLS NOT DISTINCT
    (organization_id, provider_entity_id, patient_id, admission_id, canonical_payer_id,
     program_kind, service_state, service_category, effective_from, supersedes_id);--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_hospice_billing_evidence_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_provider_org uuid; v_prior medicaid_hospice_billing_evidence%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'm24-hospice-evidence:' || NEW.organization_id::text || ':' || NEW.provider_entity_id::text || ':' ||
    NEW.patient_id::text || ':' || NEW.admission_id::text || ':' || NEW.canonical_payer_id::text || ':' ||
    NEW.program_kind || ':' || NEW.service_state || ':' || NEW.service_category, 0));
  SELECT organization_id INTO v_provider_org FROM provider_entity WHERE id = NEW.provider_entity_id;
  IF v_provider_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'hospice billing evidence provider entity must belong to its organization' USING ERRCODE='23514';
  END IF;
  IF current_user = 'chartwarden_app' THEN
    RAISE EXCEPTION 'hospice billing evidence requires the authorized evidence-verification writer' USING ERRCODE='42501';
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO v_prior FROM medicaid_hospice_billing_evidence
     WHERE organization_id = NEW.organization_id AND id = NEW.supersedes_id;
    IF NOT FOUND OR ROW(v_prior.organization_id, v_prior.provider_entity_id, v_prior.patient_id,
                        v_prior.admission_id, v_prior.canonical_payer_id, v_prior.program_kind,
                        v_prior.service_state, v_prior.service_category, v_prior.effective_from)
       IS DISTINCT FROM ROW(NEW.organization_id, NEW.provider_entity_id, NEW.patient_id,
                            NEW.admission_id, NEW.canonical_payer_id, NEW.program_kind,
                            NEW.service_state, NEW.service_category, NEW.effective_from) THEN
      RAISE EXCEPTION 'hospice billing evidence correction must preserve the complete source identity' USING ERRCODE='23514';
    END IF;
    IF NEW.version <> v_prior.version + 1 THEN
      RAISE EXCEPTION 'hospice billing evidence correction must increment its source version' USING ERRCODE='23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM medicaid_hospice_billing_evidence sibling
       WHERE sibling.organization_id = NEW.organization_id
         AND sibling.supersedes_id = NEW.supersedes_id
    ) THEN
      RAISE EXCEPTION 'hospice billing evidence correction history cannot branch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

COMMENT ON FUNCTION guard_medicaid_hospice_billing_evidence_insert() IS
  'Serializes scoped evidence writes; corrections preserve organization/provider/patient/admission/payer/program/state/category/effective-start identity, increment version, and cannot branch.';
