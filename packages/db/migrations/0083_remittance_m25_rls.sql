-- M25 Remittance & Denials §3.5 (RLS & Grants) — per-table RLS + the CANONICAL app.org_id policy +
-- least-privilege grants for all 11 ORG-SCOPED M25 tables (every table carries organization_id NOT NULL;
-- NONE are on the check-tenancy NON_ORG_SCOPED allowlist — including denial_taxonomy_overlay, which is
-- strictly org-scoped per M25-F09). Tables/enums land in 0081-0082; M4 write-audit + appeal closed-row
-- immutability in 0084.
--
-- ONE RLS SHAPE (§3.5 / ADR-0010, CANONICAL): every policy is
--   USING/WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid)
-- — NO subqueries, NO EXISTS, NO pg_has_role, NO nullable-org escape branch. wardenx_app gets
-- SELECT/INSERT/UPDATE (NO DELETE — the §3.7 eraser redacts under wardenx_admin); wardenx_admin gets ALL.
-- For the four partitioned parents (remittance_line/service_line/adjustment/remark) the policy + grants
-- are declared on the PARENT only — they propagate to every partition (PG11+, the M30/M23 precedent). The
-- §3.5 augmented ABAC write narrowing (provider_entity_scope, claim_assigned_to_actor) layers in P3 at the
-- application layer — this canonical org policy is the P1 isolation floor.
ALTER TABLE "remittance_advice" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "remittance_advice_org" ON "remittance_advice"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "remittance_advice" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "remittance_advice" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "remittance_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "remittance_line_org" ON "remittance_line"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "remittance_line" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "remittance_line" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "remittance_service_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "remittance_service_line_org" ON "remittance_service_line"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "remittance_service_line" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "remittance_service_line" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "remittance_adjustment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "remittance_adjustment_org" ON "remittance_adjustment"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "remittance_adjustment" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "remittance_adjustment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "remittance_remark" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "remittance_remark_org" ON "remittance_remark"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "remittance_remark" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "remittance_remark" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "denial_case" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "denial_case_org" ON "denial_case"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "denial_case" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "denial_case" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "denial_case_assignment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "denial_case_assignment_org" ON "denial_case_assignment"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "denial_case_assignment" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "denial_case_assignment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "appeal_case" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "appeal_case_org" ON "appeal_case"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "appeal_case" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "appeal_case" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "appeal_case_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "appeal_case_event_org" ON "appeal_case_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "appeal_case_event" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "appeal_case_event" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "denial_taxonomy_overlay" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "denial_taxonomy_overlay_org" ON "denial_taxonomy_overlay"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "denial_taxonomy_overlay" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "denial_taxonomy_overlay" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "patient_responsibility_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "patient_responsibility_ledger_org" ON "patient_responsibility_ledger"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_responsibility_ledger" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient_responsibility_ledger" TO wardenx_admin;
