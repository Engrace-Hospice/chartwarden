-- M1 §3.10 (WX-PR-014 M33 follow-up) — a platform-wide (organization_id IS NULL) write/dispatch path
-- for `outbox_event`, so a genuinely platform-wide event (M33's cross-tenant MV refresh, the replica-
-- lag probe — no single tenant it belongs to) can flow through the SAME transactional-outbox mechanism
-- every org-scoped event uses, instead of being permanently unbindable.
--
-- WHY NOT A SECOND RLS POLICY KEYED ON A NEW GUC (the first attempt at this migration, reverted):
-- ADR-0010 D2 (enforced by scripts/check-tenancy.ts, arch:tenancy) bans any RLS predicate referencing a
-- session variable other than `app.org_id` — no `app.platform_context` or similar is permitted, full
-- stop. And ADR-0010 D3 (Rule 3a) separately bans an org-alternative disjunct (organization_id being
-- unset) added onto any policy that is ALSO tenant-writable, because that shape would let ANY
-- authenticated tenant session insert a platform-wide row (the null-org branch passes the WITH CHECK
-- regardless of which tenant is writing). Both rules exist because a SECOND way to widen row
-- visibility/writability, beyond the one canonical `app.org_id` GUC, is exactly the class of bug that
-- produces a cross-tenant leak.
--
-- THE PATTERN THIS MIGRATION ACTUALLY USES mirrors the one this codebase already uses for cross-tenant
-- writes elsewhere: `wardenx_audit_writer`'s `audit_writer_insert` policy (migration 0013) — `FOR INSERT
-- TO wardenx_audit_writer WITH CHECK (true)`, a policy scoped to a NARROW, DEDICATED role (not
-- `wardenx_app`, not a new GUC), invoked from ordinary application code THROUGH a SECURITY DEFINER
-- function that runs with the definer's elevated privilege for its own body only. `wardenx_app` never
-- gains role membership in the writer role (so it can never satisfy the writer's policy directly,
-- accidentally or otherwise) — it only gets EXECUTE on the specific functions below, each of which
-- touches `organization_id IS NULL` rows ONLY (hardcoded inside the function body, never a caller-
-- supplied parameter, so there is no way to widen scope through an argument).
--
-- `report_writer` (migration 0056) is M33's existing SECURITY DEFINER writer role for exactly this class
-- of platform-scoped write (the `report_mv.select_<mv_key>()` wrapper functions + MV-telemetry writes) —
-- reused here rather than inventing a new role.
ALTER TABLE "outbox_event" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint

DROP POLICY IF EXISTS "outbox_event_platform_writer" ON "outbox_event";--> statement-breakpoint
CREATE POLICY "outbox_event_platform_writer" ON "outbox_event"
  FOR ALL TO report_writer
  USING ("organization_id" IS NULL)
  WITH CHECK ("organization_id" IS NULL);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "outbox_event" TO report_writer;--> statement-breakpoint

-- ── (1) publish: the tx-scoped outbox publisher's INSERT for a platform-wide event ─────────────────────
CREATE OR REPLACE FUNCTION report_writer_insert_platform_outbox_event(
  p_event_type text,
  p_aggregate_kind text,
  p_aggregate_id uuid,
  p_payload jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO outbox_event (organization_id, event_type, aggregate_kind, aggregate_id, payload)
  VALUES (NULL, p_event_type, p_aggregate_kind, p_aggregate_id, p_payload)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;--> statement-breakpoint
ALTER FUNCTION report_writer_insert_platform_outbox_event(text, text, uuid, jsonb) OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_writer_insert_platform_outbox_event(text, text, uuid, jsonb) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_writer_insert_platform_outbox_event(text, text, uuid, jsonb) TO wardenx_app;--> statement-breakpoint

-- ── (2) dispatcher: reclaim rows stuck 'dispatching' past the visibility timeout (a crash mid-delivery) ─
CREATE OR REPLACE FUNCTION report_writer_reclaim_platform_outbox(
  p_now timestamptz,
  p_visibility_timeout_ms bigint
) RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE outbox_event
  SET status = 'pending', dispatched_at = NULL
  WHERE organization_id IS NULL
    AND status = 'dispatching'
    AND dispatched_at < (p_now - make_interval(secs => p_visibility_timeout_ms / 1000.0))
  RETURNING id;
$$;--> statement-breakpoint
ALTER FUNCTION report_writer_reclaim_platform_outbox(timestamptz, bigint) OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_writer_reclaim_platform_outbox(timestamptz, bigint) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_writer_reclaim_platform_outbox(timestamptz, bigint) TO wardenx_app;--> statement-breakpoint

-- ── (3) dispatcher: claim a batch of due pending rows (FOR UPDATE SKIP LOCKED, attempt counted at claim) ─
CREATE OR REPLACE FUNCTION report_writer_claim_platform_outbox(
  p_now timestamptz,
  p_batch_size int
) RETURNS SETOF outbox_event
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  UPDATE outbox_event
  SET status = 'dispatching', attempt_count = outbox_event.attempt_count + 1, dispatched_at = p_now
  WHERE id IN (
    SELECT oe.id FROM outbox_event oe
    WHERE oe.organization_id IS NULL
      AND oe.status = 'pending'
      AND (oe.next_attempt_at IS NULL OR oe.next_attempt_at <= p_now)
    ORDER BY oe.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING outbox_event.*;
END;
$$;--> statement-breakpoint
ALTER FUNCTION report_writer_claim_platform_outbox(timestamptz, int) OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_writer_claim_platform_outbox(timestamptz, int) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_writer_claim_platform_outbox(timestamptz, int) TO wardenx_app;--> statement-breakpoint

-- ── (4) dispatcher: the four finalize terminal shapes (mirrors pollOrg's four `finalize({...})` calls) ──
CREATE OR REPLACE FUNCTION report_writer_finalize_platform_outbox_dispatched(
  p_id uuid,
  p_dispatched_at timestamptz
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE outbox_event
  SET status = 'dispatched', dispatched_at = p_dispatched_at, last_error = NULL, next_attempt_at = NULL
  WHERE id = p_id AND organization_id IS NULL;
$$;--> statement-breakpoint
ALTER FUNCTION report_writer_finalize_platform_outbox_dispatched(uuid, timestamptz) OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_writer_finalize_platform_outbox_dispatched(uuid, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_writer_finalize_platform_outbox_dispatched(uuid, timestamptz) TO wardenx_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION report_writer_finalize_platform_outbox_deferred(
  p_id uuid,
  p_attempt_count int,
  p_next_attempt_at timestamptz,
  p_last_error text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE outbox_event
  SET status = 'pending',
      dispatched_at = NULL,
      attempt_count = p_attempt_count,
      next_attempt_at = p_next_attempt_at,
      last_error = p_last_error
  WHERE id = p_id AND organization_id IS NULL;
$$;--> statement-breakpoint
ALTER FUNCTION report_writer_finalize_platform_outbox_deferred(uuid, int, timestamptz, text) OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_writer_finalize_platform_outbox_deferred(uuid, int, timestamptz, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_writer_finalize_platform_outbox_deferred(uuid, int, timestamptz, text) TO wardenx_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION report_writer_finalize_platform_outbox_retry(
  p_id uuid,
  p_next_attempt_at timestamptz,
  p_last_error text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE outbox_event
  SET status = 'pending', dispatched_at = NULL, next_attempt_at = p_next_attempt_at, last_error = p_last_error
  WHERE id = p_id AND organization_id IS NULL;
$$;--> statement-breakpoint
ALTER FUNCTION report_writer_finalize_platform_outbox_retry(uuid, timestamptz, text) OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_writer_finalize_platform_outbox_retry(uuid, timestamptz, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_writer_finalize_platform_outbox_retry(uuid, timestamptz, text) TO wardenx_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION report_writer_finalize_platform_outbox_dead_letter(
  p_id uuid,
  p_last_error text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE outbox_event
  SET status = 'failed', dispatched_at = NULL, last_error = p_last_error
  WHERE id = p_id AND organization_id IS NULL;
$$;--> statement-breakpoint
ALTER FUNCTION report_writer_finalize_platform_outbox_dead_letter(uuid, text) OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_writer_finalize_platform_outbox_dead_letter(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_writer_finalize_platform_outbox_dead_letter(uuid, text) TO wardenx_app;--> statement-breakpoint

-- ── (5) dispatcher: retention purge for old dispatched platform rows ────────────────────────────────────
CREATE OR REPLACE FUNCTION report_writer_purge_platform_outbox(p_cutoff timestamptz) RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  DELETE FROM outbox_event
  WHERE organization_id IS NULL AND status = 'dispatched' AND dispatched_at < p_cutoff
  RETURNING id;
$$;--> statement-breakpoint
ALTER FUNCTION report_writer_purge_platform_outbox(timestamptz) OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_writer_purge_platform_outbox(timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_writer_purge_platform_outbox(timestamptz) TO wardenx_app;
