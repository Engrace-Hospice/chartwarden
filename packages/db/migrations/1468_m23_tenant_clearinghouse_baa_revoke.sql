-- compat: contract
-- M23 / M34 tenant clearinghouse (ADR-0053 amendment; owner decision "build it"): a platform operator may REVOKE the vendor BAA a
-- tenant recorded (the vendor ended it). Until now a BAA verification was a point in time with no way to withdraw it.
--   baa_revoked_at / _by_membership_id / _reason   all three or none. The record (`baa_*`) stays, so the operator and the tenant can
--             still see which agreement ended; only its verification is voided (a CHECK: a revoked row holds no verification, which
--             also keeps a live config off it: 1417's active_baa_ck needs a verified BAA). The tenant clears a revocation only by
--             recording a new BAA (the service clears these columns and starts at unverified). The reason is the operator's screened
--             text (3-500 characters; the service screens it for SSN- and MBI-shaped identifiers); the tenant's config view shows
--             only the timestamp and a flag, but the row's M4 write-audit trigger copies the whole row, so the reason is on the
--             tenant's own audit trail like every platform-operator reason (give a ticket reference).
-- UPDATE stays column-level (1417): the three columns are added to the grant. INSERT is table-wide already. Like baa_verified_*, they
-- are written through the app role's column grant, which the tenant and platform lanes share: WHICH lane may revoke (the platform
-- lane only: service.revokeBaa, behind tenant_clearinghouse.revoke_baa_platform) or clear (the tenant's recording a new BAA) is
-- enforced by the service and the routes, not by the database.
-- The revoke is its own platform duty (the 1419 / 1435 shape): `tenant_clearinghouse.revoke_baa_platform`, platform_ops only, where
-- that role row already exists (a role row created later gets it from `db:platform-role grant`).
-- Declared `contract` by the repo's rule (arch:migration-compat treats ADD CONSTRAINT as contracting, so deploy.sh halts for an
-- operator rather than auto-restoring the previous release after a failed deploy), though the previous release still works over it
-- while no BAA is revoked: the columns are nullable and nothing it writes can set them. After a revoke, a previous release that tried
-- to verify the BAA again would hit the CHECK below and fail, which is the refusal this migration exists to make.
ALTER TABLE "tenant_clearinghouse_config" ADD COLUMN IF NOT EXISTS "baa_revoked_at" timestamptz;--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD COLUMN IF NOT EXISTS "baa_revoked_by_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD COLUMN IF NOT EXISTS "baa_revoked_reason" text;--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" DROP CONSTRAINT IF EXISTS "tenant_clearinghouse_config_baa_revoked_ck";--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD CONSTRAINT "tenant_clearinghouse_config_baa_revoked_ck" CHECK (
  ("baa_revoked_at" IS NULL AND "baa_revoked_by_membership_id" IS NULL AND "baa_revoked_reason" IS NULL)
  OR ("baa_revoked_at" IS NOT NULL AND "baa_revoked_by_membership_id" IS NOT NULL AND "baa_revoked_reason" IS NOT NULL
      AND "baa_recorded_at" IS NOT NULL
      AND char_length(btrim("baa_revoked_reason")) BETWEEN 3 AND 500));--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" DROP CONSTRAINT IF EXISTS "tenant_clearinghouse_config_baa_revoked_unverified_ck";--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD CONSTRAINT "tenant_clearinghouse_config_baa_revoked_unverified_ck" CHECK (
  "baa_revoked_at" IS NULL OR "baa_verified_at" IS NULL);--> statement-breakpoint
GRANT UPDATE ("baa_revoked_at", "baa_revoked_by_membership_id", "baa_revoked_reason") ON "tenant_clearinghouse_config" TO chartwarden_app;--> statement-breakpoint

INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('tenant_clearinghouse.revoke_baa_platform', 'tenant_clearinghouse', 'revoke_baa_platform', 'platform', 'tenant_lifecycle_platform_ops', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'tenant_clearinghouse.revoke_baa_platform'
  FROM "role" r
 WHERE r."organization_id" IS NULL
   AND r."key" = 'platform_ops'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
