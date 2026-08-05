-- M24 Billing — Medicaid (WX-PR-011) — `medicaid_state_plan_code` M4 write-audit trigger. NO organization_id
-- → the M1 null-safe baseline trigger (the wage_index_factor / M38 platform-table precedent), isolated in its
-- own file same as the table/RLS/seed split above.
CREATE TRIGGER "trg_audit_medicaid_state_plan_code" AFTER INSERT OR UPDATE OR DELETE ON medicaid_state_plan_code FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
