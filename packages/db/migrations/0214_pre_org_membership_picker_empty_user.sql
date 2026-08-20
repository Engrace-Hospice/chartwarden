-- Correct the initial pre-org picker policy for org-scoped reads that deliberately carry an empty
-- app.user_id audit attribution. PostgreSQL may evaluate permissive policies in either order, so
-- `''::uuid` must never be reachable even when the ordinary app.org_id policy already admits a row.
DROP POLICY IF EXISTS "membership_self_pre_org_read" ON "membership";--> statement-breakpoint
CREATE POLICY "membership_self_pre_org_read" ON "membership"
  FOR SELECT TO wardenx_app
  USING ("user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "organization_member_pre_org_read" ON "organization";--> statement-breakpoint
CREATE POLICY "organization_member_pre_org_read" ON "organization"
  FOR SELECT TO wardenx_app
  USING (
    EXISTS (
      SELECT 1
      FROM "membership"
      WHERE "membership"."organization_id" = "organization"."id"
        AND "membership"."user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );
