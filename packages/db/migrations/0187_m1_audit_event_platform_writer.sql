-- M1/M4 (WX-PR-024) — a platform-scoped (organization_id IS NULL) write path for `audit_event`, so
-- `withPlatformContext`'s MANDATORY `platform.bypass_invoked` audit write ("every cross-tenant bypass
-- is audited" — the whole mechanism's reason for existing) can actually succeed under real
-- (NOBYPASSRLS) RLS, as `wardenx_app` — the role every request/worker connection runs as in
-- production.
--
-- THE BUG (confirmed by direct `psql`, `SET ROLE wardenx_app`, NOBYPASSRLS):
--   INSERT INTO audit_event (organization_id, actor_kind, event_type, resource_kind, outcome,
--                            correlation_id, severity)
--   VALUES (NULL, 'system', 'platform.bypass_invoked', 'tenant', 'success', 'x', 'warn');
--   ERROR:  new row violates row-level security policy for table "audit_event"
--
-- `audit_event`'s only null-org write path is `audit_writer_insert FOR INSERT TO wardenx_audit_writer
-- WITH CHECK (true)` (migration 0013) — a role `wardenx_app` does not hold. Migration 0119's org-scoped
-- fix (`audit_event_org_append`) deliberately excludes null-org rows ("Platform-scoped rows... must
-- continue to go through the M34 bypass auditor under withPlatformContext") — but nothing ever built
-- that role/policy path FOR the auditor itself. Since EVERY `withPlatformContext` call in the codebase
-- (M7/M9/M10/M25/M27/M30/M33/M34+) executes this same audit write as its unconditional first step,
-- every one of them throws on entry under a properly-hardened production deployment today.
--
-- WHY NOT A SECOND RLS POLICY / GUC (rejected, same reasoning migration 0186 already documents for
-- `outbox_event`): ADR-0010 D2 bans any RLS predicate keyed on a session variable other than
-- `app.org_id`; ADR-0010 D3 (Rule 3a) bans an org-alternative disjunct on a policy that is ALSO
-- tenant-writable (that shape would let ANY authenticated tenant session insert a platform-wide row —
-- the null-org branch passes the WITH CHECK regardless of which tenant is writing).
--
-- THE PATTERN THIS MIGRATION USES mirrors 0186's `outbox_event` fix exactly, reusing the ALREADY-
-- EXISTING `wardenx_audit_writer` role (0001) and its `audit_writer_insert` policy (0013, WITH CHECK
-- (true)) rather than inventing a new role: a SECURITY DEFINER function owned by `wardenx_audit_writer`
-- (so it satisfies that policy directly), invoked from ordinary application code through an EXECUTE
-- grant to `wardenx_app`. `organization_id` and `actor_kind` are hardcoded NULL / 'system' inside the
-- function body — never caller-supplied parameters — so there is no way to widen scope through an
-- argument (the `wardenx_app` role never gains membership in `wardenx_audit_writer`, so it can never
-- satisfy the writer's policy directly, accidentally or otherwise).
CREATE OR REPLACE FUNCTION audit_writer_insert_platform_event(
  p_event_type text,
  p_resource_kind text,
  p_resource_id uuid,
  p_outcome text,
  p_severity text,
  p_correlation_id text,
  p_context jsonb,
  p_retention_class text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- No RETURNING: `wardenx_audit_writer` deliberately holds INSERT only on `audit_event` (append-only,
  -- 0012/0013 — it has never needed SELECT). A RETURNING clause requires SELECT privilege on its
  -- columns AND passes through the SAME row-security check as a SELECT — and `audit_writer_insert`
  -- (0013) is `FOR INSERT` only, with no SELECT policy admitting the row back, so a RETURNING here
  -- would fail RLS on its own output even though the INSERT itself succeeded. Widening the writer's
  -- grant/policy to SELECT (mirroring `outbox_event`'s `FOR ALL` writer policy) would work too, but
  -- would broaden this narrowly-scoped append-only role for no caller need — no caller uses the
  -- inserted row's id.
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind,
                            resource_id, outcome, correlation_id, severity, context, retention_class)
  VALUES (NULL, NULL, 'system', p_event_type, p_resource_kind, p_resource_id,
          p_outcome::audit_outcome, p_correlation_id, p_severity::audit_severity, p_context,
          p_retention_class::audit_retention_class);
END;
$$;--> statement-breakpoint
ALTER FUNCTION audit_writer_insert_platform_event(text, text, uuid, text, text, text, jsonb, text)
  OWNER TO wardenx_audit_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_writer_insert_platform_event(text, text, uuid, text, text, text, jsonb, text)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_writer_insert_platform_event(text, text, uuid, text, text, text, jsonb, text)
  TO wardenx_app;
