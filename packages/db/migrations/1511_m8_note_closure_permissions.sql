-- compat: expand
-- ADR-0113 (visit-note closure clock, M8) - the two permission keys, mirrored into the DB catalog (the 0600 / 1329 shape), and their
-- default grants. Idempotent.
--   encounter.closure_override       a supervisor lifts the closure BLOCK for one clinician for up to 24 hours (route behind step-up)
--   encounter.closure_policy_admin   sets the tenant's closure mode (off | warn | block) and threshold hours
-- Grants (the 0379 / 1103 pattern: wherever a tenant has ALREADY created the role): the four supervisor role keys. Single source:
-- NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS in packages/auth/src/roles/note-closure-grants.ts (pinned by
-- apps/backend/__tests__/note-closure-grants.test.ts). A tenant provisioned after this migration gets the keys from the
-- ROLE_TEMPLATES materializer instead (GAP-006): the director_of_nursing template carries NOTE_CLOSURE_DEFAULT_GRANTS, the only
-- one of the four that is a template. NEVER org_admin / administrator (both keys are in FULL_CATALOG_EXCLUDED_KEYS), aides,
-- volunteers or compliance roles; a tenant tightens by removing the grant from a role it owns. Both keys carry no ABAC default (`none`): the route composes step-up
-- (override) and the caller's own site scope (board) itself.

INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('encounter.closure_override', 'encounter', 'closure_override', 'compliance', 'none', ''),
  ('encounter.closure_policy_admin', 'encounter', 'closure_policy_admin', 'compliance', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", k."key"
  FROM "role" r
 CROSS JOIN (VALUES ('encounter.closure_override'), ('encounter.closure_policy_admin')) AS k("key")
 WHERE r."key" IN ('clinical_supervisor', 'director_of_nursing', 'don', 'clinical_lead')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
