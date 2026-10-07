-- 0472 — M39 GAP-171: the §4.9 `m39.draft_auto_expire` discard, as a narrow SECURITY DEFINER function.
--
-- Spec §4.9: "Discard (DELETE) drafts older than 30 days" — housekeeping TTL only (M39-F13): rows with
-- `status='draft'` AND `signed_at IS NULL`, which carry no §24 retention obligation. `wardenx_app` has NO DELETE
-- on `consent_record` / `consent_record_recipient` / `consent_record_dpoa_agent` / `consent_document_link`
-- (0023 grants SELECT, INSERT, UPDATE only — a legally operative consent must never be deletable from the app
-- pool). Granting DELETE would make every signed consent one bug away from erasure, so the discard is a function
-- that can ONLY ever delete unsigned drafts:
--   • owned by `wardenx_destruction`, which already holds SELECT+DELETE on exactly these tables (0157) and has an
--     `app.org_id`-keyed policy on each, so the delete is tenant-scoped by RLS;
--   • refuses unless the caller's `app.org_id` equals the org argument (a cron must open `withOrgContext` first);
--   • selects `status='draft' AND signed_at IS NULL AND created_at < p_cutoff`, `FOR UPDATE SKIP LOCKED`, bounded
--     by `p_limit` (clamped 1..500) so one tick never holds a long lock;
--   • deletes the draft's children first (restrict FKs), then the draft, re-checking `status='draft'`.
-- `SELECT ... FOR UPDATE` needs UPDATE privilege, which `wardenx_destruction` lacks, so it gets the narrowest
-- grant that satisfies the row lock: UPDATE on the single column `status` (the lock is what stops a draft being
-- signed between the child deletes and the parent delete).
-- The M4 write-audit trigger still fires on each DELETE (actor NULL = system), so the discard is on the trail.
GRANT UPDATE ("status") ON "consent_record" TO wardenx_destruction;--> statement-breakpoint
CREATE OR REPLACE FUNCTION consent_draft_discard_expired(
  p_organization_id uuid,
  p_cutoff timestamptz,
  p_limit integer DEFAULT 100
) RETURNS TABLE (consent_record_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  IF p_organization_id IS DISTINCT FROM nullif(current_setting('app.org_id', true), '')::uuid THEN
    RAISE EXCEPTION 'CONSENT_DRAFT_DISCARD_ORG_MISMATCH: caller org context does not match %', p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT array_agg(d.id) INTO v_ids
  FROM (
    SELECT cr.id
    FROM consent_record cr
    WHERE cr.organization_id = p_organization_id
      AND cr.status = 'draft'
      AND cr.signed_at IS NULL
      AND cr.created_at < p_cutoff
    ORDER BY cr.created_at, cr.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
    FOR UPDATE SKIP LOCKED
  ) d;

  IF v_ids IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM consent_record_recipient WHERE consent_record_recipient.consent_record_id = ANY (v_ids);
  DELETE FROM consent_record_dpoa_agent WHERE consent_record_dpoa_agent.consent_record_id = ANY (v_ids);
  DELETE FROM consent_document_link WHERE consent_document_link.consent_record_id = ANY (v_ids);
  DELETE FROM consent_record WHERE id = ANY (v_ids) AND status = 'draft' AND signed_at IS NULL;

  RETURN QUERY SELECT unnest(v_ids);
END;
$$;--> statement-breakpoint
ALTER FUNCTION consent_draft_discard_expired(uuid, timestamptz, integer) OWNER TO wardenx_destruction;--> statement-breakpoint
REVOKE ALL ON FUNCTION consent_draft_discard_expired(uuid, timestamptz, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION consent_draft_discard_expired(uuid, timestamptz, integer) TO wardenx_app;
