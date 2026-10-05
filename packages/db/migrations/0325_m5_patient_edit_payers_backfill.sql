-- GAP-017 — `POST /api/v1/patients/:id/payers` now checks `patient.edit_payers` (the narrower key the M5 spec
-- names) instead of `patient.edit`. Nothing in the code catalog or the seeds grants `patient.edit` to a role
-- by default (the dev seeds sweep whole permission categories; `ROLE_TEMPLATES` is never materialized into
-- tenant rows), so a tenant that edits payers does so through a role it configured itself with
-- `patient.edit`. Without this backfill every such role would start returning 403 on the payer write.
--
-- Copy the grant: every TENANT role that holds `patient.edit` also gets `patient.edit_payers`.
--   * Idempotent (`ON CONFLICT DO NOTHING`); never removes or narrows a grant.
--   * Tenant roles only (`organization_id IS NOT NULL`): a platform template is not a tenant grant.
--   * The `permission` mirror row is inserted first — `role_permission.permission_key` REFERENCES it — with
--     the same values `db:sync:permissions` writes from `packages/auth/src/permissions/contributed.ts`
--     (that sync is an upsert, so it will simply refresh the row).
-- Roles created AFTER this migration are not touched: an admin who builds a new role grants the key
-- deliberately, which is the point of the narrower permission.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description")
VALUES ('patient.edit_payers', 'patient', 'edit_payers', 'clinical', 'caseload_or_scope', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", 'patient.edit_payers'
  FROM "role_permission" rp
 WHERE rp."permission_key" = 'patient.edit'
   AND rp."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
