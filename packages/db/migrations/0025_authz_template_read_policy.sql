-- M3 Authorization — let tenants READ platform role templates (org_id NULL).
--
-- The original `role_org` / `role_permission_org` policies (0009) scoped BOTH read and write to
-- `organization_id = app.org_id`. Because a platform template carries `organization_id = NULL`, that
-- USING clause hid every template from `wardenx_app` (NULL = app.org_id is NULL/false) — so GET /roles
-- returned only the org's own roles, not the ~60 templates a tenant is meant to see and clone (§3.4).
-- (Surfaced by the wardenx_app-role test harness, #48.)
--
-- Widen the USING (read) clause to also surface NULL-org template rows. The WITH CHECK (write) clause is
-- left strict (`organization_id = app.org_id`), so `wardenx_app` still cannot create or modify a template
-- — only the platform context (wardenx_admin) writes NULL-org rows. ALTER POLICY changes only the USING
-- clause; WITH CHECK is unchanged.
ALTER POLICY "role_org" ON "role"
  USING ("organization_id" = current_setting('app.org_id', true)::uuid OR "organization_id" IS NULL);--> statement-breakpoint
ALTER POLICY "role_permission_org" ON "role_permission"
  USING ("organization_id" = current_setting('app.org_id', true)::uuid OR "organization_id" IS NULL);
