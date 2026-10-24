-- M5 GAP-020 follow-up: the record-destruction eraser (erasePatientSubtree) deletes `patient_wristband` rows on the
-- destruction connection, but 0850 granted the table to the app/admin roles only, so every patient erase aborted
-- with 42501 at the wristband step. Same posture as the other patient-keyed satellites in 0157: SELECT + DELETE and
-- an org-pinned FOR ALL policy for chartwarden_destruction. Idempotent.
GRANT SELECT, DELETE ON "patient_wristband" TO chartwarden_destruction;--> statement-breakpoint
DROP POLICY IF EXISTS "patient_wristband_destruction" ON "patient_wristband";--> statement-breakpoint
CREATE POLICY "patient_wristband_destruction" ON "patient_wristband"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
