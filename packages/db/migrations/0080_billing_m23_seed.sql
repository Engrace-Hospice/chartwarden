-- M23 Billing — Medicare §3.2 (Phase G — platform seed). DDL-free (INSERT only); idempotent via per-row
-- NOT EXISTS guards. Seeds the platform-shared reference data that has no organization (so it can be
-- written at migrate time before any tenant exists). Two of the three §3.2-Phase-G items are NOT seeded
-- here — see the notes below.
--
-- (1) wage_index_factor (D12) — CMS FY2026 hospice wage index. The FULL file is loaded by the platform
--     loader (billing_platform_loader, 0078) at the annual Oct cutover from the CMS source; it is keyed by
--     per-provider CCN, of which none exist at migrate time. We seed a small REPRESENTATIVE fixture so the
--     HIPPS calculator + RLS read-path have data in dev/CI. TODO(cms-fixture): replace with the real
--     CMS FY2026 hospice-wage-index load (packages/billing platform loader) — these placeholder CCN/CBSA
--     rows are NOT authoritative payment rates.
--
-- (2) sequestration_policy (D11) — NOT seeded here. organization_id is NOT NULL (no global org-NULL row),
--     and effective_from is forward-only by CHECK; the platform-default 2% baseline (BCA restoration) is
--     applied PER-PROVIDER-ENTITY at tenant onboarding through a billing_platform_loader SECURITY DEFINER
--     path (the M27 cost_center_mapping precedent: a per-tenant onboarding template, not a platform seed).
--
-- (3) M38 value sets (hospice revenue codes 0651/0652/0655/0656/0657/0659/0294/0942; Q-codes Q5001–Q5010;
--     hospice modifier codes; CARC/RARC) — NOT seeded here. M38 (Terminology) OWNS those value sets and
--     their `value_set` / `value_set_member` rows; M23 consumes them via the TerminologyProvider seam.
--     TODO(m38-valuesets): register `vs.cms-hospice-revenue-codes`, `vs.cms-hospice-q-codes`,
--     `vs.cms-hospice-modifiers`, `vs.carc-rarc` in M38's platform value-set seed — do not duplicate here.

INSERT INTO "wage_index_factor"
  ("ccn", "fiscal_year_starting", "cbsa_code", "factor_decimal", "load_source_ref")
SELECT v."ccn", 2026, v."cbsa_code", v."factor_decimal",
       'TODO(cms-fixture): CMS FY2026 Hospice Wage Index (representative placeholder, not authoritative)'
FROM (
  VALUES
    -- (placeholder CCN, CBSA, wage-index factor) — representative only; replace via the platform loader.
    ('010001', '13820', '0.8123'),
    ('050002', '41860', '1.5487'),
    ('380001', '38900', '1.0342'),
    ('450003', '19100', '0.9678'),
    ('999999',  NULL,    '1.0000')  -- non-CBSA fallback fixture row
) AS v("ccn", "cbsa_code", "factor_decimal")
WHERE NOT EXISTS (
  SELECT 1 FROM "wage_index_factor" w
  WHERE w."ccn" = v."ccn" AND w."fiscal_year_starting" = 2026
);
