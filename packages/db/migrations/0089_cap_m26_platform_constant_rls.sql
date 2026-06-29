-- M26 Cap Management §3.5 / D3 — `cap_period_platform_constant` PLATFORM-SHARED RLS & grants. ISOLATED file
-- (the M23 0078 wage-index / M27 0071 precedent): it contains ONLY this one platform-shared table's
-- policies, so it never co-resides with a tenant-scoped FOR ALL/WITH CHECK policy and the check-tenancy
-- rules stay satisfied (read-all `USING(true)` is not an org-scoped policy; the single FOR ALL is for the
-- loader role, not wardenx_app — no nullable-org write branch, no second permissive FOR ALL).
--
-- D3: the CMS-published per-beneficiary cap dollar amount is public reference data, published annually (the
-- July/Aug Hospice Wage Index Final Rule), identical for every tenant, and SNAPSHOTTED (immutable copy) into
-- each tenant's cap_period at open. It has NO organization_id. Every tenant READS it; only the platform
-- writes it (and only before first tenant use — enforced at the application layer via first_tenant_use_at).
--
-- Least-privilege writer role `cap_platform_loader` (the billing_platform_loader / terminology_loader
-- precedent): owns cap_period_platform_constant INSERT/UPDATE. Granted to the SECURITY DEFINER platform
-- constant manager in the backend only. wardenx_app NEVER writes the constant (§3.5: REVOKE INSERT/UPDATE/DELETE).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cap_platform_loader') THEN
    CREATE ROLE cap_platform_loader NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
COMMENT ON ROLE cap_platform_loader IS
  'Owns M26 cap_period_platform_constant writes (the CMS-published per-cap-year amount). Granted to the SECURITY DEFINER platform-constant manager in the backend only. wardenx_app NEVER writes it (M26 §3.5 / D3).';--> statement-breakpoint

ALTER TABLE "cap_period_platform_constant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Read-all: every tenant reads the platform cap constant (non-tenant reference data).
CREATE POLICY "cap_platform_constant_read_all" ON "cap_period_platform_constant"
  FOR SELECT TO wardenx_app
  USING (true);--> statement-breakpoint
-- Platform-only write (the single FOR ALL policy — for the loader role, not wardenx_app).
CREATE POLICY "cap_platform_constant_write_platform_only" ON "cap_period_platform_constant"
  FOR ALL TO cap_platform_loader
  USING (true)
  WITH CHECK (true);--> statement-breakpoint
GRANT SELECT ON "cap_period_platform_constant" TO wardenx_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "cap_period_platform_constant" FROM wardenx_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "cap_period_platform_constant" TO cap_platform_loader;--> statement-breakpoint
GRANT ALL ON "cap_period_platform_constant" TO wardenx_admin;
