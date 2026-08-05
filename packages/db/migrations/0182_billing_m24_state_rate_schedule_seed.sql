-- M24 Billing — Medicaid (WX-PR-011 line-assembly follow-up) — platform seed. DDL-free (INSERT only);
-- idempotent via the unique (state_code, level_of_care, county_code, effective_from) constraint + NOT
-- EXISTS guard (the medicaid_state_plan_code 0177 / wage_index_factor 0080 precedent). Seeds ONE statewide
-- (county_code NULL) rate per hospice level of care for the Phase-1 launch state (Oregon). NF_RB is
-- intentionally absent — see the table's own CHECK / schema-file note (R&B prices off rb_arrangement,
-- never this table).
--
-- REAL RATES (place-of-service/rate-table follow-up, 2026-08-05): these are the CMS FY2026 NATIONAL
-- per-diem base rates (effective 2025-10-01), not round placeholders. Oregon Medicaid's OAR 410-142-0300
-- ("Hospice Reimbursement and Limitations") sets its rate basis to "the methodology used in setting
-- Medicare rates" with a floor of "no lower than the rates used under Part A of Title XVIII... (Medicare)"
-- — so the CMS national base rate is the correct, defensible floor value absent a wage-index layer.
--   RHC $230.83/day (days 1-60; this schema does not model the day-61+ step-down, same simplification as
--     the pre-existing no-HIPPS-day-bucket note in packages/medicaid-adapters/src/line-assembly.ts)
--   CHC $1,674.29 per 24 hours (this schema bills CHC as a whole-day per-diem like RHC/IRC/GIP, not CMS's
--     real hourly-with-8hr-minimum granularity — a separate, larger line-assembly redesign, out of scope)
--   IRC $532.48/day
--   GIP $1,199.86/day
-- Source: CMS FY2026 Hospice Wage Index and Payment Rate Update Final Rule (90 FR 37404, eff. 2025-10-01);
-- corroborated via the CMS fact sheet and HFMA's FY2026 rate-update summary.
--
-- STILL A DOCUMENTED SIMPLIFICATION: these are UNADJUSTED national base rates. Real CMS/Oregon Medicaid
-- payment applies the local wage index to the labor portion of each rate, varying by the CBSA in which
-- care is furnished (RHC/CHC: the beneficiary's location; GIP/IRC: the facility's location) — the same
-- geographic-adjustment layer M23's own `wage_index_factor` table (packages/db/src/schema/billing/
-- wage-index-factor.ts) exists for but has never been seeded with real CMS wage-index data either. Adding
-- full per-CBSA wage-index adjustment to M24 is a separate, larger effort (a real CMS wage-index dataset
-- load, keyed by facility CBSA, mirroring the still-empty M23 precedent) — flagged, not done here.
INSERT INTO "medicaid_state_rate_schedule"
  ("state_code", "level_of_care", "county_code", "rate_cents", "effective_from", "load_source_ref")
SELECT 'OR', v."loc"::"m24_claim_line_loc", NULL, v."rate_cents", '2025-10-01T00:00:00Z'::timestamptz,
       'CMS FY2026 Hospice Wage Index and Payment Rate Update Final Rule (90 FR 37404, eff. 2025-10-01) — national base rate, unadjusted for CBSA wage index (OAR 410-142-0300 floor)'
FROM (
  VALUES
    ('RHC', 23083),
    ('CHC', 167429),
    ('IRC', 53248),
    ('GIP', 119986)
) AS v("loc", "rate_cents")
WHERE NOT EXISTS (
  SELECT 1 FROM "medicaid_state_rate_schedule" s
  WHERE s."state_code" = 'OR' AND s."level_of_care" = v."loc"::"m24_claim_line_loc" AND s."county_code" IS NULL
);
