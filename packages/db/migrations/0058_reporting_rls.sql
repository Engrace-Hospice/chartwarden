-- M33 Reporting & Dashboards §3.2 (phase 7) / §3.5 — per-table RLS, the canonical tenant_isolation
-- policy, and least-privilege grants for the 12 M33 tables (M33-T03). Tables/FKs/indexes land in 0057;
-- the report_writer role in 0056; the M4 write-audit triggers in 0059; the MV wrapper functions in 0060.
--
-- THREE RLS SHAPES (§3.5):
--   • ORG-SCOPED — the nine tenant tables use the CANONICAL predicate
--     `USING/WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid)` — NO subqueries,
--     NO EXISTS(SELECT…), NO pg_has_role(...). report_run's organization_id is NULLABLE; the canonical
--     predicate intentionally hides its NULL-org (cross-tenant platform-wide refresh) rows from tenants
--     (those are written/read under the platform-admin context).
--   • PLATFORM read-all catalog — materialized_view_metadata / report_base_catalog /
--     report_metric_catalog carry NO organization_id; identical rows for every tenant
--     (SELECT USING(true)); platform writes via report_writer (seed in 0061; MV-telemetry at runtime).
--   • INSERT-ONLY ledger — report_drilldown_audit is insert-only: a FOR SELECT + a FOR INSERT policy,
--     NO UPDATE/DELETE policy or grant (M4 treats it as destruction_blocked, `compliance` retention).

-- ============================================================================================
-- 1. report_definition — ORG-SCOPED. Writes additionally require report.definition.write at the route.
-- ============================================================================================
ALTER TABLE "report_definition" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "report_definition_org" ON "report_definition"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "report_definition" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "report_definition" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 2. report_definition_version — ORG-SCOPED. Writes require report.definition.write at the route.
-- ============================================================================================
ALTER TABLE "report_definition_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "report_definition_version_org" ON "report_definition_version"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "report_definition_version" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "report_definition_version" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 3. report_view — ORG-SCOPED. Writes require report.view.write + ownership (or org_admin for
--    is_org_default) at the route; RLS enforces the org boundary.
-- ============================================================================================
ALTER TABLE "report_view" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "report_view_org" ON "report_view"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "report_view" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "report_view" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 4. report_share — ORG-SCOPED. Writes require report.share.org or self-role share at the route.
-- ============================================================================================
ALTER TABLE "report_share" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "report_share_org" ON "report_share"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "report_share" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "report_share" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 5. report_schedule — ORG-SCOPED. Writes require report.schedule.write; recipients must be active
--    same-org memberships (enforced at the route). recipient_membership_ids is denylisted in audit (0059).
-- ============================================================================================
ALTER TABLE "report_schedule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "report_schedule_org" ON "report_schedule"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "report_schedule" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "report_schedule" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 6. report_schedule_run — ORG-SCOPED (LIST/RANGE-partitioned by scheduled_for). Worker runs under the
--    tenant's withOrgContext; canonical predicate.
-- ============================================================================================
ALTER TABLE "report_schedule_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "report_schedule_run_org" ON "report_schedule_run"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "report_schedule_run" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "report_schedule_run" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 7. report_run — ORG-SCOPED (RANGE-partitioned by started_at); organization_id NULLABLE. The
--    org-scoped refresh worker runs under withOrgContext (canonical predicate covers it); platform-wide
--    (NULL-org) rows are written/read under the platform-admin context. report_writer reads for ops.
-- ============================================================================================
ALTER TABLE "report_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "report_run_org" ON "report_run"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "report_run" TO wardenx_app;--> statement-breakpoint
GRANT SELECT ON "report_run" TO report_writer;--> statement-breakpoint
GRANT ALL ON "report_run" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 8. dashboard_tile_cache — ORG-SCOPED. The tenant upserts + the TTL sweeper deletes its own rows.
-- ============================================================================================
ALTER TABLE "dashboard_tile_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "dashboard_tile_cache_org" ON "dashboard_tile_cache"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "dashboard_tile_cache" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "dashboard_tile_cache" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 9. report_drilldown_audit — ORG-SCOPED, INSERT-ONLY (§3.5). A FOR SELECT + a FOR INSERT policy;
--    NO UPDATE/DELETE policy or grant. query_filters_cipher is denylisted in audit (0059).
-- ============================================================================================
ALTER TABLE "report_drilldown_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "report_drilldown_audit_select" ON "report_drilldown_audit"
  FOR SELECT TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "report_drilldown_audit_insert" ON "report_drilldown_audit"
  FOR INSERT TO wardenx_app
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "report_drilldown_audit" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "report_drilldown_audit" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 10. materialized_view_metadata — PLATFORM read-all catalog (no organization_id). SELECT USING(true)
--     for wardenx_app; the refresh worker / migration seed writes via report_writer.
-- ============================================================================================
ALTER TABLE "materialized_view_metadata" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "materialized_view_metadata_read_all" ON "materialized_view_metadata"
  FOR SELECT TO wardenx_app
  USING (true);--> statement-breakpoint
GRANT SELECT ON "materialized_view_metadata" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "materialized_view_metadata" TO report_writer;--> statement-breakpoint
GRANT ALL ON "materialized_view_metadata" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 11. report_base_catalog — PLATFORM read-all catalog (no organization_id).
-- ============================================================================================
ALTER TABLE "report_base_catalog" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "report_base_catalog_read_all" ON "report_base_catalog"
  FOR SELECT TO wardenx_app
  USING (true);--> statement-breakpoint
GRANT SELECT ON "report_base_catalog" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "report_base_catalog" TO report_writer;--> statement-breakpoint
GRANT ALL ON "report_base_catalog" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 12. report_metric_catalog — PLATFORM read-all catalog (no organization_id).
-- ============================================================================================
ALTER TABLE "report_metric_catalog" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "report_metric_catalog_read_all" ON "report_metric_catalog"
  FOR SELECT TO wardenx_app
  USING (true);--> statement-breakpoint
GRANT SELECT ON "report_metric_catalog" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "report_metric_catalog" TO report_writer;--> statement-breakpoint
GRANT ALL ON "report_metric_catalog" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 13. M4 write-audit append path — idempotent re-assertion (mirror 0052 §17). The M33 write-audit
--     triggers (0059) write through wardenx_audit_writer; re-assert its INSERT grant + policy here so
--     the RLS migration is self-contained and replay-safe.
-- ============================================================================================
GRANT INSERT ON audit_event TO wardenx_audit_writer;--> statement-breakpoint
DROP POLICY IF EXISTS audit_writer_insert ON audit_event;--> statement-breakpoint
CREATE POLICY audit_writer_insert ON audit_event
  FOR INSERT TO wardenx_audit_writer WITH CHECK (true);
