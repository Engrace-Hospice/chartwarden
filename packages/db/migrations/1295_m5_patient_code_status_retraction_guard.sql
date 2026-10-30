-- compat: expand
-- ADR-0104 follow-up — once a patient_code_status entry is entered-in-error it is frozen. 1294's column-level UPDATE
-- grant already stops a recorded value being edited, but it still lets the app role overwrite or clear the
-- `entered_in_error_*` columns (rewriting who retracted an entry, or un-retracting it). A BEFORE UPDATE trigger closes
-- that in the database, not only in the route's "already entered in error" check. Idempotent.
CREATE OR REPLACE FUNCTION patient_code_status_guard_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.entered_in_error_at IS NOT NULL THEN
    RAISE EXCEPTION 'patient_code_status: an entry already entered-in-error cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "trg_patient_code_status_guard_update" BEFORE UPDATE ON "patient_code_status"
  FOR EACH ROW EXECUTE FUNCTION patient_code_status_guard_update();
