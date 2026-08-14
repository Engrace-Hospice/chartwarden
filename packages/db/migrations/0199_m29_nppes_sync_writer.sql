-- M29 §3.3 / D11 (GAP-045) — the platform NPPES sync's WRITE path for the two platform-shared
-- (org-less) tables `nppes_provider` and `nppes_sync_run`.
--
-- WHY THIS IS NEEDED. Migration 0148 gave `wardenx_app` SELECT only on both tables and put every write
-- behind `wardenx_admin` ("the nightly sync writes as wardenx_admin under a permissive write policy").
-- No such admin-credentialled sync process was ever built, so the orchestrator that would have populated
-- these tables had nowhere to write: the app pool connects as `wardenx_app`, and a plain INSERT/UPDATE
-- from it is a hard `permission denied` (a GRANT failure, which BYPASSRLS on a platform login role would
-- NOT fix either — BYPASSRLS skips policies, not table grants).
--
-- THE PATTERN. Identical in shape to migration 0186 (`report_writer_*` for the platform-wide outbox row)
-- and to `wardenx_audit_writer`'s `audit_writer_insert` (migration 0013): a NARROW, DEDICATED NOLOGIN
-- role owns a small set of SECURITY DEFINER functions; `wardenx_app` gets EXECUTE on those functions and
-- NEVER role membership, so it cannot satisfy the writer policy directly, accidentally or otherwise. Each
-- function's body names its own table and columns — nothing about which table or which rows is reachable
-- through a caller-supplied argument, so there is no way to widen scope through a parameter.
--
-- A NEW ROLE RATHER THAN REUSING `report_writer`: 0186 reused M33's role because the row it writes IS an
-- `outbox_event` row (M1's table, M33's existing writer). These are M29's own tables; a role named for
-- what it may write keeps the grant audit legible, matching `mdm_canonical_writer` (M40) /
-- `consent_catalog_writer` (M39) / `terminology_loader` (M38) — the repo's dominant shape for a
-- platform-shared reference table's writer.
--
-- NO `withPlatformContext` ENVELOPE. Same reasoning 0186 states for the platform-outbox functions: the
-- FUNCTION BODY, not the caller's session, carries the elevated privilege, so the caller needs no
-- cross-tenant session at all. Both tables are already read-all `USING (true)` to `wardenx_app`, so the
-- sync's reads (the cache diff, the sync-run history) run on the ordinary pooled handle.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nppes_sync_writer') THEN
    CREATE ROLE nppes_sync_writer NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO nppes_sync_writer;--> statement-breakpoint
COMMENT ON ROLE nppes_sync_writer IS
  'M29 D11 — NOLOGIN owner of the SECURITY DEFINER nppes_writer_* functions; the only non-admin write path to nppes_provider / nppes_sync_run.';--> statement-breakpoint

DROP POLICY IF EXISTS "nppes_provider_sync_writer" ON "nppes_provider";--> statement-breakpoint
CREATE POLICY "nppes_provider_sync_writer" ON "nppes_provider"
  FOR ALL TO nppes_sync_writer USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "nppes_provider" TO nppes_sync_writer;--> statement-breakpoint

DROP POLICY IF EXISTS "nppes_sync_run_sync_writer" ON "nppes_sync_run";--> statement-breakpoint
CREATE POLICY "nppes_sync_run_sync_writer" ON "nppes_sync_run"
  FOR ALL TO nppes_sync_writer USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "nppes_sync_run" TO nppes_sync_writer;--> statement-breakpoint

-- The write-audit triggers on both tables are SECURITY DEFINER themselves and insert into audit_event as
-- their own definer, so the writer role needs no audit grant; but it DOES need to be able to reach the
-- audit sequence-free partitioned insert path the trigger performs on its behalf, which the trigger's own
-- definer privilege already covers. Nothing further to grant here.

-- ── (1) the per-NPI cache upsert (§4.7.1). The pure `decideCacheUpsert` diff runs in TS against the
-- read-all SELECT; this function performs only the write it decided on. ────────────────────────────────
CREATE OR REPLACE FUNCTION nppes_writer_upsert_provider(
  p_npi char(10),
  p_enumeration_type text,
  p_status text,
  p_deactivation_date date,
  p_deactivation_reason text,
  p_reactivation_date date,
  p_basic jsonb,
  p_addresses jsonb,
  p_taxonomies jsonb,
  p_identifiers jsonb,
  p_endpoints jsonb,
  p_last_updated_in_nppes date,
  p_fetched_at timestamptz
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO nppes_provider (
    npi, enumeration_type, status, deactivation_date, deactivation_reason, reactivation_date,
    basic, addresses, taxonomies, identifiers, endpoints, last_updated_in_nppes, fetched_at
  ) VALUES (
    p_npi,
    p_enumeration_type::nppes_enumeration_type,
    p_status::nppes_provider_status,
    p_deactivation_date, p_deactivation_reason, p_reactivation_date,
    p_basic, p_addresses, p_taxonomies, p_identifiers, p_endpoints,
    p_last_updated_in_nppes, p_fetched_at
  )
  ON CONFLICT (npi) DO UPDATE SET
    enumeration_type = EXCLUDED.enumeration_type,
    status = EXCLUDED.status,
    deactivation_date = EXCLUDED.deactivation_date,
    deactivation_reason = EXCLUDED.deactivation_reason,
    reactivation_date = EXCLUDED.reactivation_date,
    basic = EXCLUDED.basic,
    addresses = EXCLUDED.addresses,
    taxonomies = EXCLUDED.taxonomies,
    identifiers = EXCLUDED.identifiers,
    endpoints = EXCLUDED.endpoints,
    last_updated_in_nppes = EXCLUDED.last_updated_in_nppes,
    fetched_at = EXCLUDED.fetched_at;
$$;--> statement-breakpoint
ALTER FUNCTION nppes_writer_upsert_provider(char, text, text, date, text, date, jsonb, jsonb, jsonb, jsonb, jsonb, date, timestamptz) OWNER TO nppes_sync_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION nppes_writer_upsert_provider(char, text, text, date, text, date, jsonb, jsonb, jsonb, jsonb, jsonb, date, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION nppes_writer_upsert_provider(char, text, text, date, text, date, jsonb, jsonb, jsonb, jsonb, jsonb, date, timestamptz) TO wardenx_app;--> statement-breakpoint

-- ── (2) open a sync run (§3.3 orchestration log) ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION nppes_writer_open_sync_run(
  p_id uuid,
  p_kind text,
  p_triggered_by text,
  p_triggered_by_membership_id uuid,
  p_started_at timestamptz
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO nppes_sync_run (id, kind, triggered_by, triggered_by_membership_id, started_at, status)
  VALUES (
    p_id,
    p_kind::nppes_sync_kind,
    p_triggered_by::nppes_sync_trigger,
    p_triggered_by_membership_id,
    p_started_at,
    'in_progress'
  )
  ON CONFLICT (id) DO NOTHING;
$$;--> statement-breakpoint
ALTER FUNCTION nppes_writer_open_sync_run(uuid, text, text, uuid, timestamptz) OWNER TO nppes_sync_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION nppes_writer_open_sync_run(uuid, text, text, uuid, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION nppes_writer_open_sync_run(uuid, text, text, uuid, timestamptz) TO wardenx_app;--> statement-breakpoint

-- ── (3) the mid-run progress checkpoint (every NPPES_CHECKPOINT_EVERY NPIs) ────────────────────────────
CREATE OR REPLACE FUNCTION nppes_writer_update_sync_run_counts(
  p_id uuid,
  p_fetched int,
  p_updated int,
  p_deactivated int,
  p_errors int
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE nppes_sync_run
  SET providers_fetched_count = p_fetched,
      providers_updated_count = p_updated,
      providers_deactivated_count = p_deactivated,
      errors_count = p_errors
  WHERE id = p_id AND status = 'in_progress';
$$;--> statement-breakpoint
ALTER FUNCTION nppes_writer_update_sync_run_counts(uuid, int, int, int, int) OWNER TO nppes_sync_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION nppes_writer_update_sync_run_counts(uuid, int, int, int, int) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION nppes_writer_update_sync_run_counts(uuid, int, int, int, int) TO wardenx_app;--> statement-breakpoint

-- ── (4) the two terminal shapes: completed / failed (circuit breaker or fatal) ─────────────────────────
CREATE OR REPLACE FUNCTION nppes_writer_complete_sync_run(
  p_id uuid,
  p_fetched int,
  p_updated int,
  p_deactivated int,
  p_errors int,
  p_completed_at timestamptz
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE nppes_sync_run
  SET status = 'completed',
      completed_at = p_completed_at,
      providers_fetched_count = p_fetched,
      providers_updated_count = p_updated,
      providers_deactivated_count = p_deactivated,
      errors_count = p_errors
  WHERE id = p_id;
$$;--> statement-breakpoint
ALTER FUNCTION nppes_writer_complete_sync_run(uuid, int, int, int, int, timestamptz) OWNER TO nppes_sync_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION nppes_writer_complete_sync_run(uuid, int, int, int, int, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION nppes_writer_complete_sync_run(uuid, int, int, int, int, timestamptz) TO wardenx_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION nppes_writer_fail_sync_run(
  p_id uuid,
  p_error text,
  p_fetched int,
  p_updated int,
  p_deactivated int,
  p_errors int,
  p_completed_at timestamptz
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE nppes_sync_run
  SET status = 'failed',
      completed_at = p_completed_at,
      error_details = jsonb_build_object('error', p_error),
      providers_fetched_count = p_fetched,
      providers_updated_count = p_updated,
      providers_deactivated_count = p_deactivated,
      errors_count = p_errors
  WHERE id = p_id;
$$;--> statement-breakpoint
ALTER FUNCTION nppes_writer_fail_sync_run(uuid, text, int, int, int, int, timestamptz) OWNER TO nppes_sync_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION nppes_writer_fail_sync_run(uuid, text, int, int, int, int, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION nppes_writer_fail_sync_run(uuid, text, int, int, int, int, timestamptz) TO wardenx_app;
