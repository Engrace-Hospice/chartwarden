-- 0470 — M40 GAP-174: a SECURITY DEFINER reader for `nppes_sync_log`.
--
-- `GET /api/v1/admin/mdm/nppes/sync-log` ran `SELECT ... FROM nppes_sync_log` on the app pool, but
-- migration 0019 §6 scoped `nppes_sync_log` to `wardenx_admin` alone (platform-operational, §3.6) — no
-- `wardenx_app` grant — so the route was a hard `permission denied` (500). The identical defect GAP-060 /
-- migration 0205 fixed for `merge_request`; the same remedy: keep the table OFF the tenant pool and expose
-- one narrow read function owned by the `mdm_canonical_writer` definer role.
--
-- Returns the most recent runs only (the console shows the recent outcomes; history beyond that is the
-- audit trail). The LIMIT lives in the function so the app role can never page the whole log.
GRANT SELECT ON "nppes_sync_log" TO mdm_canonical_writer;--> statement-breakpoint
DROP POLICY IF EXISTS "nppes_sync_log_canonical_writer" ON "nppes_sync_log";--> statement-breakpoint
CREATE POLICY "nppes_sync_log_canonical_writer" ON "nppes_sync_log"
  FOR SELECT TO mdm_canonical_writer USING (true);--> statement-breakpoint

CREATE OR REPLACE FUNCTION mdm_canonical_writer_list_nppes_sync_log(p_limit integer DEFAULT 50)
RETURNS TABLE (
  id uuid,
  run_at timestamptz,
  mode text,
  outcome text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT l.id, l.run_at, l.mode::text, l.outcome
  FROM nppes_sync_log l
  ORDER BY l.run_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
$$;--> statement-breakpoint
ALTER FUNCTION mdm_canonical_writer_list_nppes_sync_log(integer) OWNER TO mdm_canonical_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION mdm_canonical_writer_list_nppes_sync_log(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION mdm_canonical_writer_list_nppes_sync_log(integer) TO wardenx_app;
