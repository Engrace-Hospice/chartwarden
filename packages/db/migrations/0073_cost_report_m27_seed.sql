-- M27 Cost Report §3.2 (phase 7 — seed data) / §1.1 — the platform-default validation-rule library.
-- Seeds the 25 platform-default `cost_report_validation_rule` rows (§1.1, architecture §11.B,
-- M27-F01/F02) PLUS the 4 additive NGS-J6 MAC-profile rows (D16, §7.8) as PLATFORM DEFAULTS:
-- organization_id = NULL, rule_set_version = 1. These are the org-NULL platform floor every tenant reads
-- (0071 platform-read policy) and layers tenant tightenings onto (D21); the `regulatory_required` rows
-- (42 CFR §413.24 adequate-cost-data, §418.308 aggregate cap, §418.309 inpatient cap, PRM I Ch 3&4
-- bad-debt, §413.24(f) filing deadline) are the floor a tenant cannot disable and whose failure is
-- BLOCKING (M27-F08). No PHI (D18).
--
-- predicate_spec is the {"ruleCode": "..."} descriptor: the rule-engine maps ruleCode → the code-side
-- `evaluate` predicate (packages/cost-report/src/validation/default-rules.ts + mac-profiles/ngs-j6.ts).
-- The predicate body lives in code (deterministic pure functions, D8), not in the row — the row carries
-- the catalog metadata (category/severity/regulatory_required/mac_jurisdiction_scope) + this pointer.
--
-- category / severity / status / mac_jurisdiction_scope mirror the RuleDef catalog exactly. status
-- defaults to 'active' (the rows are live platform defaults).
--
-- NOTE — cost_center_mapping is NOT seeded here. Its organization_id is NOT NULL: the ~70 Xero-hospice
-- chart-of-accounts default mappings (§3.2 phase 7, D5) are a PER-TENANT onboarding template applied at
-- tenant setup (versioned per (provider_entity_id, fiscal_year_int)), not a global platform-NULL seed —
-- so it lands in the M27 onboarding flow, not this migration.
--
-- DDL-free (INSERT only). Idempotent on re-run: organization_id IS NULL means the
-- uniq_rule_org_code_version UNIQUE constraint does NOT dedupe (NULLs are distinct under SQL UNIQUE), so
-- ON CONFLICT cannot guard us here — instead the INSERT ... SELECT is guarded by a per-row NOT EXISTS
-- against the existing platform-default (org-NULL) row for the same (rule_code, rule_set_version).

INSERT INTO "cost_report_validation_rule"
  ("organization_id", "rule_code", "category", "description", "rule_set_version",
   "regulatory_required", "severity", "status", "mac_jurisdiction_scope", "predicate_spec")
SELECT
  NULL::uuid,
  v."rule_code",
  v."category"::"m27_rule_category",
  v."description",
  1,
  v."regulatory_required",
  v."severity"::"m27_rule_severity",
  'active'::"m27_rule_status",
  v."mac_jurisdiction_scope",
  jsonb_build_object('ruleCode', v."rule_code")
FROM (
  VALUES
    -- ── demographics_ownership (3) ──────────────────────────────────────────────────────────────────
    ('demographics.ccn_present', 'demographics_ownership', 'block', false, 'all',
      'The provider CCN is present — a cost report cannot be filed for a CCN-less provider.'),
    ('demographics.fiscal_year_configured', 'demographics_ownership', 'block', false, 'all',
      'The fiscal-year-end date is configured (defaults to provider_entity.fiscal_year_end_month_day).'),
    ('ownership.related_party_disclosed', 'demographics_ownership', 'warn', false, 'all',
      'Related-party / ownership disclosures (Worksheet A-8 reclass, S-2) are present when applicable.'),
    -- ── statistical_data (2) ────────────────────────────────────────────────────────────────────────
    ('stats.census_nonnegative', 'statistical_data', 'block', false, 'all',
      'No month×level-of-care census cell is negative (a data-integrity defect).'),
    ('stats.patient_days_reconcile', 'statistical_data', 'warn', false, 'all',
      'Service census (M6) reconciles to billed-and-accepted census (M23) within the expected delta.'),
    -- ── trial_balance (2) ───────────────────────────────────────────────────────────────────────────
    ('tb.no_orphan_accounts', 'trial_balance', 'block', true, 'all',
      'Every trial-balance GL account is mapped to a CMS-1984-14 cost center (no orphan accounts).'),
    ('tb.debits_equal_credits', 'trial_balance', 'block', false, 'all',
      'The imported trial balance is in balance (total debits equal total credits, to the cent).'),
    -- ── reclassifications (1) ───────────────────────────────────────────────────────────────────────
    ('reclass.net_zero', 'reclassifications', 'block', false, 'all',
      'Worksheet A-6 reclassifications net to exactly zero cents (a reclass moves cost, never creates it).'),
    -- ── adjustments (1) ─────────────────────────────────────────────────────────────────────────────
    ('adjustments.a8_supported', 'adjustments', 'warn', false, 'all',
      'Every Worksheet A-8 adjustment to costs has a documented basis.'),
    -- ── cost_allocation (2) ─────────────────────────────────────────────────────────────────────────
    ('alloc.statistical_basis_present', 'cost_allocation', 'block', false, 'all',
      'The cost-allocation statistical basis (sq-ft, FTE, accumulated cost, etc.) is present for the step-down.'),
    ('alloc.b_ties_to_a', 'cost_allocation', 'block', false, 'all',
      'Worksheet B total allocated cost ties back to Worksheet A total cost (step-down conserves cost).'),
    -- ── apportionment_programs (1) — Worksheet C per-diem (§4330) ────────────────────────────────────
    ('perdiem.c_ties_to_b', 'apportionment_programs', 'block', false, 'all',
      'Worksheet C per-diem cost ties to Worksheet B (Σ level-of-care cost equals the B total).'),
    -- ── balance_sheet (1) — Worksheet F (§4350) ─────────────────────────────────────────────────────
    ('balance_sheet.f_balances', 'balance_sheet', 'warn', false, 'all',
      'Worksheet F balance sheet is present and balances (assets = liabilities + fund balance).'),
    -- ── cap (3) — SKIP under the D13 cap-seam deny-stub until M26 binds ──────────────────────────────
    ('cap.aggregate_beneficiary_cap', 'cap', 'block', true, 'all',
      'The aggregate per-beneficiary cap is computed from M26 cap accruals.'),
    ('cap.aggregate_payments_within_cap', 'cap', 'block', true, 'all',
      'Total Medicare hospice payments do not exceed the aggregate per-beneficiary cap.'),
    ('cap.inpatient_20_pct', 'cap', 'block', true, 'all',
      'Inpatient (GIP + IRC) days do not exceed 20% of total Medicare days in the cap year.'),
    -- ── bad_debt (2) ────────────────────────────────────────────────────────────────────────────────
    ('bad_debt.entry_collection_efforts_documented', 'bad_debt', 'block', true, 'all',
      'When bad debt is claimed, every entry has documented reasonable collection efforts.'),
    ('bad_debt.kind_classified', 'bad_debt', 'warn', false, 'all',
      'When bad debt is claimed, every entry is classified as deductible or coinsurance.'),
    -- ── cross_worksheet (3) ─────────────────────────────────────────────────────────────────────────
    ('cross.a_grandtotal_ties_b', 'cross_worksheet', 'block', false, 'all',
      'Worksheet A grand-total cost equals the Worksheet B total allocated cost (to the cent).'),
    ('drug_cost.billed_reconciles', 'cross_worksheet', 'warn', false, 'all',
      'The billed drug-cost basis (M12) reconciles to the Worksheet-A pharmacy cost center within the expected delta.'),
    -- ── mac_specific (1) — generic platform default; NGS-J6 additive rules below ─────────────────────
    ('mac.supporting_docs_present', 'mac_specific', 'info', false, 'all',
      'The MAC-required supporting documentation set (S-2 attachments) is present.'),
    -- ── supporting_docs (2) ─────────────────────────────────────────────────────────────────────────
    ('docs.s2_attachments_present', 'supporting_docs', 'warn', false, 'all',
      'Worksheet S-2 required supporting attachments are present.'),
    ('docs.bad_debt_docs_attached', 'supporting_docs', 'warn', false, 'all',
      'When bad debt is claimed, every entry has at least one supporting document reference.'),
    -- ── filing_deadline (2) ─────────────────────────────────────────────────────────────────────────
    ('deadline.not_past_without_override', 'filing_deadline', 'block', true, 'all',
      'The filing deadline has not passed without an explicit past-deadline override.'),
    ('deadline.window_open', 'filing_deadline', 'warn', false, 'all',
      'The filing window is open (advisory — surfaces the closing-window cadence on the worklist).'),
    -- ── NGS-J6 additive MAC profile (4, D16, §7.8) — scoped 'NGS-J6' only ────────────────────────────
    ('mac.ngs_j6.s2_ownership_attestation', 'mac_specific', 'warn', false, 'NGS-J6',
      'NGS-J6: Worksheet S-2 ownership/related-party attestation is present (NGS reviews this closely).'),
    ('mac.ngs_j6.supporting_schedules_present', 'supporting_docs', 'warn', false, 'NGS-J6',
      'NGS-J6: the supporting schedule attachments NGS requires for hospice cost reports are present.'),
    ('mac.ngs_j6.statistical_basis_present', 'statistical_data', 'warn', false, 'NGS-J6',
      'NGS-J6: the statistical basis NGS expects for the cost-allocation step-down is present.'),
    ('mac.ngs_j6.cap_position_reviewed', 'cap', 'info', false, 'NGS-J6',
      'NGS-J6: the aggregate-cap position is available for NGS settlement review.')
) AS v("rule_code", "category", "severity", "regulatory_required", "mac_jurisdiction_scope", "description")
WHERE NOT EXISTS (
  SELECT 1
  FROM "cost_report_validation_rule" r
  WHERE r."organization_id" IS NULL
    AND r."rule_code" = v."rule_code"
    AND r."rule_set_version" = 1
);
