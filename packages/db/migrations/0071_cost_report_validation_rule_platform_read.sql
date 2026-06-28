-- M27 §3.5 — cost_report_validation_rule platform-default READ exception (the org-NULL branch).
--
-- `cost_report_validation_rule` rows with organization_id IS NULL are the 28 platform-default rules (+
-- the NGS-J6 MAC profile + the draft_suggestion rows): readable by every tenant (a tenant layers
-- tenant-specific rules + tightens platform severity, D21) but writable only through the platform
-- context. The org-isolation FOR ALL policy in 0070 never admits a NULL org, so this SELECT-only policy
-- is the single permitted `organization_id IS NULL` shape for M27.
--
-- Deliberately isolated (the migration-0002 feature_flag / 0010 role-template precedent): this file
-- contains ONLY a FOR SELECT policy, no WITH CHECK / FOR ALL, so check-tenancy.ts rule 3a confirms the
-- NULL read branch never co-resides with a tenant-writable policy. Postgres permissive policies OR
-- together, so the table now reads as "my org's rules OR the platform defaults" while writes remain
-- restricted to my-org rows by 0070.
CREATE POLICY "cost_report_validation_rule_platform_read" ON "cost_report_validation_rule"
  FOR SELECT TO wardenx_app
  USING (
    "organization_id" = current_setting('app.org_id', true)::uuid
    OR "organization_id" IS NULL
  );
