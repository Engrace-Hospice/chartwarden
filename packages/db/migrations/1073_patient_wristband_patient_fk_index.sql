-- fk-index-coverage (GAP-178): patient_wristband.patient_id -> patient(id) had no index leading on
-- patient_id (every wristband index leads on organization_id), so a patient delete/update scanned the
-- table. patient is not a soft-deleted-parent exception, so the FK needs its own covering index.
CREATE INDEX IF NOT EXISTS "patient_wristband_patient_id_idx" ON "patient_wristband" ("patient_id");
