-- M27 Cost Report §3.5 (RLS & Grants) — per-table RLS + the CANONICAL app.org_id policy + least-
-- privilege grants for ALL 14 M27 tables. Tables/enums/indexes/FKs land in 0069; the
-- cost_report_validation_rule platform-default SELECT branch (org-NULL read) is isolated in 0071 (the
-- feature_flag/role-template precedent); the M4 write-audit triggers in 0072.
--
-- ONE RLS SHAPE (§3.5 / ADR-0010, CANONICAL): every policy is
--   USING/WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid)
-- — NO subqueries, NO EXISTS(SELECT…), NO pg_has_role(...). wardenx_app gets SELECT/INSERT/UPDATE on
-- every table (NO DELETE — rows are never SQL-deleted; the §3.7 eraseFn redacts under wardenx_admin).
-- wardenx_admin gets ALL. cost_report_validation_rule's FOR ALL policy uses the same canonical predicate
-- (platform rows org=NULL never match → not tenant-writable, not tenant-readable via THIS policy); the
-- org-NULL READ branch is added by the isolated 0071 SELECT policy (permissive policies OR together).
--
-- NB: the §3.5 augmented ABAC write policies (cost_report provider-entity scope, validation_override
-- approver, snapshot system-only insert-only) are layered when the M3 predicates + service callers wire
-- in P3 — the canonical org policy is the P1 floor.
ALTER TABLE "cost_report" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cost_report_org" ON "cost_report"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cost_report" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cost_report" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "cost_report_worksheet" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cost_report_worksheet_org" ON "cost_report_worksheet"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cost_report_worksheet" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cost_report_worksheet" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "cost_report_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cost_report_snapshot_org" ON "cost_report_snapshot"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cost_report_snapshot" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cost_report_snapshot" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "cost_report_validation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cost_report_validation_org" ON "cost_report_validation"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cost_report_validation" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cost_report_validation" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "cost_report_validation_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cost_report_validation_rule_org" ON "cost_report_validation_rule"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cost_report_validation_rule" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cost_report_validation_rule" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "cost_report_validation_result" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cost_report_validation_result_org" ON "cost_report_validation_result"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cost_report_validation_result" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cost_report_validation_result" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "cost_report_validation_override" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cost_report_validation_override_org" ON "cost_report_validation_override"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cost_report_validation_override" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cost_report_validation_override" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "bad_debt_record" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bad_debt_record_org" ON "bad_debt_record"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "bad_debt_record" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "bad_debt_record" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "statistic_data" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "statistic_data_org" ON "statistic_data"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "statistic_data" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "statistic_data" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "trial_balance_import" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "trial_balance_import_org" ON "trial_balance_import"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "trial_balance_import" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "trial_balance_import" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "wage_data_import" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "wage_data_import_org" ON "wage_data_import"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "wage_data_import" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "wage_data_import" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "cost_center_mapping" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cost_center_mapping_org" ON "cost_center_mapping"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cost_center_mapping" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cost_center_mapping" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ecr_submission" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ecr_submission_org" ON "ecr_submission"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "ecr_submission" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "ecr_submission" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "cost_report_compliance_window" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cost_report_compliance_window_org" ON "cost_report_compliance_window"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cost_report_compliance_window" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cost_report_compliance_window" TO wardenx_admin;
