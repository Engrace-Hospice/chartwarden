-- M26 Cap Management §3.5 — per-table RLS + the CANONICAL app.org_id policy + least-privilege grants for
-- all 11 ORG-SCOPED M26 tables (every one carries organization_id NOT NULL; NONE is on the check-tenancy
-- NON_ORG_SCOPED allowlist — that is reserved for cap_period_platform_constant, handled in 0089). The
-- platform constant's read-all/platform-write policy is ISOLATED in 0089 (the 0078 wage-index precedent).
--
-- ONE RLS SHAPE (§3.5 / ADR-0010, CANONICAL): every policy is
--   USING/WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid)
-- — NO subqueries, NO EXISTS, NO nullable-org escape branch. For the three LIST(cap_period_id)-partitioned
-- parents the policy + grants are declared on the PARENT only (propagate to every partition, PG11+).
--
-- Append-only tables (§3.6): cap_beneficiary_accrual_line / cap_inpatient_day_line / cap_projection_snapshot
-- get SELECT+INSERT only (NO UPDATE/DELETE for wardenx_app — corrections are new reversal/adjustment lines;
-- snapshots are insert-only). The mutable roll-ups/queue/settlement get SELECT+INSERT+UPDATE. wardenx_admin
-- gets ALL (the §3.7 eraser redacts under wardenx_admin).

-- cap_period
ALTER TABLE "cap_period" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cap_period_org" ON "cap_period" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cap_period" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cap_period" TO wardenx_admin;--> statement-breakpoint

-- cap_period_methodology_lock
ALTER TABLE "cap_period_methodology_lock" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cap_methodology_lock_org" ON "cap_period_methodology_lock" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cap_period_methodology_lock" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cap_period_methodology_lock" TO wardenx_admin;--> statement-breakpoint

-- cap_beneficiary_accrual
ALTER TABLE "cap_beneficiary_accrual" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cap_ben_accrual_org" ON "cap_beneficiary_accrual" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cap_beneficiary_accrual" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cap_beneficiary_accrual" TO wardenx_admin;--> statement-breakpoint

-- cap_beneficiary_accrual_line (partitioned parent; append-only → SELECT+INSERT)
ALTER TABLE "cap_beneficiary_accrual_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cap_ben_accrual_line_org" ON "cap_beneficiary_accrual_line" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "cap_beneficiary_accrual_line" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cap_beneficiary_accrual_line" TO wardenx_admin;--> statement-breakpoint

-- cap_inpatient_accrual
ALTER TABLE "cap_inpatient_accrual" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cap_inp_accrual_org" ON "cap_inpatient_accrual" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cap_inpatient_accrual" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cap_inpatient_accrual" TO wardenx_admin;--> statement-breakpoint

-- cap_inpatient_day_line (partitioned parent; append-only → SELECT+INSERT)
ALTER TABLE "cap_inpatient_day_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cap_inp_day_line_org" ON "cap_inpatient_day_line" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "cap_inpatient_day_line" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cap_inpatient_day_line" TO wardenx_admin;--> statement-breakpoint

-- cap_projection_snapshot (partitioned parent; append-only → SELECT+INSERT)
ALTER TABLE "cap_projection_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cap_projection_snapshot_org" ON "cap_projection_snapshot" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "cap_projection_snapshot" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cap_projection_snapshot" TO wardenx_admin;--> statement-breakpoint

-- cap_threshold_event
ALTER TABLE "cap_threshold_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cap_threshold_event_org" ON "cap_threshold_event" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cap_threshold_event" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cap_threshold_event" TO wardenx_admin;--> statement-breakpoint

-- cap_psr_import
ALTER TABLE "cap_psr_import" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cap_psr_import_org" ON "cap_psr_import" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cap_psr_import" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cap_psr_import" TO wardenx_admin;--> statement-breakpoint

-- cap_psr_reconciliation
ALTER TABLE "cap_psr_reconciliation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cap_psr_recon_org" ON "cap_psr_reconciliation" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cap_psr_reconciliation" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cap_psr_reconciliation" TO wardenx_admin;--> statement-breakpoint

-- cap_settlement
ALTER TABLE "cap_settlement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cap_settlement_org" ON "cap_settlement" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cap_settlement" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cap_settlement" TO wardenx_admin;
