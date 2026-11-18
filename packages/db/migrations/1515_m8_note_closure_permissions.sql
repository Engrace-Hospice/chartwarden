-- compat: expand
-- ADR-0113 (visit-note closure clock, M8) - the two permission keys, mirrored into the DB catalog (the 0600 / 1329 shape), and their
-- default grants. Idempotent.
--   encounter.closure_override       a supervisor lifts the closure BLOCK for one clinician for up to 24 hours (route behind step-up)
--   encounter.closure_policy_admin   sets the tenant's closure mode (off | warn | block) and threshold hours
-- Two keys, two owners (ADR-0113 D7); wherever a tenant has ALREADY created the role (the 0379 / 1103 pattern):
--   closure_override       the four supervisor role keys: clinical_supervisor, director_of_nursing, don, clinical_lead.
--   closure_policy_admin   the DON keys (director_of_nursing, don) AND the tenant administrators (org_admin, administrator, the way
--                          1329 / 1429 grant a new catalog key to both). NOT clinical_supervisor or clinical_lead: the policy is set by
--                          the tenant-level owners, not by the field supervisors.
-- DEV DATABASES: this file was edited in place before it was ever released (see the note in 1514). A database that applied an EARLIER
-- copy keeps closure_policy_admin on clinical_supervisor / clinical_lead and lacks it on org_admin / administrator, and
-- `db:sync:permissions` only ADDS grants, so nothing corrects it: reset such a database, or hand-fix those role_permission rows.
-- Single source: NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS, NOTE_CLOSURE_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS and FULL_CATALOG_ROLE_KEYS in
-- packages/auth/src/roles (pinned by apps/backend/__tests__/note-closure-grants.test.ts). A tenant provisioned after this migration
-- gets the keys from the ROLE_TEMPLATES materializer instead (GAP-006): the director_of_nursing template carries both (it is the only
-- supervisor key that is a template) and org_admin / administrator derive closure_policy_admin from the full catalog;
-- closure_override is in FULL_CATALOG_EXCLUDED_KEYS, so an administrator is never a default overrider. NEVER aides, volunteers or
-- compliance roles; a tenant tightens by removing a grant from a role it owns. Both keys carry no ABAC default (`none`): the route
-- composes step-up (override and policy write) and the caller's own site scope (board) itself.

INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('encounter.closure_override', 'encounter', 'closure_override', 'compliance', 'none', ''),
  ('encounter.closure_policy_admin', 'encounter', 'closure_policy_admin', 'compliance', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'encounter.closure_override'
  FROM "role" r
 WHERE r."key" IN ('clinical_supervisor', 'director_of_nursing', 'don', 'clinical_lead')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'encounter.closure_policy_admin'
  FROM "role" r
 WHERE r."key" IN ('director_of_nursing', 'don', 'org_admin', 'administrator')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
