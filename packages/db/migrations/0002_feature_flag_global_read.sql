-- M1 Foundation §3.11 — feature_flag GLOBAL read policy (M01-F06a).
--
-- Tenants may READ their own org's flags AND platform-global (org-NULL) flags, but
-- may only WRITE org-scoped flags. The write policies live in migration 0001 and
-- never admit a NULL org. This read-only SELECT policy is the single permitted
-- `organization_id IS NULL` shape in the slice; it is deliberately isolated in its
-- own migration file so the tenancy gate (check-tenancy.ts rule 3a) can confirm the
-- NULL branch never co-resides with a tenant-writable policy. Global flags are
-- managed only through the platform context.
CREATE POLICY "feature_flag_org_read" ON "feature_flag"
  FOR SELECT TO wardenx_app
  USING (
    "organization_id" = current_setting('app.org_id', true)::uuid
    OR "organization_id" IS NULL
  );