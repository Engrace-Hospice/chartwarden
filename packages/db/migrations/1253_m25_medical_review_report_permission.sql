-- M25 milestone 9a-2 (hospice ADR/TPE/QIC PRD, milestone 9) - the leadership medical-review report. One permission; no table,
-- no column, no flag row (the 1170 shape). The figures are computed live from M25's own tables by the caller's session
-- (FORCE RLS), so the three-column rule, RLS, manifest ownership and enum mirrors have nothing new to cover.
--   medical_review.report.read: read the AGGREGATE medical-review report (ADR, denial, appeal, reopening, TPE, audit and
--   playbook-coverage figures over a date range). Counts, rates and medians only: no patient, person or claim field, and no
--   target, benchmark or threshold other than a TPE exit threshold the organization itself recorded.
-- Granted to compliance_officer, administrator and org_admin by role key, and to every role that already holds appeal.decide
-- (the billing-lead decision key, as in 1119 and 1252). Existing tenants get it here; new tenants from templates.ts
-- (administrator / org_admin through the catalog, compliance_officer explicitly). Idempotent.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('medical_review.report.read', 'medical_review_report', 'read', 'billing', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'medical_review.report.read'
  FROM "role" r
 WHERE r."key" IN ('compliance_officer', 'administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", 'medical_review.report.read'
  FROM "role_permission" rp
 WHERE rp."permission_key" = 'appeal.decide'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
