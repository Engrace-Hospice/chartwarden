-- M23 Billing — Medicare §3.5 (RLS & Grants) — per-table RLS + the CANONICAL app.org_id policy +
-- least-privilege grants for the 16 ORG-SCOPED M23 tables. wage_index_factor is platform-shared (no
-- organization_id) and is handled in the isolated 0078 (read-all + platform-loader write). Tables/enums/
-- indexes land in 0074–0076; the M4 write-audit + append-only triggers in 0079.
--
-- ONE RLS SHAPE (§3.5 / ADR-0010, CANONICAL): every policy is
--   USING/WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid)
-- — NO subqueries, NO EXISTS, NO pg_has_role, NO nullable-org escape branch. wardenx_app gets
-- SELECT/INSERT/UPDATE (NO DELETE — rows are never SQL-deleted; the §3.7 eraser redacts under
-- wardenx_admin; append-only tables additionally block UPDATE via 0079). wardenx_admin gets ALL.
-- For the four partitioned parents (claim, claim_state_history, validation_run, validation_result) the
-- policy + grants are declared on the PARENT only — they propagate to every partition (PG11+, the M30
-- precedent). The §3.5 augmented ABAC write policies (provider-entity scope, override approver,
-- regulatory-rule protection) layer in P3 when the M3 predicates wire — this canonical org policy is the
-- P1 floor.
ALTER TABLE "claim" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "claim_org" ON "claim"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "claim" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "claim" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "claim_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "claim_line_org" ON "claim_line"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "claim_line" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "claim_line" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "claim_state_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "claim_state_history_org" ON "claim_state_history"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "claim_state_history" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "claim_state_history" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "claim_submission" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "claim_submission_org" ON "claim_submission"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "claim_submission" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "claim_submission" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "claim_acknowledgment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "claim_acknowledgment_org" ON "claim_acknowledgment"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "claim_acknowledgment" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "claim_acknowledgment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "noe_record" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "noe_record_org" ON "noe_record"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "noe_record" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "noe_record" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "notr_record" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "notr_record_org" ON "notr_record"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "notr_record" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "notr_record" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "hipps_calculation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hipps_calculation_org" ON "hipps_calculation"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "hipps_calculation" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "hipps_calculation" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "sia_calculation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sia_calculation_org" ON "sia_calculation"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "sia_calculation" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "sia_calculation" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "validation_rule_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "validation_rule_config_org" ON "validation_rule_config"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "validation_rule_config" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "validation_rule_config" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "validation_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "validation_run_org" ON "validation_run"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "validation_run" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "validation_run" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "validation_result" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "validation_result_org" ON "validation_result"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "validation_result" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "validation_result" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "validation_override" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "validation_override_org" ON "validation_override"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "validation_override" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "validation_override" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "sequestration_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sequestration_policy_org" ON "sequestration_policy"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "sequestration_policy" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "sequestration_policy" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "mac_submitter_credential" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "mac_submitter_credential_org" ON "mac_submitter_credential"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "mac_submitter_credential" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "mac_submitter_credential" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "eligibility_check" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "eligibility_check_org" ON "eligibility_check"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "eligibility_check" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "eligibility_check" TO wardenx_admin;
