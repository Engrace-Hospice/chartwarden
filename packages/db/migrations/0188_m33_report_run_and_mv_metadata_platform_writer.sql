-- M33 (WX-PR-024, "same root cause, found adjacent") — a platform-wide (organization_id IS NULL) write
-- path for `report_run`, and a write path for `materialized_view_metadata` (which has NO organization_id
-- column at all — every row is platform-global), so the nightly MV-refresh worker's run-ledger open/
-- settle and telemetry stamp actually succeed under real (NOBYPASSRLS) RLS as `wardenx_app`.
--
-- THE BUG (confirmed by direct `psql`, `SET ROLE wardenx_app`, NOBYPASSRLS):
--   INSERT INTO report_run (..., organization_id, ...) VALUES (..., NULL, ...);
--   ERROR:  new row violates row-level security policy for table "report_run"
-- `materialized_view_metadata` fails even harder: `wardenx_app` holds SELECT only (migration 0058) —
-- there was never an INSERT/UPDATE grant for it at all, let alone a policy.
--
-- `report_run.organization_id` has been documented nullable since M33 shipped ("cross-tenant
-- platform-wide refreshes"), but no writer path was ever built for it — `report_run_org`
-- (`organization_id = current_setting('app.org_id', true)::uuid`, migration 0058) evaluates to NULL
-- (not TRUE) for a null-org row, so it neither admits nor exposes one, by the same ADR-0010 D2/D3
-- reasoning migration 0186 already documents for `outbox_event` (no second RLS-policy GUC; no
-- org-alternative disjunct on a tenant-writable policy). This migration mirrors that fix exactly,
-- reusing the ALREADY-EXISTING `report_writer` role (migration 0056) rather than inventing a new one:
-- a SECURITY DEFINER function surface owned by `report_writer`, EXECUTE granted to `wardenx_app`,
-- touching `organization_id IS NULL` rows only (report_run) / any row (materialized_view_metadata,
-- which has no org column to restrict on) — hardcoded inside each function body, never a
-- caller-supplied parameter.
--
-- NOTE: `report_writer` already held table-level GRANTs on both tables (migration 0058) — SELECT on
-- `report_run`, full DML on `materialized_view_metadata` — but RLS is enabled on both and a GRANT is
-- not a policy: with no policy naming `report_writer`, RLS admits it zero rows for any write regardless
-- of the grant. This migration adds the missing policies alongside the missing `report_run` INSERT/
-- UPDATE grant.

-- ── report_run: report_writer's platform-write policy + grant ──────────────────────────────────────────
DROP POLICY IF EXISTS "report_run_platform_writer" ON "report_run";--> statement-breakpoint
CREATE POLICY "report_run_platform_writer" ON "report_run"
  FOR ALL TO report_writer
  USING ("organization_id" IS NULL)
  WITH CHECK ("organization_id" IS NULL);--> statement-breakpoint
GRANT INSERT, UPDATE ON "report_run" TO report_writer;--> statement-breakpoint

-- ── materialized_view_metadata: report_writer's platform-write policy (no org column to restrict on) ───
DROP POLICY IF EXISTS "materialized_view_metadata_platform_writer" ON "materialized_view_metadata";--> statement-breakpoint
CREATE POLICY "materialized_view_metadata_platform_writer" ON "materialized_view_metadata"
  FOR ALL TO report_writer
  USING (true)
  WITH CHECK (true);--> statement-breakpoint

-- ── (1) report_run: open a platform-wide MV-refresh run (mirrors ReportRunRepository.createMvRun) ──────
CREATE OR REPLACE FUNCTION report_writer_insert_platform_report_run(
  p_id uuid,
  p_mv_key text,
  p_trigger_kind text,
  p_trigger_outbox_event_id uuid,
  p_started_at timestamptz,
  p_status text,
  p_retry_attempt int
) RETURNS report_run
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row report_run;
BEGIN
  INSERT INTO report_run (id, mv_key, organization_id, trigger_kind, trigger_outbox_event_id,
                          started_at, status, retry_attempt)
  VALUES (p_id, p_mv_key, NULL, p_trigger_kind, p_trigger_outbox_event_id, p_started_at, p_status,
          p_retry_attempt)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;--> statement-breakpoint
ALTER FUNCTION report_writer_insert_platform_report_run(uuid, text, text, uuid, timestamptz, text, int)
  OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_writer_insert_platform_report_run(uuid, text, text, uuid, timestamptz, text, int)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_writer_insert_platform_report_run(uuid, text, text, uuid, timestamptz, text, int)
  TO wardenx_app;--> statement-breakpoint

-- ── (2) report_run: settle a platform-wide run (mirrors ReportRunRepository.updateMvRunStatus) ─────────
-- `p_patch` carries only the fields the caller actually wants changed (a JS `Partial<...>`); a key's
-- PRESENCE in the jsonb object (`p_patch ? 'key'`), not its value, decides whether that column updates —
-- this is what lets `NULL` be a legitimate value for a nullable column (e.g. `finishedAt`) without also
-- meaning "leave unchanged".
CREATE OR REPLACE FUNCTION report_writer_update_platform_report_run(
  p_id uuid,
  p_started_at timestamptz,
  p_patch jsonb
) RETURNS report_run
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row report_run;
BEGIN
  UPDATE report_run SET
    status = CASE WHEN p_patch ? 'status' THEN (p_patch->>'status') ELSE status END,
    finished_at = CASE WHEN p_patch ? 'finishedAt' THEN (p_patch->>'finishedAt')::timestamptz ELSE finished_at END,
    duration_ms = CASE WHEN p_patch ? 'durationMs' THEN (p_patch->>'durationMs')::int ELSE duration_ms END,
    rows_affected = CASE WHEN p_patch ? 'rowsAffected' THEN (p_patch->>'rowsAffected')::int ELSE rows_affected END,
    failure_reason = CASE WHEN p_patch ? 'failureReason' THEN (p_patch->>'failureReason') ELSE failure_reason END,
    retry_attempt = CASE WHEN p_patch ? 'retryAttempt' THEN (p_patch->>'retryAttempt')::int ELSE retry_attempt END
  WHERE id = p_id AND started_at = p_started_at AND organization_id IS NULL
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'report_run % @ % (platform-wide) not found', p_id, p_started_at;
  END IF;
  RETURN v_row;
END;
$$;--> statement-breakpoint
ALTER FUNCTION report_writer_update_platform_report_run(uuid, timestamptz, jsonb)
  OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_writer_update_platform_report_run(uuid, timestamptz, jsonb)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_writer_update_platform_report_run(uuid, timestamptz, jsonb)
  TO wardenx_app;--> statement-breakpoint

-- ── (3) materialized_view_metadata: stamp refresh telemetry (mirrors
--       ReportCatalogRepository.updateMvRefreshTelemetry / MvRefreshWorkerPorts.metadataWrite.stamp) ────
CREATE OR REPLACE FUNCTION report_writer_update_platform_mv_metadata(
  p_mv_key text,
  p_patch jsonb
) RETURNS materialized_view_metadata
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row materialized_view_metadata;
BEGIN
  UPDATE materialized_view_metadata SET
    last_refreshed_at = CASE WHEN p_patch ? 'lastRefreshedAt' THEN (p_patch->>'lastRefreshedAt')::timestamptz ELSE last_refreshed_at END,
    last_refresh_duration_ms = CASE WHEN p_patch ? 'lastRefreshDurationMs' THEN (p_patch->>'lastRefreshDurationMs')::int ELSE last_refresh_duration_ms END,
    refresh_failure_count = CASE WHEN p_patch ? 'refreshFailureCount' THEN (p_patch->>'refreshFailureCount')::int ELSE refresh_failure_count END,
    status = CASE WHEN p_patch ? 'status' THEN (p_patch->>'status') ELSE status END
  WHERE mv_key = p_mv_key
  RETURNING * INTO v_row;
  IF v_row.mv_key IS NULL THEN
    RAISE EXCEPTION 'materialized_view_metadata % not found', p_mv_key;
  END IF;
  RETURN v_row;
END;
$$;--> statement-breakpoint
ALTER FUNCTION report_writer_update_platform_mv_metadata(text, jsonb)
  OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_writer_update_platform_mv_metadata(text, jsonb)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_writer_update_platform_mv_metadata(text, jsonb)
  TO wardenx_app;
