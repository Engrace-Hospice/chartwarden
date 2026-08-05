-- M24 Billing — Medicaid (WX-PR-011 line-assembly follow-up) — `medicaid_state_rate_schedule`
-- PLATFORM-SHARED RLS & grants. ISOLATED file (the medicaid_state_plan_code 0175 / wage_index_factor 0078
-- precedent). Reuses the SAME `medicaid_platform_loader` role 0175 already created — one loader role owns
-- every M24 platform-reference table's writes, not a new role per table.
ALTER TABLE "medicaid_state_rate_schedule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medicaid_state_rate_schedule_read_all" ON "medicaid_state_rate_schedule"
  FOR SELECT TO wardenx_app
  USING (true);--> statement-breakpoint
CREATE POLICY "medicaid_state_rate_schedule_write_platform_only" ON "medicaid_state_rate_schedule"
  FOR ALL TO medicaid_platform_loader
  USING (true)
  WITH CHECK (true);--> statement-breakpoint
GRANT SELECT ON "medicaid_state_rate_schedule" TO wardenx_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "medicaid_state_rate_schedule" FROM wardenx_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "medicaid_state_rate_schedule" TO medicaid_platform_loader;--> statement-breakpoint
GRANT ALL ON "medicaid_state_rate_schedule" TO wardenx_admin;
