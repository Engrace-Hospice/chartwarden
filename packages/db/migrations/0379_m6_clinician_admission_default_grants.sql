-- M6 new admission / readmission — let the nursing, physician, NP and PA roles open admissions, WHEREVER THE TENANT
-- HAS CREATED THEM (nothing materializes `ROLE_TEMPLATES`, so a tenant without these roles gets nothing here and is
-- unchanged — the 0274 / 0316 / 0374 precedent):
--
--   rn, lpn, rn_case_manager, director_of_nursing, md, physician, hospice_physician, medical_director,
--   attending_clinician, np, nurse_practitioner, pa
--     → admission.create, admission.read, billing.eligibility.read
--
-- `admission.create` is `POST /api/v1/admissions` (a brand-new admission or a readmission); `admission.read` backs the
-- benefit-period plan reads; `billing.eligibility.read` backs the HETS benefit-period history panel
-- (`billing.eligibility.check`, a live HETS round-trip, is NOT granted). External roles (`physician_office`, portal,
-- collaborator) are not in the list. WHICH patients a holder may admit is the separate M6
-- `admission_clinical_site_scope` ABAC predicate (the caller's own provider entity / location) — this migration only
-- grants the permissions.
--
-- Idempotent (`ON CONFLICT DO NOTHING`); never removes a grant. The permission mirror rows are inserted too, in case
-- the environment's `permission` table predates `db:sync:permissions` picking the keys up. The single source of truth
-- is `ADMITTING_CLINICIAN_DEFAULT_GRANTS` in packages/auth/src/roles/admitting-clinician-grants.ts —
-- `m6-readmission.live.test.ts` pins this file to it.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('admission.create', 'admission', 'create', 'clinical', 'patient.scope', ''),
  ('admission.read', 'admission', 'read', 'clinical', 'admission.scope', ''),
  ('billing.eligibility.read', 'billing_eligibility', 'read', 'billing', 'caseload_or_scope', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", g."permission_key"
  FROM "role" r
  JOIN (VALUES
    ('rn',                  'admission.create'),
    ('rn',                  'admission.read'),
    ('rn',                  'billing.eligibility.read'),
    ('lpn',                 'admission.create'),
    ('lpn',                 'admission.read'),
    ('lpn',                 'billing.eligibility.read'),
    ('rn_case_manager',     'admission.create'),
    ('rn_case_manager',     'admission.read'),
    ('rn_case_manager',     'billing.eligibility.read'),
    ('director_of_nursing', 'admission.create'),
    ('director_of_nursing', 'admission.read'),
    ('director_of_nursing', 'billing.eligibility.read'),
    ('md',                  'admission.create'),
    ('md',                  'admission.read'),
    ('md',                  'billing.eligibility.read'),
    ('physician',           'admission.create'),
    ('physician',           'admission.read'),
    ('physician',           'billing.eligibility.read'),
    ('hospice_physician',   'admission.create'),
    ('hospice_physician',   'admission.read'),
    ('hospice_physician',   'billing.eligibility.read'),
    ('medical_director',    'admission.create'),
    ('medical_director',    'admission.read'),
    ('medical_director',    'billing.eligibility.read'),
    ('attending_clinician', 'admission.create'),
    ('attending_clinician', 'admission.read'),
    ('attending_clinician', 'billing.eligibility.read'),
    ('np',                  'admission.create'),
    ('np',                  'admission.read'),
    ('np',                  'billing.eligibility.read'),
    ('nurse_practitioner',  'admission.create'),
    ('nurse_practitioner',  'admission.read'),
    ('nurse_practitioner',  'billing.eligibility.read'),
    ('pa',                  'admission.create'),
    ('pa',                  'admission.read'),
    ('pa',                  'billing.eligibility.read')
  ) AS g("role_key", "permission_key") ON g."role_key" = r."key"
 WHERE r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
