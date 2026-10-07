-- M6 readmission / new-admission flow — grant the intake roles what the flow needs, WHEREVER THE TENANT HAS CREATED
-- THEM (nothing materializes `ROLE_TEMPLATES`, so a tenant without these roles gets nothing here and is unchanged —
-- the 0274 / 0316 precedent):
--
--   intake_coordinator → admission.read, billing.eligibility.read
--   intake_supervisor  → admission.create, admission.read, billing.eligibility.read
--
-- `billing.eligibility.read` backs the readmission screen's HETS benefit-period history (M23
-- `GET /billing/eligibility/hospice-periods`); `billing.eligibility.check` (forcing a live HETS round-trip) is NOT
-- granted. `admission.read` backs the benefit-period plan reads; `admission.create` follows M6 spec §6.2
-- (intake_supervisor only). Reaching a patient who is not on the caller's caseload is the separate
-- `admission_intake_scope` ABAC predicate — this migration only grants the permissions.
--
-- Idempotent (`ON CONFLICT DO NOTHING`); never removes a grant. The permission mirror rows are inserted too, in case
-- the environment's `permission` table predates `db:sync:permissions` picking the keys up. The single source of truth
-- is `INTAKE_DEFAULT_GRANTS` in packages/auth/src/roles/intake-grants.ts — `m6-readmission.live.test.ts` pins this
-- file to it.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('admission.create', 'admission', 'create', 'clinical', 'patient.scope', ''),
  ('admission.read', 'admission', 'read', 'clinical', 'admission.scope', ''),
  ('billing.eligibility.read', 'billing_eligibility', 'read', 'billing', 'caseload_or_scope', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", g."permission_key"
  FROM "role" r
  JOIN (VALUES
    ('intake_coordinator', 'admission.read'),
    ('intake_coordinator', 'billing.eligibility.read'),
    ('intake_supervisor',  'admission.create'),
    ('intake_supervisor',  'admission.read'),
    ('intake_supervisor',  'billing.eligibility.read')
  ) AS g("role_key", "permission_key") ON g."role_key" = r."key"
 WHERE r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
