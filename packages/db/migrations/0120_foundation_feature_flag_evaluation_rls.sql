-- M1 Foundation §3.3 — `feature_flag_evaluation` gets the RLS it never had.
--
-- The table was created in 0000 with an `organization_id` column and granted
-- INSERT/SELECT/UPDATE/DELETE to wardenx_app in 0001 (line 118, in the same list as `organization`,
-- `membership` and `session`) — and then no policy was ever written for it. Verified on a live
-- catalog: `relrowsecurity=false, relforcerowsecurity=false, policies=0, grants to wardenx_app=4`.
-- Every tenant could read and write every other tenant's flag-evaluation rows.
--
-- It survived because nothing looks for this. `check-tenancy.ts` validates the SHAPE of policies that
-- exist (canonical `app.org_id`, no dangerous OR-ing, the three-column rule) and never asks whether a
-- policy exists at all; migration 0118 FORCEd the 370 tables that already had RLS enabled, which by
-- definition skipped this one. The companion assertion added to rls-isolation.live.test.ts closes the
-- class: it walks pg_class for every table carrying `organization_id` and fails if RLS is off.
--
-- WHAT IT LEAKS. Not clinical content — a row is (flag_id, organization_id, user_id, evaluated_value,
-- targeting_matched, evaluated_at). But it is a per-tenant, per-USER behavioural record: which
-- capabilities a named user was served and when. Cross-tenant readable, that is a roster of another
-- organization's users and the features they are piloting.
--
-- POLICY SHAPE mirrors `feature_flag` itself (0001 + 0002), because the two tables share the same
-- org-NULL semantics:
--   * READ admits `organization_id IS NULL` — a GLOBAL flag evaluation belongs to no tenant and every
--     tenant may see it (the 0002 `feature_flag_org_read` precedent).
--   * WRITE does NOT. The WITH CHECK is a plain `=`, which yields NULL (not true) for a null org and
--     therefore refuses it, so a tenant connection can neither forge nor mutate a global evaluation
--     row. That asymmetry is deliberate and is the same one 0001 applies to `feature_flag` (M01-F06a).
-- Three per-command policies rather than one FOR ALL: a single permissive FOR ALL would make the
-- read's org-NULL exception apply to writes too.

ALTER TABLE "feature_flag_evaluation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feature_flag_evaluation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "feature_flag_evaluation_org_read" ON "feature_flag_evaluation";--> statement-breakpoint
CREATE POLICY "feature_flag_evaluation_org_read" ON "feature_flag_evaluation"
  FOR SELECT TO wardenx_app
  USING (
    "organization_id" = current_setting('app.org_id', true)::uuid
    OR "organization_id" IS NULL
  );--> statement-breakpoint

DROP POLICY IF EXISTS "feature_flag_evaluation_org_insert" ON "feature_flag_evaluation";--> statement-breakpoint
CREATE POLICY "feature_flag_evaluation_org_insert" ON "feature_flag_evaluation"
  FOR INSERT TO wardenx_app
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "feature_flag_evaluation_org_delete" ON "feature_flag_evaluation";--> statement-breakpoint
CREATE POLICY "feature_flag_evaluation_org_delete" ON "feature_flag_evaluation"
  FOR DELETE TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- No UPDATE policy: an evaluation is an APPEND-ONLY observation of what a flag resolved to at a
-- moment. Rewriting one would falsify the record rather than correct it, and nothing in the code
-- updates this table. The UPDATE grant from 0001 stays (revoking it is a separate, wider change), but
-- with RLS forced and no UPDATE policy, an update is refused.
