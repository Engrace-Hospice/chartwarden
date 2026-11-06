-- compat: expand
-- ADR-0109 review follow-up - M16: the `bereavement_record` eraser (`createDrizzleBereavementEraseStore`) shreds the PHI-bearing columns of the
-- decedent's subtree and then deletes it, but until now NO M16 table granted `chartwarden_destruction` anything (0102 granted the app role and
-- the admin role; 1342/1343/1345 granted the app role only). Bound to the destruction connection, the very first shred UPDATE died with 42501,
-- so a destruction certificate could not erase a bereavement record. Same posture as 1201 / 1205 / 1287: the destruction role gets exactly what
-- the eraser runs, with an org-pinned FOR ALL policy per table; the app role is NOT widened.
--   * SELECT + DELETE: bereavement_assessment_task, bereavement_anniversary_reminder (nothing to shred; deleted with the plan).
--   * SELECT + DELETE + a COLUMN-limited UPDATE (only the columns the shred step empties):
--       bereavement_risk_assessment_draft(factors_jsonb), bereaved_contact(email/phone/mailing_address/care_goals ciphers, ineligible reason),
--       bereavement_contact_log(contact_notes_cipher), bereavement_physician_letter(personal_note_cipher, decline_reason_redacted),
--       bereavement_risk_score(risk_factors_jsonb, augmented_narrative_redacted), bereavement_opt_out(reason_redacted),
--       bereavement_outreach(cancellation_reason_redacted, version).
--   * SELECT + a COLUMN-limited UPDATE, no DELETE (the root is a TOMBSTONE and the closure row SURVIVES, 7.15): bereavement_plan(the redacted
--     narratives, the risk-tier cache, external_source_metadata), bereavement_plan_closure(reason_narrative_redacted).
-- The risk-score ledger is append-only (0102: an UPDATE raised for every role), so the shred of `risk_factors_jsonb` could never have run.
-- The guard now admits an UPDATE from a NON-superuser member of chartwarden_destruction (the 1298 shape; the column-limited grant above is what
-- confines it to the two shred columns). The app role and a superuser are still refused.
CREATE OR REPLACE FUNCTION m16_bereavement_risk_score_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(current_user, 'chartwarden_destruction', 'MEMBER')
     AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'M16_RISK_SCORE_IMMUTABLE: bereavement_risk_score % is append-only; record a new score row instead of updating', OLD.id;
END $$;--> statement-breakpoint

GRANT SELECT, DELETE ON "bereavement_assessment_task" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "bereavement_anniversary_reminder" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "bereavement_risk_assessment_draft" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "bereaved_contact" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "bereavement_contact_log" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "bereavement_physician_letter" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "bereavement_risk_score" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "bereavement_opt_out" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "bereavement_outreach" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT ON "bereavement_plan" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT ON "bereavement_plan_closure" TO chartwarden_destruction;--> statement-breakpoint

GRANT UPDATE ("factors_jsonb") ON "bereavement_risk_assessment_draft" TO chartwarden_destruction;--> statement-breakpoint
GRANT UPDATE ("email_cipher", "phone_cipher", "mailing_address_cipher", "care_goals_cipher", "ineligible_reason_redacted") ON "bereaved_contact" TO chartwarden_destruction;--> statement-breakpoint
GRANT UPDATE ("contact_notes_cipher") ON "bereavement_contact_log" TO chartwarden_destruction;--> statement-breakpoint
GRANT UPDATE ("personal_note_cipher", "decline_reason_redacted") ON "bereavement_physician_letter" TO chartwarden_destruction;--> statement-breakpoint
GRANT UPDATE ("risk_factors_jsonb", "augmented_narrative_redacted") ON "bereavement_risk_score" TO chartwarden_destruction;--> statement-breakpoint
GRANT UPDATE ("reason_redacted") ON "bereavement_opt_out" TO chartwarden_destruction;--> statement-breakpoint
GRANT UPDATE ("cancellation_reason_redacted", "version") ON "bereavement_outreach" TO chartwarden_destruction;--> statement-breakpoint
GRANT UPDATE ("pause_reason_redacted", "ipoc_bereavement_intent_summary_redacted", "early_close_narrative_redacted", "current_risk_tier", "current_risk_computed_at", "external_source_metadata") ON "bereavement_plan" TO chartwarden_destruction;--> statement-breakpoint
GRANT UPDATE ("reason_narrative_redacted") ON "bereavement_plan_closure" TO chartwarden_destruction;--> statement-breakpoint

CREATE POLICY "bereavement_assessment_task_destruction" ON "bereavement_assessment_task"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "bereavement_anniversary_reminder_destruction" ON "bereavement_anniversary_reminder"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "bereavement_risk_assessment_draft_destruction" ON "bereavement_risk_assessment_draft"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "bereaved_contact_destruction" ON "bereaved_contact"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "bereavement_contact_log_destruction" ON "bereavement_contact_log"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "bereavement_physician_letter_destruction" ON "bereavement_physician_letter"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "bereavement_risk_score_destruction" ON "bereavement_risk_score"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "bereavement_opt_out_destruction" ON "bereavement_opt_out"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "bereavement_outreach_destruction" ON "bereavement_outreach"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "bereavement_plan_destruction" ON "bereavement_plan"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "bereavement_plan_closure_destruction" ON "bereavement_plan_closure"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
