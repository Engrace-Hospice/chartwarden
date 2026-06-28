-- M23 Billing — Medicare §3.5 / D12 — `wage_index_factor` PLATFORM-SHARED RLS & grants. ISOLATED file
-- (the M38 terminology / M27 0071 precedent): it contains ONLY this one platform-shared table's policies,
-- so it never co-resides with a tenant-scoped FOR ALL/WITH CHECK policy and the check-tenancy rules stay
-- satisfied (read-all `USING(true)` is not an org-scoped policy; the single FOR ALL is for the loader
-- role, not wardenx_app — no nullable-org write branch, no second permissive FOR ALL).
--
-- D12: the CMS hospice wage index is public reference data, updated annually (Oct cutover), identical for
-- every tenant in a CBSA. It has NO organization_id. Every tenant READS it (HIPPS calculator snapshots
-- the factor into hipps_calculation for audit reproducibility); only the platform writes it.
--
-- Least-privilege writer role `billing_platform_loader` (the terminology_loader / mdm_canonical_writer
-- precedent): owns wage_index_factor INSERT/UPDATE/DELETE and the per-PE sequestration baseline seed
-- (applied at onboarding — see 0080). Granted to the SECURITY DEFINER platform loaders in packages/billing
-- only. wardenx_app NEVER writes wage_index_factor (§3.5: REVOKE INSERT/UPDATE/DELETE).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'billing_platform_loader') THEN
    CREATE ROLE billing_platform_loader NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
COMMENT ON ROLE billing_platform_loader IS
  'Owns M23 platform reference writes (wage_index_factor + per-PE sequestration_policy baseline). Granted to SECURITY DEFINER platform loaders in packages/billing only. wardenx_app NEVER writes wage_index_factor (M23 §3.5 / D12).';--> statement-breakpoint

ALTER TABLE "wage_index_factor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Read-all: every tenant reads the platform wage index (non-tenant reference data).
CREATE POLICY "wage_index_factor_read_all" ON "wage_index_factor"
  FOR SELECT TO wardenx_app
  USING (true);--> statement-breakpoint
-- Platform-only write (the single FOR ALL policy — for the loader role, not wardenx_app).
CREATE POLICY "wage_index_factor_write_platform_only" ON "wage_index_factor"
  FOR ALL TO billing_platform_loader
  USING (true)
  WITH CHECK (true);--> statement-breakpoint
GRANT SELECT ON "wage_index_factor" TO wardenx_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "wage_index_factor" FROM wardenx_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "wage_index_factor" TO billing_platform_loader;--> statement-breakpoint
GRANT ALL ON "wage_index_factor" TO wardenx_admin;
