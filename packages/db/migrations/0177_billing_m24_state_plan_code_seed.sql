-- M24 Billing — Medicaid (WX-PR-011) — platform seed. DDL-free (INSERT only); idempotent via the unique
-- (state_code, plan_code, effective_from) constraint + NOT EXISTS guard (the wage_index_factor 0080
-- precedent). Seeds ONE state-default row for the Phase-1 launch state (Oregon) so claim assembly's
-- state-plan-code lookup has real data in dev/CI/prod immediately at migrate time — TODO(state-fixture):
-- replace with the full OHA-published OHP plan/program list (OHP Plus / OHP Standard / OHP CHIP / Long-Term
-- Care Medicaid, etc.) via the medicaid_platform_loader once per-patient plan differentiation lands (see the
-- Phase-1 simplification note on packages/db/src/schema/medicaid-billing/state-plan-code.ts).
INSERT INTO "medicaid_state_plan_code"
  ("state_code", "plan_code", "plan_name", "is_state_default", "effective_from", "load_source_ref")
SELECT 'OR', 'OHP-PLUS', 'Oregon Health Plan Plus', true, '2026-01-01T00:00:00Z'::timestamptz,
       'TODO(state-fixture): OHA-published OHP plan/program catalog (representative placeholder, not authoritative)'
WHERE NOT EXISTS (
  SELECT 1 FROM "medicaid_state_plan_code" s
  WHERE s."state_code" = 'OR' AND s."plan_code" = 'OHP-PLUS'
);
