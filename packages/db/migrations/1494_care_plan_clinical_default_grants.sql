-- compat: expand
-- D-2 (Workflow 06, control CW-AC-44): the default care_plan.* grants for the clinical roles, wherever a tenant has
-- created them. Pinned to CARE_PLAN_DEFAULT_GRANTS (packages/auth/src/roles/care-plan-grants.ts) by
-- packages/auth/__tests__/care-plan-grants.test.ts. Insert-only and idempotent; a role created later is not touched.
-- Not granted: care_plan.bootstrap and care_plan.idg_revise (system paths).
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", g.permission_key
  FROM "role" r
  JOIN (VALUES
    ('rn', 'care_plan.read'),
    ('rn', 'care_plan.read_summary'),
    ('lpn', 'care_plan.read'),
    ('lpn', 'care_plan.read_summary'),
    ('lvn', 'care_plan.read'),
    ('lvn', 'care_plan.read_summary'),
    ('md', 'care_plan.read'),
    ('md', 'care_plan.read_summary'),
    ('physician', 'care_plan.read'),
    ('physician', 'care_plan.read_summary'),
    ('medical_director', 'care_plan.read'),
    ('medical_director', 'care_plan.read_summary'),
    ('medical_director', 'care_plan.sign'),
    ('attending_clinician', 'care_plan.read'),
    ('attending_clinician', 'care_plan.read_summary'),
    ('np', 'care_plan.read'),
    ('np', 'care_plan.read_summary'),
    ('pa', 'care_plan.read'),
    ('pa', 'care_plan.read_summary'),
    ('idg_coordinator', 'care_plan.read'),
    ('idg_coordinator', 'care_plan.read_summary'),
    ('hospice_physician', 'care_plan.read'),
    ('hospice_physician', 'care_plan.read_summary'),
    ('hospice_physician', 'care_plan.sign'),
    ('nurse_practitioner', 'care_plan.read'),
    ('nurse_practitioner', 'care_plan.read_summary'),
    ('nurse_practitioner', 'care_plan.sign'),
    ('msw', 'care_plan.read'),
    ('msw', 'care_plan.read_summary'),
    ('msw', 'care_plan.sign'),
    ('chaplain', 'care_plan.read'),
    ('chaplain', 'care_plan.read_summary'),
    ('chaplain', 'care_plan.sign'),
    ('rn_case_manager', 'care_plan.read'),
    ('rn_case_manager', 'care_plan.read_summary'),
    ('rn_case_manager', 'care_plan.author'),
    ('rn_case_manager', 'care_plan.finalize'),
    ('rn_case_manager', 'care_plan.sign'),
    ('clinical_supervisor', 'care_plan.read'),
    ('clinical_supervisor', 'care_plan.read_summary'),
    ('clinical_supervisor', 'care_plan.author'),
    ('clinical_supervisor', 'care_plan.finalize'),
    ('director_of_nursing', 'care_plan.read'),
    ('director_of_nursing', 'care_plan.read_summary'),
    ('director_of_nursing', 'care_plan.author'),
    ('director_of_nursing', 'care_plan.finalize')
  ) AS g(role_key, permission_key) ON g.role_key = r."key"
 WHERE r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
