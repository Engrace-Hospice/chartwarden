-- compat: contract
-- CW-MON-01 follow-up (#1177) — the security review's platform lane reads the org-less authentication events through three narrow
-- SECURITY DEFINER readers instead of a column grant on `audit_event`. Migration 1561 gave the BYPASSRLS platform login SELECT on six
-- `audit_event` columns, `context` included, across every tenant, and only the review's own `organization_id IS NULL` predicate kept it to
-- the org-less rows. This migration removes that grant and puts the bound in the database.
--
-- CONTRACT, and why it is one migration: the REVOKE removes a privilege the previous release's platform lane (a direct SELECT) still
-- uses, so that release's platform lane fails with 42501 from here until the new release runs. deploy.sh therefore holds this migration
-- for an operator (exit 75, previous release untouched); the operator applies it and rolls the release together. In the gap a platform
-- lane run FAILS LOUDLY (the job fails, the DLQ alert fires) and records nothing, so the cursor holds and the next run resumes from it
-- (a gap longer than the review's 24-hour catch-up cap is recorded and raised as review.incomplete_scan, not hidden): the org lanes are
-- not affected. Rolling back to the previous release after this migration is not possible for the same reason: roll forward.
--
-- THE PRIVILEGE MODEL
--   · `chartwarden_audit_reviewer` — a new NOLOGIN role, no BYPASSRLS, no membership, nobody logs in as it. It owns the three
--     functions and is the only role that holds any privilege on `audit_event` for this purpose: SELECT on the six columns the readers
--     use, and ONE row-security policy that admits only `organization_id IS NULL` rows to it. So even a defect in a function body
--     cannot return a tenant's row: the owner's session never sees one (proved live: SET ROLE chartwarden_audit_reviewer returns zero
--     tenant rows and cannot read `before`, `after`, `source_ip` or `user_agent`).
--   · The functions are SECURITY DEFINER with `search_path = pg_catalog, pg_temp` and every relation schema-qualified, so neither a
--     temp object nor a `public` object can stand in for a name. EXECUTE is revoked from PUBLIC and granted only to the platform
--     carrier `chartwarden_platform`, which the platform login (`chartwarden_platform_login`, DATABASE_PLATFORM_URL) inherits; the
--     carrier has no other member. `chartwarden_app` (the tenant pool) holds no EXECUTE.
--   · The platform login holds NO SELECT on `audit_event` (the INSERT it already had for the `platform.bypass_invoked` row is
--     unchanged): a direct SELECT of any column is refused (42501).
--   · NOT COVERED, stated plainly: the platform carrier still holds EXECUTE on the audit.archive job's SECURITY DEFINER functions
--     (migration 0432: `audit_archive_candidates`, `audit_archive_read_batch`; migration 1053: `audit_archive_detach(text, bigint,
--     boolean)`). `audit_archive_read_batch` returns WHOLE rows (`to_jsonb`) of every closed monthly partition (any month before the
--     current one), every tenant's, `before`/`after` included. `audit_archive_detach` detaches a closed partition from `audit_event`
--     (the table is kept, never dropped) and writes no audit row of its own; its legal-hold guard trusts the caller's
--     `p_manifest_verified` argument. That is the archive job's own path and is unchanged here; giving it a carrier of its own is a
--     separate follow-up. Until then, "the platform login cannot read tenant audit rows" is true of the open month and of this
--     review, not of closed months, and the same login can take a closed month out of every `audit_event` scan.
--
-- WHAT THE READERS RETURN, AND THEIR BOUNDS (each bound raises SQLSTATE 22023 instead of clamping, so a caller that outgrows one fails
-- loudly rather than reading less than it thinks; the review's constants are MAX_CATCH_UP_MS = 24 h, MAX_SIGNAL_ROWS = 20 000)
--   · m4_review_platform_signals(event types, from, to, limit, newest first): org-less `m2.auth.login_failed`, `.account_locked` and
--     `.login_succeeded` rows and nothing else (an event type outside that list is refused, so the reader cannot be pointed at another
--     event), as seven values: id, instant, event type, actor id and the three context keys the rules read (`userId`, `ipPrefix`,
--     `emailHash`, a hash). No tenant row, no `before`/`after`, no other context key, no free text. A window is at most 25 hours, starts
--     no earlier than 48 hours ago and ends no later than ten minutes ahead of the clock; at most 20 001 rows (the review's read cap
--     plus the one extra row it fetches to learn that it was cut short).
--   · m4_review_platform_cursor(): the `windowTo`, and the instant, of the newest clean org-less `m4.security_review.completed` row.
--   · m4_review_platform_raised_alerts(since, deliveries): the five alert keys (fingerprint, rule id, subject kind and ref, window end)
--     of the org-less `m4.security_review.alert_raised` rows since `since` (at most 48 hours back) whose delivery is one of `deliveries`,
--     newest first, at most 10 000 (more than a day of runs can raise; the memory it feeds only ever suppresses a repeat).
--   · The org-less bulk-access aggregate has no reader: no rule of the platform lane uses it, and the review refuses to ask for it.
--
-- Two limits, stated rather than implied: the review's own state (cursor, alert memory) is org-less audit rows that a writer of the audit
-- trail could forge (CW-MON-01 says so); and the org-less authentication rows carry a hash of an email and a /24 or /48 network, which is
-- what the alert already shows. Idempotent: CREATE OR REPLACE, IF NOT EXISTS, DROP POLICY IF EXISTS, and a REVOKE of a privilege that
-- may not be held.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_audit_reviewer') THEN
    CREATE ROLE chartwarden_audit_reviewer NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
COMMENT ON ROLE chartwarden_audit_reviewer IS
  'CW-MON-01: owns the m4_review_platform_* SECURITY DEFINER readers. NOLOGIN. Reads org-less audit_event rows only (RLS policy audit_event_m4_review_platform_read), six columns.';--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO chartwarden_audit_reviewer;--> statement-breakpoint
GRANT SELECT ("id", "created_at", "organization_id", "actor_user_id", "event_type", "context")
  ON "audit_event" TO chartwarden_audit_reviewer;--> statement-breakpoint
DROP POLICY IF EXISTS "audit_event_m4_review_platform_read" ON "audit_event";--> statement-breakpoint
CREATE POLICY "audit_event_m4_review_platform_read" ON "audit_event"
  FOR SELECT TO chartwarden_audit_reviewer USING ("organization_id" IS NULL);--> statement-breakpoint

CREATE OR REPLACE FUNCTION m4_review_platform_signals(
  p_event_types text[],
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer,
  p_newest_first boolean
) RETURNS TABLE (
  event_id uuid,
  occurred_at timestamptz,
  event_kind text,
  actor_id uuid,
  context_user_id text,
  ip_prefix text,
  account_hash text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  c_allowed constant text[] := ARRAY['m2.auth.login_failed', 'm2.auth.account_locked', 'm2.auth.login_succeeded'];
  c_max_span constant interval := interval '25 hours';
  c_max_age constant interval := interval '48 hours';
  c_max_ahead constant interval := interval '10 minutes';
  c_max_rows constant integer := 20001;
BEGIN
  IF p_event_types IS NULL OR cardinality(p_event_types) = 0 OR NOT (p_event_types <@ c_allowed) THEN
    RAISE EXCEPTION 'm4_review_platform_signals: event types must be a non-empty subset of %', c_allowed
      USING ERRCODE = '22023';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_limit IS NULL OR p_newest_first IS NULL
     OR p_to < p_from OR p_to - p_from > c_max_span
     OR p_from < now() - c_max_age OR p_to > now() + c_max_ahead
     OR p_limit < 1 OR p_limit > c_max_rows THEN
    RAISE EXCEPTION 'm4_review_platform_signals: window or row limit out of bounds'
      USING ERRCODE = '22023';
  END IF;

  IF p_newest_first THEN
    RETURN QUERY
      SELECT e.id, e.created_at, e.event_type, e.actor_user_id,
             e.context ->> 'userId', e.context ->> 'ipPrefix', e.context ->> 'emailHash'
        FROM public.audit_event e
       WHERE e.organization_id IS NULL
         AND e.event_type = ANY (p_event_types)
         AND e.created_at >= p_from
         AND e.created_at < p_to
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT p_limit;
  ELSE
    RETURN QUERY
      SELECT e.id, e.created_at, e.event_type, e.actor_user_id,
             e.context ->> 'userId', e.context ->> 'ipPrefix', e.context ->> 'emailHash'
        FROM public.audit_event e
       WHERE e.organization_id IS NULL
         AND e.event_type = ANY (p_event_types)
         AND e.created_at >= p_from
         AND e.created_at < p_to
       ORDER BY e.created_at, e.id
       LIMIT p_limit;
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION m4_review_platform_cursor()
RETURNS TABLE (window_to text, row_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT e.context ->> 'windowTo', e.created_at
    FROM public.audit_event e
   WHERE e.organization_id IS NULL
     AND e.event_type = 'm4.security_review.completed'
     AND e.context ->> 'status' = 'ok'
     AND e.created_at <= now()
   ORDER BY e.created_at DESC, e.id DESC
   LIMIT 1;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION m4_review_platform_raised_alerts(
  p_since timestamptz,
  p_deliveries text[]
) RETURNS TABLE (
  fingerprint text,
  rule_id text,
  subject_kind text,
  subject_ref text,
  window_to text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  c_max_age constant interval := interval '48 hours';
  c_max_ahead constant interval := interval '10 minutes';
  c_max_rows constant integer := 10000;
BEGIN
  IF p_since IS NULL OR p_deliveries IS NULL OR cardinality(p_deliveries) = 0
     OR p_since < now() - c_max_age OR p_since > now() + c_max_ahead THEN
    RAISE EXCEPTION 'm4_review_platform_raised_alerts: since or deliveries out of bounds'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT e.context ->> 'fingerprint',
           e.context ->> 'ruleId',
           e.context -> 'subject' ->> 'kind',
           e.context -> 'subject' ->> 'ref',
           e.context ->> 'windowTo'
      FROM public.audit_event e
     WHERE e.organization_id IS NULL
       AND e.event_type = 'm4.security_review.alert_raised'
       AND e.created_at >= p_since
       AND e.context ->> 'delivery' = ANY (p_deliveries)
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT c_max_rows;
END;
$$;--> statement-breakpoint

ALTER FUNCTION m4_review_platform_signals(text[], timestamptz, timestamptz, integer, boolean)
  OWNER TO chartwarden_audit_reviewer;--> statement-breakpoint
ALTER FUNCTION m4_review_platform_cursor() OWNER TO chartwarden_audit_reviewer;--> statement-breakpoint
ALTER FUNCTION m4_review_platform_raised_alerts(timestamptz, text[]) OWNER TO chartwarden_audit_reviewer;--> statement-breakpoint
REVOKE ALL ON FUNCTION m4_review_platform_signals(text[], timestamptz, timestamptz, integer, boolean) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION m4_review_platform_cursor() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION m4_review_platform_raised_alerts(timestamptz, text[]) FROM PUBLIC;--> statement-breakpoint

-- The platform carrier exists only where provision-runtime-roles.ts has run; that script grants the same EXECUTE and revokes the old
-- column grant on every run, so a database provisioned AFTER this migration gets both from the script, and one provisioned BEFORE
-- gets them here.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    GRANT EXECUTE ON FUNCTION m4_review_platform_signals(text[], timestamptz, timestamptz, integer, boolean) TO chartwarden_platform;
    GRANT EXECUTE ON FUNCTION m4_review_platform_cursor() TO chartwarden_platform;
    GRANT EXECUTE ON FUNCTION m4_review_platform_raised_alerts(timestamptz, text[]) TO chartwarden_platform;
    REVOKE SELECT ("id", "created_at", "organization_id", "actor_user_id", "event_type", "context")
      ON "audit_event" FROM chartwarden_platform;
  END IF;
END $$;
