-- WP 2.7b C4 (ADR-0058 "Enablement and kill switches" decision 2): who may switch global search on or off for a tenant.
-- Same shape as 1086's `messaging.template.manage`: a catalog row (category admin, no ABAC) and a grant to the two
-- full-catalog admin roles only. The route also demands a fresh step-up (`messaging.global_search.configure`).
-- Nothing is enabled by this migration: the tenant setting stays absent (= OFF) and the platform flag stays unset.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.global_search.manage', 'global_search', 'manage', 'admin', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.global_search.manage'
  FROM "role" r
 WHERE r."key" IN ('administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
