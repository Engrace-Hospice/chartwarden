-- M33 Reporting & Dashboards §3.2 (phase 9) / §3.5 — the platform-shipped report_mv materialized
-- views + their SECURITY DEFINER per-MV wrapper functions (M33-T05). This Phase-1 migration ships THREE
-- representative MVs (one per active base: census / encounter-productivity / EVV-compliance); the
-- remaining ~33 registry keys are seeded as status='registered' placeholders in 0061 (their upstream
-- modules/MV SQL land with those modules).
--
-- Each MV is raw CREATE MATERIALIZED VIEW SQL (NOT a Drizzle pgTable → invisible to the
-- table-ownership/orphan checks). Each carries a CREATE UNIQUE INDEX on its natural key so the refresh
-- worker can REFRESH MATERIALIZED VIEW CONCURRENTLY. Application code NEVER selects a report_mv view
-- directly (§3.5): wardenx_app has no MV SELECT grant — every read goes through the wrapper function
-- report_mv.select_<mv_key>(p_org_id uuid), which is SECURITY DEFINER (owner report_writer), asserts
-- p_org_id = current_setting('app.org_id', true)::uuid, and returns only that org's rows. report_writer
-- holds the MV SELECT grant; wardenx_app holds EXECUTE on the wrapper + USAGE on the report_mv schema.

-- ============================================================================================
-- 1. mv_census_org_daily — newly-activated active-patient census per org per day (source: M6 admission).
-- ============================================================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS report_mv.mv_census_org_daily AS
  SELECT
    a.organization_id,
    date_trunc('day', a.activated_at) AS census_day,
    count(*)::bigint AS active_patient_count
  FROM public.admission a
  WHERE a.status = 'active'
    AND a.activated_at IS NOT NULL
  GROUP BY a.organization_id, date_trunc('day', a.activated_at)
  WITH DATA;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mv_census_org_daily_natural_uidx"
  ON report_mv.mv_census_org_daily ("organization_id", "census_day");--> statement-breakpoint
GRANT SELECT ON report_mv.mv_census_org_daily TO report_writer;--> statement-breakpoint
CREATE OR REPLACE FUNCTION report_mv.select_mv_census_org_daily(p_org_id uuid)
RETURNS SETOF report_mv.mv_census_org_daily
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, report_mv, public
AS $$
  SELECT *
  FROM report_mv.mv_census_org_daily
  WHERE organization_id = p_org_id
    AND p_org_id = current_setting('app.org_id', true)::uuid;
$$;--> statement-breakpoint
ALTER FUNCTION report_mv.select_mv_census_org_daily(uuid) OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_mv.select_mv_census_org_daily(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_mv.select_mv_census_org_daily(uuid) TO wardenx_app;--> statement-breakpoint
COMMENT ON FUNCTION report_mv.select_mv_census_org_daily(uuid) IS
  'SECURITY DEFINER (owner report_writer): the only sanctioned read path into report_mv.mv_census_org_daily. Asserts p_org_id = app.org_id and returns only that org''s rows (M33 §3.5).';--> statement-breakpoint

-- ============================================================================================
-- 2. mv_encounter_productivity_membership_day — encounter counts per authoring membership per service
--    day (source: M8 encounter).
-- ============================================================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS report_mv.mv_encounter_productivity_membership_day AS
  SELECT
    e.organization_id,
    e.authored_by_membership_id,
    e.service_date AS productivity_day,
    count(*)::bigint AS encounter_count,
    count(*) FILTER (WHERE e.status IN ('signed','cosigned'))::bigint AS signed_count
  FROM public.encounter e
  GROUP BY e.organization_id, e.authored_by_membership_id, e.service_date
  WITH DATA;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mv_encounter_productivity_membership_day_natural_uidx"
  ON report_mv.mv_encounter_productivity_membership_day ("organization_id", "authored_by_membership_id", "productivity_day");--> statement-breakpoint
GRANT SELECT ON report_mv.mv_encounter_productivity_membership_day TO report_writer;--> statement-breakpoint
CREATE OR REPLACE FUNCTION report_mv.select_mv_encounter_productivity_membership_day(p_org_id uuid)
RETURNS SETOF report_mv.mv_encounter_productivity_membership_day
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, report_mv, public
AS $$
  SELECT *
  FROM report_mv.mv_encounter_productivity_membership_day
  WHERE organization_id = p_org_id
    AND p_org_id = current_setting('app.org_id', true)::uuid;
$$;--> statement-breakpoint
ALTER FUNCTION report_mv.select_mv_encounter_productivity_membership_day(uuid) OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_mv.select_mv_encounter_productivity_membership_day(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_mv.select_mv_encounter_productivity_membership_day(uuid) TO wardenx_app;--> statement-breakpoint
COMMENT ON FUNCTION report_mv.select_mv_encounter_productivity_membership_day(uuid) IS
  'SECURITY DEFINER (owner report_writer): the only sanctioned read path into report_mv.mv_encounter_productivity_membership_day. Asserts p_org_id = app.org_id (M33 §3.5).';--> statement-breakpoint

-- ============================================================================================
-- 3. mv_evv_compliance_org_week — EVV check-in/check-out pairing per org per ISO week (source: M18
--    evv_event; live (non-superseded) rows only).
-- ============================================================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS report_mv.mv_evv_compliance_org_week AS
  SELECT
    ev.organization_id,
    date_trunc('week', ev.event_at) AS evv_week,
    count(*) FILTER (WHERE ev.kind = 'check_in')::bigint  AS check_in_count,
    count(*) FILTER (WHERE ev.kind = 'check_out')::bigint AS check_out_count,
    count(DISTINCT ev.visit_id)::bigint AS visit_count
  FROM public.evv_event ev
  WHERE ev.superseded_by_event_id IS NULL
  GROUP BY ev.organization_id, date_trunc('week', ev.event_at)
  WITH DATA;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mv_evv_compliance_org_week_natural_uidx"
  ON report_mv.mv_evv_compliance_org_week ("organization_id", "evv_week");--> statement-breakpoint
GRANT SELECT ON report_mv.mv_evv_compliance_org_week TO report_writer;--> statement-breakpoint
CREATE OR REPLACE FUNCTION report_mv.select_mv_evv_compliance_org_week(p_org_id uuid)
RETURNS SETOF report_mv.mv_evv_compliance_org_week
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, report_mv, public
AS $$
  SELECT *
  FROM report_mv.mv_evv_compliance_org_week
  WHERE organization_id = p_org_id
    AND p_org_id = current_setting('app.org_id', true)::uuid;
$$;--> statement-breakpoint
ALTER FUNCTION report_mv.select_mv_evv_compliance_org_week(uuid) OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_mv.select_mv_evv_compliance_org_week(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_mv.select_mv_evv_compliance_org_week(uuid) TO wardenx_app;--> statement-breakpoint
COMMENT ON FUNCTION report_mv.select_mv_evv_compliance_org_week(uuid) IS
  'SECURITY DEFINER (owner report_writer): the only sanctioned read path into report_mv.mv_evv_compliance_org_week. Asserts p_org_id = app.org_id (M33 §3.5).';
