-- M24 Billing — Medicaid (WX-PR-011 line-assembly follow-up) — `medicaid_state_rate_schedule` M4
-- write-audit trigger. NO organization_id → the M1 null-safe baseline trigger (the medicaid_state_plan_code
-- 0176 / wage_index_factor precedent).
CREATE TRIGGER "trg_audit_medicaid_state_rate_schedule" AFTER INSERT OR UPDATE OR DELETE ON medicaid_state_rate_schedule FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
