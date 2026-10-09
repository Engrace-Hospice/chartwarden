-- GAP-010 / M5 spec 4.7 — give the SSN permissions an owner. `phi.write_ssn` and `phi.read_ssn` have existed in the
-- permission catalog (0600) since the spec was written, but no role template and no grant migration named either, so
-- the envelope-encrypted SSN path (migration 0800 + the M5 writer) was unreachable for everyone but a wildcard role.
--
--   phi.write_ssn  → intake_supervisor, billing_manager, org_admin, administrator
--   phi.read_ssn   → the same four, plus compliance_officer
--
-- Applied WHEREVER THE TENANT HAS CREATED THE ROLE (nothing materializes these role templates for tenants that do not
-- have them, so a tenant without the role gets nothing here and is unchanged — the 0374 / 0379 precedent). Clinical
-- roles (rn, lpn, np, md, ...) get neither key: minimum necessary, 45 CFR 164.514(d). `billing_finance` is a role
-- CATEGORY, not a role key; `billing_manager` is the M23 billing role. There is no "admissions nurse" role key.
--
-- Idempotent (ON CONFLICT DO NOTHING); never removes a grant. The permission mirror rows are inserted too, in case the
-- environment's `permission` table predates `db:sync:permissions` picking the keys up. The single source of truth is
-- SSN_DEFAULT_GRANTS in packages/auth/src/roles/ssn-grants.ts — `m5-ssn-identifier.live.test.ts` pins this file to it.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('phi.read_ssn', 'phi', 'read_ssn', 'clinical', 'caseload_or_scope', ''),
  ('phi.write_ssn', 'phi', 'write_ssn', 'clinical', 'caseload_or_scope', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", g."permission_key"
  FROM "role" r
  JOIN (VALUES
    ('intake_supervisor',  'phi.write_ssn'),
    ('intake_supervisor',  'phi.read_ssn'),
    ('billing_manager',    'phi.write_ssn'),
    ('billing_manager',    'phi.read_ssn'),
    ('org_admin',          'phi.write_ssn'),
    ('org_admin',          'phi.read_ssn'),
    ('administrator',      'phi.write_ssn'),
    ('administrator',      'phi.read_ssn'),
    ('compliance_officer', 'phi.read_ssn')
  ) AS g("role_key", "permission_key") ON g."role_key" = r."key"
 WHERE r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
