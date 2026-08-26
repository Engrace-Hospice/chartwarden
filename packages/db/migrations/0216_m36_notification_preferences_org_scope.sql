-- F-005 (#21) — `user_notification_preferences` had no tenant scoping at all.
--
-- WHAT WAS WRONG. The table carries `organization_id` (FK -> organization, ON DELETE CASCADE) and a
-- unique index on (user_id, organization_id): it is org-scoped, and it is not in check-tenancy.ts's
-- NON_ORG_SCOPED opt-out list. Its ONLY wardenx_app policy (`user_notif_pref_self`, migration 0017
-- lines 92-95) constrained neither the USING nor the WITH CHECK side by the org — both sides tested
-- the row's user_id against the session's user GUC and nothing else.
--
-- The intent — "a user sees only their own row", so that a phone number or vacation plan is not every
-- co-worker's business — is right and is preserved below. What was missing is that a PERMISSIVE policy
-- is a GRANT, not a filter: it is the whole of what wardenx_app may reach on this table, so with no org
-- predicate the tenant moat simply was not there.
--
-- Confirmed live as NOBYPASSRLS wardenx_app, in the envelope withOrgContext() creates (app.org_id =
-- org B, app.user_id = the caller): an org-B session READ org A's row, UPDATEd it, and INSERTed into
-- org A. Worse, because WITH CHECK validated only `user_id`, ANY organization_id satisfying the FK was
-- accepted — a session planted a row in a third tenant the caller has NO membership in whatsoever.
-- That is a cross-tenant WRITE, which makes this strictly wider than the sibling finding #15.
--
-- THE FIX. Add the org predicate as a CONJUNCT on both sides. This can only ever remove rows, never
-- admit them: it is not a second permissive branch (the shape ADR-0010 D3 bans and #15 was caused by),
-- it is the tenant moat that D1 requires on a table carrying organization_id. The `user_id` conjunct
-- stays — defence in depth, and it is what keeps the row private from co-workers.
--
-- NULLIF on both GUCs: `set_config(..., true)` reverts a custom GUC to the EMPTY STRING at commit, not
-- to NULL, so a pooled connection carries '' from the previous transaction and a bare `''::uuid` raises
-- 22P02 — aborting the statement instead of denying it. Migration 0194's header records hitting exactly
-- that on this table ("invalid input syntax for type uuid: ''"). NULLIF makes '' read as "no context",
-- which yields NULL, which matches nothing: still fail-CLOSED, minus the error.
--
-- NOT AFFECTED: `user_notification_preferences_for_org_users` (migration 0194) is SECURITY DEFINER and
-- runs as wardenx_admin under `user_notification_preferences_admin_all`, so the alert-routing engine's
-- legitimate cross-user read is untouched. It already scopes by `p_organization_id`.

DROP POLICY IF EXISTS user_notif_pref_self ON user_notification_preferences;--> statement-breakpoint
CREATE POLICY user_notif_pref_self ON user_notification_preferences
  FOR ALL TO wardenx_app
  USING (
    organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
