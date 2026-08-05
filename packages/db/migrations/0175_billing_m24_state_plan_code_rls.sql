-- M24 Billing — Medicaid (WX-PR-011) — `medicaid_state_plan_code` PLATFORM-SHARED RLS & grants. ISOLATED file
-- (the M23 wage_index_factor 0078 / M27 0071 precedent): contains ONLY this one platform-shared table's
-- policies, so it never co-resides with a tenant-scoped FOR ALL/WITH CHECK policy and check-tenancy stays
-- satisfied (read-all `USING(true)` is not an org-scoped policy; the single FOR ALL is for the loader role,
-- not wardenx_app).
--
-- Every tenant READS the state plan-code catalog (claim assembly snapshots the matched row into
-- medicaid_claim.state_plan_code_id / _snapshot for audit reproducibility); only the platform writes it.
-- Least-privilege writer role `medicaid_platform_loader` (the billing_platform_loader / mdm_canonical_writer
-- precedent) owns INSERT/UPDATE/DELETE. wardenx_app NEVER writes this table.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medicaid_platform_loader') THEN
    CREATE ROLE medicaid_platform_loader NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
COMMENT ON ROLE medicaid_platform_loader IS
  'Owns M24 platform reference writes (medicaid_state_plan_code). Granted to SECURITY DEFINER platform loaders in packages/medicaid-adapters only. wardenx_app NEVER writes medicaid_state_plan_code (WX-PR-011, M23 wage_index_factor D12 precedent).';--> statement-breakpoint

ALTER TABLE "medicaid_state_plan_code" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medicaid_state_plan_code_read_all" ON "medicaid_state_plan_code"
  FOR SELECT TO wardenx_app
  USING (true);--> statement-breakpoint
CREATE POLICY "medicaid_state_plan_code_write_platform_only" ON "medicaid_state_plan_code"
  FOR ALL TO medicaid_platform_loader
  USING (true)
  WITH CHECK (true);--> statement-breakpoint
GRANT SELECT ON "medicaid_state_plan_code" TO wardenx_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "medicaid_state_plan_code" FROM wardenx_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "medicaid_state_plan_code" TO medicaid_platform_loader;--> statement-breakpoint
GRANT ALL ON "medicaid_state_plan_code" TO wardenx_admin;
