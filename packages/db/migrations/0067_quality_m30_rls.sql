-- M30 HQRP & Quality §3.5 (RLS & Grants) — locks per-table RLS, the CANONICAL app.org_id policy, and
-- least-privilege grants for ALL 18 M30 tables (the 14 from 0062 + the 4 partitioned PHI tables from
-- 0063–0066). Tables/enums/indexes/FKs land in 0062–0066; the M4 write-audit triggers in 0068.
--
-- ONE RLS SHAPE (§3.5 M30-F02 / ADR-0010, CANONICAL): EVERY M30 table carries organization_id NOT NULL,
-- so every policy is the canonical predicate
--   USING/WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid)
-- — NO subqueries, NO EXISTS(SELECT…), NO pg_has_role(...). wardenx_app has SELECT/INSERT/UPDATE on every
-- table (NO DELETE anywhere — rows are never SQL-deleted; the §3.7 eraseFn redacts/partition-detaches under
-- wardenx_admin). wardenx_admin gets ALL. The 4 partitioned PHI tables enable RLS + grant on the PARENT
-- only; policies/grants/triggers on a partitioned parent apply to every partition (PG11+), matching the
-- EVV evv_event precedent.
ALTER TABLE "quality_measure_value" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "quality_measure_value_org" ON "quality_measure_value"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "quality_measure_value" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "quality_measure_value" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "measure_recompute_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "measure_recompute_queue_org" ON "measure_recompute_queue"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "measure_recompute_queue" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "measure_recompute_queue" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "cahps_vendor_binding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cahps_vendor_binding_org" ON "cahps_vendor_binding"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cahps_vendor_binding" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cahps_vendor_binding" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "cahps_result_summary" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cahps_result_summary_org" ON "cahps_result_summary"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cahps_result_summary" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cahps_result_summary" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "qapi_program" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "qapi_program_org" ON "qapi_program"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "qapi_program" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "qapi_program" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "qapi_indicator" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "qapi_indicator_org" ON "qapi_indicator"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "qapi_indicator" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "qapi_indicator" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "qapi_project" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "qapi_project_org" ON "qapi_project"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "qapi_project" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "qapi_project" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "qapi_pip" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "qapi_pip_org" ON "qapi_pip"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "qapi_pip" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "qapi_pip" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "qapi_governance_minutes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "qapi_governance_minutes_org" ON "qapi_governance_minutes"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "qapi_governance_minutes" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "qapi_governance_minutes" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "sra_cycle" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sra_cycle_org" ON "sra_cycle"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "sra_cycle" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "sra_cycle" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "sra_finding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sra_finding_org" ON "sra_finding"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "sra_finding" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "sra_finding" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "sra_remediation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sra_remediation_org" ON "sra_remediation"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "sra_remediation" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "sra_remediation" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "cop_compliance_status" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cop_compliance_status_org" ON "cop_compliance_status"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cop_compliance_status" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cop_compliance_status" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "infection_outbreak_case" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "infection_outbreak_case_org" ON "infection_outbreak_case"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "infection_outbreak_case" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "infection_outbreak_case" TO wardenx_admin;--> statement-breakpoint
-- ---- partitioned PHI tables (parent only; policy/grant propagate to partitions, PG11+) ----
ALTER TABLE "incident_report" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "incident_report_org" ON "incident_report"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "incident_report" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "incident_report" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "mortality_review" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "mortality_review_org" ON "mortality_review"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "mortality_review" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "mortality_review" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "infection_surveillance_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "infection_surveillance_event_org" ON "infection_surveillance_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "infection_surveillance_event" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "infection_surveillance_event" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "cahps_decedent_sample" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cahps_decedent_sample_org" ON "cahps_decedent_sample"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cahps_decedent_sample" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cahps_decedent_sample" TO wardenx_admin;--> statement-breakpoint
-- ---- risk_register_view (§3.3 corpus ref) ----
-- A PLAIN org-filtered view over sra_finding/sra_cycle (the tenant_key_ring_metadata_v masking-view
-- precedent), NOT a materialized view: a precomputed matview cannot enforce per-session org scope, so RLS
-- correctness wins (architecture authority). The security-posture-sensitive vulnerability_description /
-- impact_description columns are intentionally EXCLUDED (they are §3.6-denylisted free text).
CREATE VIEW "risk_register_view" AS
  SELECT f.id, f.sra_cycle_id, f.organization_id, c.cycle_year, f.finding_number,
         f.affected_asset_category, f.inherent_5x5_score, f.residual_5x5_score, f.status,
         f.accepted_risk_attestation_at, f.accepted_risk_auto_reopen_at, f.carried_from_prior_cycle_id,
         f.created_at, f.updated_at
    FROM sra_finding f
    JOIN sra_cycle c ON c.id = f.sra_cycle_id
   WHERE f.organization_id = current_setting('app.org_id', true)::uuid;--> statement-breakpoint
GRANT SELECT ON "risk_register_view" TO wardenx_app;--> statement-breakpoint
GRANT SELECT ON "risk_register_view" TO wardenx_admin;--> statement-breakpoint
-- ---- M4 write-audit append path (M04-F06 #2) — idempotent re-assertion (mirror 0052 §17). The M30
-- write-audit triggers (0068) write through wardenx_audit_writer; re-assert its INSERT grant + policy here
-- so the RLS migration is self-contained and replay-safe. ----
GRANT INSERT ON audit_event TO wardenx_audit_writer;--> statement-breakpoint
DROP POLICY IF EXISTS audit_writer_insert ON audit_event;--> statement-breakpoint
CREATE POLICY audit_writer_insert ON audit_event
  FOR INSERT TO wardenx_audit_writer WITH CHECK (true);
