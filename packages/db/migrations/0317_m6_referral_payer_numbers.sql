-- M6 referral intake — the patient's Medicare number (MBI) and Medicaid number as given by the referrer.
--
-- Captured on the referral before a canonical patient exists (like `patient_name_at_receipt` /
-- `patient_dob_at_receipt`). Stored normalized (no dashes/spaces, upper case).
--   * Medicare: held to the CMS MBI format of `patient_identifier`. When the referral creates or is
--     matched to a patient, M5's intake resolver records it as the patient's `mbi` identifier if the
--     chart has none yet; from there it pre-fills HOPE A0600B and the Patient Summary.
--   * Medicaid: state formats vary, so only HOPE A0700's shape (1-14 alphanumerics) is enforced. M5
--     keeps a Medicaid ID on the `patient_payer` row (M5 §2 "Payers"), which needs the state payer, so
--     the number pre-fills the intake Coverage / Payers form rather than being written automatically.
ALTER TABLE "referral" ADD COLUMN "medicare_number_at_receipt" text;--> statement-breakpoint
ALTER TABLE "referral" ADD COLUMN "medicaid_number_at_receipt" text;--> statement-breakpoint
ALTER TABLE "referral" ADD CONSTRAINT "referral_medicare_number_format"
  CHECK ("medicare_number_at_receipt" IS NULL
    OR "medicare_number_at_receipt" ~ '^[1-9][AC-HJ-NP-RT-Y][0-9AC-HJ-NP-RT-Y]{9}$');--> statement-breakpoint
ALTER TABLE "referral" ADD CONSTRAINT "referral_medicaid_number_format"
  CHECK ("medicaid_number_at_receipt" IS NULL
    OR "medicaid_number_at_receipt" ~ '^[A-Z0-9]{1,14}$');--> statement-breakpoint
-- Both numbers are PHI: add them to the referral write-audit scrub list (0027 denylist + new columns).
CREATE OR REPLACE FUNCTION audit_phi_write_referral() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['patient_dob_at_receipt', 'patient_name_at_receipt', 'referrer_phone', 'referring_dx_text', 'medicare_number_at_receipt', 'medicaid_number_at_receipt']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['patient_dob_at_receipt', 'patient_name_at_receipt', 'referrer_phone', 'referring_dx_text', 'medicare_number_at_receipt', 'medicaid_number_at_receipt']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'referral.' || lower(TG_OP),
    'referral',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_referral() OWNER TO wardenx_audit_writer;
