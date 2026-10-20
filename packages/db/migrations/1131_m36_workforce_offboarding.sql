-- M36 WP 5.9 (ADR-0084, PROPOSED) - workforce offboarding. One permission; no table, no column.
--   messaging.offboarding.manage: lets a security officer preview and run the offboarding of a departed user in the organisation (the execute
--   route also demands a fresh step-up and the supervisor-reassign keys). Granted to the two full-catalog admin roles only, exactly like
--   messaging.sessions.manage (1130); the tenant's security-officer role is named by SEC (ADR-0083 / ADR-0084 open question).
-- Nothing else is stored: an offboarding run is derived from the live rows and recorded as an audit row (ids and counts), so no run table is
-- added (the three-column rule, RLS, manifest and enum mirrors have nothing new to cover).
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.offboarding.manage', 'workforce_offboarding', 'manage', 'admin', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.offboarding.manage'
  FROM "role" r
 WHERE r."key" IN ('administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
