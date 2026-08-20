-- M2 pre-organization membership picker: immediately after sign-in a user has no active org, so
-- `GET /api/v1/auth/memberships` cannot use the normal app.org_id tenant policy. Permit the narrow
-- read needed to show only THAT user's own memberships and their organization display names. The
-- request establishes app.user_id transaction-locally through withUserContext(); it never gains a
-- cross-tenant or arbitrary-org context.
CREATE POLICY "membership_self_pre_org_read" ON "membership"
  FOR SELECT TO wardenx_app
  USING ("user_id" = current_setting('app.user_id', true)::uuid);--> statement-breakpoint

CREATE POLICY "organization_member_pre_org_read" ON "organization"
  FOR SELECT TO wardenx_app
  USING (
    EXISTS (
      SELECT 1
      FROM "membership"
      WHERE "membership"."organization_id" = "organization"."id"
        AND "membership"."user_id" = current_setting('app.user_id', true)::uuid
    )
  );
