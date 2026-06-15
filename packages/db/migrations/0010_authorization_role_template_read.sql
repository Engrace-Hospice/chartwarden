-- M3 Authorization §3.6 — platform role-template READ exception (the org-NULL branch).
--
-- `role` and `role_permission` rows with organization_id IS NULL are the ≈60 platform
-- role templates: readable by every tenant (a tenant clones/extends them into org-owned
-- rows) but writable only through the platform context. The org-isolation WRITE policies
-- in 0009 never admit a NULL org, so these SELECT-only policies are the single permitted
-- `organization_id IS NULL` shape for M3.
--
-- This file is deliberately isolated (the migration-0002 feature_flag pattern): it contains
-- ONLY FOR SELECT policies, no WITH CHECK / FOR ALL, so check-tenancy.ts rule 3a can confirm
-- the NULL read branch never co-resides with a tenant-writable policy. Postgres permissive
-- policies OR together, so each table now reads as "my org's rows OR the platform templates"
-- while writes remain restricted to my-org rows by 0009.
CREATE POLICY "role_template_read" ON "role"
  FOR SELECT TO wardenx_app
  USING (
    "organization_id" = current_setting('app.org_id', true)::uuid
    OR "organization_id" IS NULL
  );--> statement-breakpoint
CREATE POLICY "role_permission_template_read" ON "role_permission"
  FOR SELECT TO wardenx_app
  USING (
    "organization_id" = current_setting('app.org_id', true)::uuid
    OR "organization_id" IS NULL
  );
