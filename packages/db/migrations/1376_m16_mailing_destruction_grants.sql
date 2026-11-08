-- compat: expand
-- ADR-0109 D10 - M16: the `bereavement_record` eraser now deletes the decedent's mailing ITEMS (the only mailing table that names a plan and a contact; a
-- RESTRICT FK on `bereaved_contact`, so an item left behind would block the contact delete and abort the destruction). Same posture as 1348: the
-- destruction role gets exactly what the eraser runs - SELECT + DELETE on `bereavement_mailing_item` (an item holds ids, ciphertext-free, so there is
-- nothing to shred first) with an org-pinned FOR ALL policy; the app role is NOT widened. The org-level `bereavement_mailing_config` and
-- `bereavement_mailing_run` hold no per-patient data and are never erased by a decedent's certificate. The run's batch PDF (an M22 document) is
-- governed by the M22 retention class `bereavement`; a purge job for it is deferred (the blueprint's section 4: compliance decides retention).
GRANT SELECT, DELETE ON "bereavement_mailing_item" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "bereavement_mailing_item_destruction" ON "bereavement_mailing_item"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
