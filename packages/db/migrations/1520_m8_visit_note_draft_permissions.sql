-- compat: expand
-- ADR-0114 (visit-note drafting, M8) - the permission key `encounter.draft_policy_admin`, mirrored into the DB catalog (the 1515 shape),
-- and its default grants. Idempotent.
--   encounter.draft_policy_admin   switches the tenant's visit-note draft (and its sign gate) on or off (route behind step-up)
-- The same owners as `encounter.closure_policy_admin` (1515): the DON keys (director_of_nursing, don) AND the tenant administrators
-- (org_admin, administrator), wherever a tenant has ALREADY created the role. NOT clinical_supervisor or clinical_lead: the switch is the
-- tenant-level owners', not the field supervisors'. The closure policy has no separate read key (its GET rides the admin key), so neither
-- does this one.
-- Single source: DRAFT_POLICY_ADMIN_PERMISSION_KEY and DRAFT_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS in packages/auth/src/roles/visit-note-draft-grants.ts
-- (pinned by apps/backend/__tests__/visit-note-draft-grants.test.ts). A tenant provisioned after this migration gets the key from the
-- ROLE_TEMPLATES materializer (the director_of_nursing template carries it; org_admin / administrator derive it from the full catalog).
-- The key carries no ABAC default (`none`): the route composes step-up itself.

INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('encounter.draft_policy_admin', 'encounter', 'draft_policy_admin', 'compliance', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'encounter.draft_policy_admin'
  FROM "role" r
 WHERE r."key" IN ('director_of_nursing', 'don', 'org_admin', 'administrator')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
