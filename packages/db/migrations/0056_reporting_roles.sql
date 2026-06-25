-- M33 Reporting & Dashboards §3.2 (phase 1) — the `report_mv` schema + the `report_writer`
-- SECURITY DEFINER writer role (M33-T01). Mirrors M34's `tenant_platform_writer` / M4's
-- `wardenx_audit_writer` / M40's `mdm_canonical_writer` least-privilege writer pattern: ONE new
-- role, NOLOGIN, owning the per-MV `report_mv.select_<mv_key>(uuid)` wrapper functions (the only
-- read path into the materialized views) and holding the privileged catalog/MV-telemetry writes.
-- `wardenx_app` does NOT inherit this role, so a request-scoped connection can never SELECT a
-- `report_mv.*` materialized view directly nor mutate the platform catalogs — every read goes
-- through the wrapper functions (granted EXECUTE), enforcing the §3.5 "no direct MV SELECT" rule.
--
-- The `report_mv` schema holds the ~36 platform-shipped materialized views (raw CREATE MATERIALIZED
-- VIEW SQL, invisible to the table-ownership/orphan checks — §3.2 phase 9). The MVs + wrapper
-- functions land in 0060; the catalog/MV-metadata seed in 0061; tables in 0057; RLS in 0058; the M4
-- write-audit triggers in 0059.
CREATE SCHEMA IF NOT EXISTS report_mv;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'report_writer') THEN
    CREATE ROLE report_writer NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO report_writer;--> statement-breakpoint
GRANT USAGE ON SCHEMA report_mv TO report_writer;--> statement-breakpoint
-- wardenx_app needs schema USAGE to EXECUTE the wrapper functions, but NO table/MV privileges in
-- report_mv (the wrapper functions are the only sanctioned read path; §3.5).
GRANT USAGE ON SCHEMA report_mv TO wardenx_app;--> statement-breakpoint
GRANT ALL ON SCHEMA report_mv TO wardenx_admin;--> statement-breakpoint
GRANT report_writer TO wardenx_admin;--> statement-breakpoint
COMMENT ON ROLE report_writer IS
  'Owns the report_mv.select_<mv_key>() SECURITY DEFINER wrapper functions (the only read path into the report_mv materialized views) and holds the privileged platform-catalog / MV-telemetry writes. wardenx_app does NOT inherit this role and has no direct report_mv SELECT (M33 §3.2/§3.5).';
