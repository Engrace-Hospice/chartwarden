-- M24 Billing — Medicaid §3.5 — per-table RLS + the CANONICAL app.org_id policy + least-privilege grants
-- for all 14 owned tables (every one carries organization_id NOT NULL). ONE RLS SHAPE (ADR-0010 D3): every
-- policy is USING/WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid) — NO subqueries,
-- NO second permissive provider_entity policy (the prior spec's two-PERMISSIVE-policy OR-leak is fixed;
-- provider-entity narrowing is the M3 `provider_entity_scope` ABAC predicate at the handler, §3.5).
--
-- For the six LIST-partitioned parents (medicaid_claim / medicaid_claim_line by provider_entity_id;
-- medicaid_claim_state_history / medicaid_validation_run / medicaid_validation_result / rb_day by
-- organization_id) the policy + grants are declared on the PARENT only (propagate to every partition, PG11+).
--
-- Append-only tables (logs / acks / results / eligibility cache / overrides) get SELECT+INSERT only; the
-- mutable claim/line/submission/run/config/arrangement/day/credential get UPDATE too; the re-assembled
-- claim subtree (line + line_encounter) gets DELETE (re-assembly of a DRAFT claim rewrites lines).
-- wardenx_admin gets ALL (the §3.7 eraser redacts under wardenx_admin).

-- medicaid_claim
ALTER TABLE "medicaid_claim" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medicaid_claim_org" ON "medicaid_claim" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "medicaid_claim" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "medicaid_claim" TO wardenx_admin;--> statement-breakpoint

-- medicaid_claim_line
ALTER TABLE "medicaid_claim_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medicaid_claim_line_org" ON "medicaid_claim_line" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "medicaid_claim_line" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "medicaid_claim_line" TO wardenx_admin;--> statement-breakpoint

-- medicaid_claim_line_encounter
ALTER TABLE "medicaid_claim_line_encounter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medicaid_claim_line_encounter_org" ON "medicaid_claim_line_encounter" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "medicaid_claim_line_encounter" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "medicaid_claim_line_encounter" TO wardenx_admin;--> statement-breakpoint

-- medicaid_claim_state_history (append-only)
ALTER TABLE "medicaid_claim_state_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medicaid_claim_state_history_org" ON "medicaid_claim_state_history" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "medicaid_claim_state_history" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "medicaid_claim_state_history" TO wardenx_admin;--> statement-breakpoint

-- medicaid_submission
ALTER TABLE "medicaid_submission" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medicaid_submission_org" ON "medicaid_submission" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "medicaid_submission" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "medicaid_submission" TO wardenx_admin;--> statement-breakpoint

-- medicaid_acknowledgment (append-only)
ALTER TABLE "medicaid_acknowledgment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medicaid_acknowledgment_org" ON "medicaid_acknowledgment" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "medicaid_acknowledgment" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "medicaid_acknowledgment" TO wardenx_admin;--> statement-breakpoint

-- medicaid_validation_run
ALTER TABLE "medicaid_validation_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medicaid_validation_run_org" ON "medicaid_validation_run" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "medicaid_validation_run" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "medicaid_validation_run" TO wardenx_admin;--> statement-breakpoint

-- medicaid_validation_result (append-only)
ALTER TABLE "medicaid_validation_result" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medicaid_validation_result_org" ON "medicaid_validation_result" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "medicaid_validation_result" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "medicaid_validation_result" TO wardenx_admin;--> statement-breakpoint

-- medicaid_validation_override (append-only)
ALTER TABLE "medicaid_validation_override" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medicaid_validation_override_org" ON "medicaid_validation_override" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "medicaid_validation_override" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "medicaid_validation_override" TO wardenx_admin;--> statement-breakpoint

-- medicaid_validation_rule_config
ALTER TABLE "medicaid_validation_rule_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medicaid_validation_rule_config_org" ON "medicaid_validation_rule_config" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "medicaid_validation_rule_config" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "medicaid_validation_rule_config" TO wardenx_admin;--> statement-breakpoint

-- medicaid_eligibility_check (append-only cache)
ALTER TABLE "medicaid_eligibility_check" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medicaid_eligibility_check_org" ON "medicaid_eligibility_check" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "medicaid_eligibility_check" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "medicaid_eligibility_check" TO wardenx_admin;--> statement-breakpoint

-- rb_arrangement
ALTER TABLE "rb_arrangement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "rb_arrangement_org" ON "rb_arrangement" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "rb_arrangement" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "rb_arrangement" TO wardenx_admin;--> statement-breakpoint

-- rb_day
ALTER TABLE "rb_day" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "rb_day_org" ON "rb_day" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "rb_day" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "rb_day" TO wardenx_admin;--> statement-breakpoint

-- state_medicaid_trading_partner_credential
ALTER TABLE "state_medicaid_trading_partner_credential" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "state_medicaid_tp_org" ON "state_medicaid_trading_partner_credential" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "state_medicaid_trading_partner_credential" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "state_medicaid_trading_partner_credential" TO wardenx_admin;--> statement-breakpoint
