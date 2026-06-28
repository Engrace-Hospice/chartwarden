-- M26 Cap Management §3.2 Phase 8 — seed the PLATFORM-shared cap_period_platform_constant for the current
-- and prior two cap years (D3). These are the CMS-published per-beneficiary aggregate cap dollar amounts
-- (Hospice Wage Index Final Rule); every tenant reads them and snapshots the value into cap_period at open.
--   FY2024 = $33,494.01 (3,349,401 cents) · FY2025 = $34,465.34 (3,446,534 cents)
--   FY2026 = NULL — left unpublished until the CMS FY2026 Final Rule (~July 2026, before the Oct 1 2026 start)
-- inpatient_cap_pct is the platform-floor 0.2000 (20% GIP+IRC rule, 42 CFR §418.302(f)).
--
-- recorded_by is the all-zero platform-system sentinel (logical uuid, no FK — the platform admin re-records
-- on the first live publish/amend via cap.platform_constant.manage). DDL-free (INSERT only). Idempotent:
-- ON CONFLICT (cap_year) DO NOTHING — re-running never clobbers a later platform-admin amendment.

INSERT INTO "cap_period_platform_constant"
  ("cap_year", "aggregate_cap_amount_cents", "inpatient_cap_pct", "source_url", "recorded_by")
VALUES
  ('FY2024', 3349401, 0.2000, 'https://www.cms.gov/medicare/payment/fee-for-service-providers/hospice/hospice-wage-index', '00000000-0000-0000-0000-000000000000'),
  ('FY2025', 3446534, 0.2000, 'https://www.cms.gov/medicare/payment/fee-for-service-providers/hospice/hospice-wage-index', '00000000-0000-0000-0000-000000000000'),
  ('FY2026', NULL,    0.2000, NULL, '00000000-0000-0000-0000-000000000000')
ON CONFLICT ("cap_year") DO NOTHING;
