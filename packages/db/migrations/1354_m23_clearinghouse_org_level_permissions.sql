-- compat: expand
-- M23 - the tenant's own clearinghouse surface gets its OWN org-level permission pair (ADR-0053 amendment 2026-11-06, owner
-- decision D3): billing.clearinghouse.read / billing.clearinghouse.admin. Until now the draft routes reused the
-- provider-entity-scoped billing.mac_credential.* keys, so a billing manager scoped to ONE provider entity could have re-routed
-- EVERY entity's claims (PHI) to another vendor. The new keys are bound to the org-wide admin roles ONLY (org_admin and
-- administrator, by role key, as 1253 does): no other role gets them here, and the role-template planner gives them to no other
-- role either (the two full-catalog roles take every non-platform key; every other template lists its grants explicitly).
-- A tenant that wants a custom role to hold them grants them deliberately. Existing tenants get the grant here; new tenants
-- from packages/auth/src/roles/templates.ts. No table, no column, no policy. Idempotent.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('billing.clearinghouse.read', 'billing_clearinghouse', 'read', 'billing', 'none', ''),
  ('billing.clearinghouse.admin', 'billing_clearinghouse', 'admin', 'billing', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", k."key"
  FROM "role" r
 CROSS JOIN (VALUES ('billing.clearinghouse.read'), ('billing.clearinghouse.admin')) AS k("key")
 WHERE r."key" IN ('org_admin', 'administrator')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
