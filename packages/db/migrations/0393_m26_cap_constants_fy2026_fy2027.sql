-- M26 §3.2/D3 (FY2027 workstream E) — publish the CMS per-beneficiary aggregate cap for FY2026 and FY2027.
--
-- 0091 seeded FY2026 as NULL ("left unpublished until the CMS FY2026 Final Rule"), so every FY2026
-- `POST /cap/periods` failed CAP_AMOUNT_UNPUBLISHED. Both amounts are now published:
--
--   FY2026 = $35,361.44 (3,536,144 cents) — FY2026 Hospice Wage Index and Payment Rate Update final rule,
--            CMS-1835-F, 90 FR 37404 (published 2025-08-05, FR Doc 2025-14782): "The hospice cap amount for
--            FY 2026 is $35,361.44 (FY 2025 cap amount of $34,465.34 increased by the FY 2026 hospice
--            payment update percentage of 2.6%)" (CMS fact sheet, 2025-08-01).
--   FY2027 = $36,174.75 (3,617,475 cents) — FY2027 Hospice Wage Index and Payment Rate Update final rule,
--            CMS-1851-F, 91 FR 49118 (published 2026-08-03, FR Doc 2026-15686): the FY2026 cap × 1.023 (the
--            2.3% FY2027 update). The 2026-09-30 correction (CMS-1851-CN, 91 FR 61791) did NOT change the cap.
--            See docs/research/FY2027_HOSPICE_COP_RESEARCH.md §6.
--
-- WRITER PATTERN: 0091's DDL-free INSERT ... ON CONFLICT, with the D3 guard spelled out. A value is written
-- ONLY where the row is still unpublished (amount NULL) AND not yet in tenant use (`first_tenant_use_at IS
-- NULL`, made real by 0392). It never overwrites a constant a platform admin already published through
-- `cap.platform_constant.manage`, and never one any tenant has snapshotted — those stay exactly as they are
-- (a platform admin amends through the 0189 function, which carries the same guard). Idempotent.
-- recorded_by is the all-zero platform-system sentinel (0091's convention).

-- FY2026: fill the 0091 NULL placeholder (or create the row if a database never ran 0091's seed row).
UPDATE "cap_period_platform_constant"
SET "aggregate_cap_amount_cents" = 3536144,
    "source_url" = 'https://www.federalregister.gov/d/2025-14782',
    "source_published_at" = '2025-08-05T00:00:00Z',
    "recorded_by" = '00000000-0000-0000-0000-000000000000',
    "recorded_at" = now()
WHERE "cap_year" = 'FY2026'
  AND "aggregate_cap_amount_cents" IS NULL
  AND "first_tenant_use_at" IS NULL;--> statement-breakpoint

INSERT INTO "cap_period_platform_constant"
  ("cap_year", "aggregate_cap_amount_cents", "inpatient_cap_pct", "source_url", "source_published_at", "recorded_by")
VALUES
  ('FY2026', 3536144, 0.2000, 'https://www.federalregister.gov/d/2025-14782', '2025-08-05T00:00:00Z',
   '00000000-0000-0000-0000-000000000000')
ON CONFLICT ("cap_year") DO NOTHING;--> statement-breakpoint

-- FY2027: new row; if a placeholder row already exists, fill it only while it is unpublished and unused.
INSERT INTO "cap_period_platform_constant"
  ("cap_year", "aggregate_cap_amount_cents", "inpatient_cap_pct", "source_url", "source_published_at", "recorded_by")
VALUES
  ('FY2027', 3617475, 0.2000, 'https://www.federalregister.gov/d/2026-15686', '2026-08-03T00:00:00Z',
   '00000000-0000-0000-0000-000000000000')
ON CONFLICT ("cap_year") DO UPDATE
SET "aggregate_cap_amount_cents" = EXCLUDED."aggregate_cap_amount_cents",
    "source_url" = EXCLUDED."source_url",
    "source_published_at" = EXCLUDED."source_published_at",
    "recorded_by" = EXCLUDED."recorded_by",
    "recorded_at" = now()
WHERE "cap_period_platform_constant"."aggregate_cap_amount_cents" IS NULL
  AND "cap_period_platform_constant"."first_tenant_use_at" IS NULL;
