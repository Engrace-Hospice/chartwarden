-- compat: expand
-- ADR-0107 - the staff signature-request keys (1307 create/read/void, 1308 review) reach the tenant's two full-catalog
-- roles, `administrator` and `org_admin` (FULL_CATALOG_ROLE_KEYS in packages/auth roles/template-materialization.ts).
-- A tenant provisioned from now on already gets them through the non-platform catalog; this backfills the roles that
-- existed before 1307, which otherwise could not open a patient's Signatures tab until someone assigned the keys by
-- hand. Other roles still get them only as an admin assigns them. Idempotent; inserts only.
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", k."key"
  FROM "role" r
  CROSS JOIN (VALUES ('portal.signature_request.create'), ('portal.signature_request.read'),
                     ('portal.signature_request.void'), ('portal.signature_request.review')) AS k("key")
 WHERE r."key" IN ('administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
