-- M24 Billing — Medicaid (WX-PR-011 line-assembly follow-up) — platform seed. DDL-free (INSERT only);
-- idempotent via the unique (state_code, level_of_care, county_code, effective_from) constraint + NOT
-- EXISTS guard (the medicaid_state_plan_code 0177 / wage_index_factor 0080 precedent). Seeds ONE statewide
-- (county_code NULL) rate per hospice level of care for the Phase-1 launch state (Oregon) — TODO(state-
-- fixture): replace with the real OHA-published per-diem rate table (medicaid_platform_loader) once
-- available; these are round placeholder cents, not authoritative payment rates. NF_RB is intentionally
-- absent — see the table's own CHECK / schema-file note (R&B prices off rb_arrangement, never this table).
INSERT INTO "medicaid_state_rate_schedule"
  ("state_code", "level_of_care", "county_code", "rate_cents", "effective_from", "load_source_ref")
SELECT 'OR', v."loc"::"m24_claim_line_loc", NULL, v."rate_cents", '2026-01-01T00:00:00Z'::timestamptz,
       'TODO(state-fixture): OHA-published Oregon Medicaid hospice per-diem rates (representative placeholder, not authoritative)'
FROM (
  VALUES
    ('RHC', 20000),
    ('CHC', 65000),
    ('IRC', 30000),
    ('GIP', 90000)
) AS v("loc", "rate_cents")
WHERE NOT EXISTS (
  SELECT 1 FROM "medicaid_state_rate_schedule" s
  WHERE s."state_code" = 'OR' AND s."level_of_care" = v."loc"::"m24_claim_line_loc" AND s."county_code" IS NULL
);
