-- 1287: M41 tenant erasure (issue #838). Every M41 table carries `organization_id` with a RESTRICT FK to `organization`, and until
-- now only the app role could touch them (no DELETE), so an org-destruction run died on the first FK violation. Mirror 1281 / 1067:
-- the destruction role gets SELECT + DELETE and a destruction policy pinned on `app.org_id`, per table. The app role is NOT widened.
--
-- One extra grant: `commercial_claim.latest_validation_run_id` and `commercial_validation_run.claim_id` point at each other with
-- RESTRICT FKs (neither deferrable), so neither table can be deleted first. The eraser clears the claim's run pointer, then deletes the
-- runs, then the claims; the destruction role therefore gets a COLUMN-limited UPDATE on that one column (RLS still pins it to the org).
-- The other triggers do not block the destruction role: the state guard fires only on UPDATE OF state, the quarantine delete guard
-- (1286) only for current_user = 'chartwarden_app', and the audit triggers are SECURITY DEFINER inserts into audit_event.
DO $$ BEGIN
  GRANT SELECT, DELETE ON "commercial_payer_plan" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "commercial_payer_plan_destruction" ON "commercial_payer_plan"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "commercial_payer_route" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "commercial_payer_route_destruction" ON "commercial_payer_route"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "commercial_contract_rate" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "commercial_contract_rate_destruction" ON "commercial_contract_rate"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "commercial_payer_enrollment" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "commercial_payer_enrollment_destruction" ON "commercial_payer_enrollment"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "commercial_eligibility_check" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "commercial_eligibility_check_destruction" ON "commercial_eligibility_check"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "commercial_authorization" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "commercial_authorization_destruction" ON "commercial_authorization"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "commercial_claim" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "commercial_claim_destruction" ON "commercial_claim"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "commercial_claim_line" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "commercial_claim_line_destruction" ON "commercial_claim_line"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "commercial_claim_state_history" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "commercial_claim_state_history_destruction" ON "commercial_claim_state_history"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "commercial_validation_run" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "commercial_validation_run_destruction" ON "commercial_validation_run"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "commercial_validation_result" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "commercial_validation_result_destruction" ON "commercial_validation_result"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "commercial_validation_override" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "commercial_validation_override_destruction" ON "commercial_validation_override"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "commercial_submission" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "commercial_submission_destruction" ON "commercial_submission"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "commercial_acknowledgment" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "commercial_acknowledgment_destruction" ON "commercial_acknowledgment"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "commercial_ack_quarantine" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "commercial_ack_quarantine_destruction" ON "commercial_ack_quarantine"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "commercial_ack_cursor" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "commercial_ack_cursor_destruction" ON "commercial_ack_cursor"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  GRANT UPDATE ("latest_validation_run_id") ON "commercial_claim" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
