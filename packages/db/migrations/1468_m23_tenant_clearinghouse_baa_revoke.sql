-- compat: contract
-- M23 / M34 tenant clearinghouse (ADR-0053 amendment; owner decision "build it"): a platform operator may REVOKE the vendor BAA a
-- tenant recorded (the vendor ended it). Until now a BAA verification was a point in time with no way to withdraw it.
--   baa_revoked_at / _by_membership_id / _reason_code / _ticket_ref   all four or none. The record (`baa_*`) stays, so the operator and
--             the tenant can still see which agreement ended; only its verification is voided (a CHECK: a revoked row holds no
--             verification, which also keeps a live config off it: 1417's active_baa_ck needs a verified BAA). The tenant clears a
--             revocation by recording a new BAA, or by changing vendor / switching to `outside` (the service voids the record and the
--             revocation together). NO FREE TEXT is stored: the reason is a closed code (vendor_terminated, account_closed,
--             baa_expired, other) and a ticket reference (`SEC-42`), so no caller-supplied sentence can reach this durable,
--             tenant-readable row or the immutable audit rows copied from it.
--   baa_last_revoked_at / _document_ref   the HISTORY of the last revocation: set by the revoke, never cleared by a re-record or a
--             vendor change, so an operator verifying a new record can tell that the same ended document was revoked before (the
--             service refuses to verify it without an explicit acknowledgement). Platform view only; never shown to the tenant.
--   revoked_vendor_left_at   when the tenant left a revoked vendor (vendor change or `outside`). The vendor / mode lock then counts
--             only production attempts reserved AT OR AFTER it: the revoked vendor's traffic never locks the next config again, the
--             new config's own traffic does (attempt rows carry no vendor, so the departure time is the cut). Not cleared.
-- UPDATE stays column-level (1417): the new columns are added to the grant. INSERT is table-wide already. Which lane may revoke (the
-- platform lane only: service.revokeBaa, behind tenant_clearinghouse.revoke_baa_platform) or clear (the tenant's own writes) is enforced
-- by the service and the routes; the database adds a defence-in-depth guard below (the 1437 pattern): a change to the revocation columns
-- needs a transaction-local setting that only the config store sets, so no other application code path and no stray UPDATE can revoke,
-- clear or rewrite one. It is not a privilege boundary: a session that runs arbitrary SQL as the app role can set the setting itself.
-- The revoke is its own platform duty (the 1419 / 1435 shape): `tenant_clearinghouse.revoke_baa_platform`, platform_ops only, where
-- that role row already exists (a role row created later gets it from `db:platform-role grant`).
-- Declared `contract` by the repo's rule (arch:migration-compat treats ADD CONSTRAINT as contracting, so deploy.sh halts for an
-- operator rather than auto-restoring the previous release after a failed deploy). A previous release still works over it while no BAA
-- is revoked: the columns are nullable and nothing it writes can set them. After a revoke, a previous release is NOT safe: its vendor
-- change voids the BAA record but does not know the revocation columns, so it hits baa_revoked_ck and fails closed (a 500) in a
-- mixed-version window, and its BAA verification would hit baa_revoked_unverified_ck; that refusal is the point, and the reason the
-- migration is `contract`.
ALTER TABLE "tenant_clearinghouse_config" ADD COLUMN IF NOT EXISTS "baa_revoked_at" timestamptz;--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD COLUMN IF NOT EXISTS "baa_revoked_by_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD COLUMN IF NOT EXISTS "baa_revoked_reason_code" text;--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD COLUMN IF NOT EXISTS "baa_revoked_ticket_ref" text;--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD COLUMN IF NOT EXISTS "baa_last_revoked_at" timestamptz;--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD COLUMN IF NOT EXISTS "baa_last_revoked_document_ref" text;--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD COLUMN IF NOT EXISTS "revoked_vendor_left_at" timestamptz;--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" DROP CONSTRAINT IF EXISTS "tenant_clearinghouse_config_baa_revoked_ck";--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD CONSTRAINT "tenant_clearinghouse_config_baa_revoked_ck" CHECK (
  ("baa_revoked_at" IS NULL AND "baa_revoked_by_membership_id" IS NULL AND "baa_revoked_reason_code" IS NULL
     AND "baa_revoked_ticket_ref" IS NULL)
  OR ("baa_revoked_at" IS NOT NULL AND "baa_revoked_by_membership_id" IS NOT NULL AND "baa_revoked_reason_code" IS NOT NULL
      AND "baa_revoked_ticket_ref" IS NOT NULL AND "baa_recorded_at" IS NOT NULL
      AND "baa_revoked_reason_code" IN ('vendor_terminated', 'account_closed', 'baa_expired', 'other')
      AND "baa_revoked_ticket_ref" ~ '^[A-Z][A-Z0-9]{1,9}-[0-9]{1,8}$'));--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" DROP CONSTRAINT IF EXISTS "tenant_clearinghouse_config_baa_revoked_unverified_ck";--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD CONSTRAINT "tenant_clearinghouse_config_baa_revoked_unverified_ck" CHECK (
  "baa_revoked_at" IS NULL OR "baa_verified_at" IS NULL);--> statement-breakpoint
-- the history: both or neither, a real reference, and while a BAA is revoked the history names that very revocation
ALTER TABLE "tenant_clearinghouse_config" DROP CONSTRAINT IF EXISTS "tenant_clearinghouse_config_baa_last_revoked_ck";--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD CONSTRAINT "tenant_clearinghouse_config_baa_last_revoked_ck" CHECK (
  (("baa_last_revoked_at" IS NULL) = ("baa_last_revoked_document_ref" IS NULL))
  AND ("baa_last_revoked_document_ref" IS NULL OR char_length(btrim("baa_last_revoked_document_ref")) BETWEEN 3 AND 200)
  AND ("baa_revoked_at" IS NULL OR "baa_last_revoked_at" = "baa_revoked_at"));--> statement-breakpoint
GRANT UPDATE ("baa_revoked_at", "baa_revoked_by_membership_id", "baa_revoked_reason_code", "baa_revoked_ticket_ref",
  "baa_last_revoked_at", "baa_last_revoked_document_ref", "revoked_vendor_left_at") ON "tenant_clearinghouse_config" TO chartwarden_app;--> statement-breakpoint

-- Defence in depth (the 1437 pattern): the revocation columns change only in a transaction that carries
-- app.clearinghouse_baa_revocation = 'service', which only the config store sets (config-store.ts), and only for a patch that touches
-- one of them. An INSERT may not carry any of them at all (a first choice never does).
CREATE OR REPLACE FUNCTION tenant_clearinghouse_config_revocation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF COALESCE(current_setting('app.clearinghouse_baa_revocation', true), '') = 'service' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.baa_revoked_at IS NOT NULL OR NEW.baa_revoked_by_membership_id IS NOT NULL OR NEW.baa_revoked_reason_code IS NOT NULL
       OR NEW.baa_revoked_ticket_ref IS NOT NULL OR NEW.baa_last_revoked_at IS NOT NULL
       OR NEW.baa_last_revoked_document_ref IS NOT NULL OR NEW.revoked_vendor_left_at IS NOT NULL THEN
      RAISE EXCEPTION 'a clearinghouse BAA revocation is written only by the config service'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF ROW(NEW.baa_revoked_at, NEW.baa_revoked_by_membership_id, NEW.baa_revoked_reason_code, NEW.baa_revoked_ticket_ref,
            NEW.baa_last_revoked_at, NEW.baa_last_revoked_document_ref, NEW.revoked_vendor_left_at)
        IS DISTINCT FROM
        ROW(OLD.baa_revoked_at, OLD.baa_revoked_by_membership_id, OLD.baa_revoked_reason_code, OLD.baa_revoked_ticket_ref,
            OLD.baa_last_revoked_at, OLD.baa_last_revoked_document_ref, OLD.revoked_vendor_left_at) THEN
    RAISE EXCEPTION 'a clearinghouse BAA revocation is written only by the config service'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_clearinghouse_config_revocation_guard" ON tenant_clearinghouse_config;--> statement-breakpoint
CREATE TRIGGER "trg_tenant_clearinghouse_config_revocation_guard" BEFORE INSERT OR UPDATE ON tenant_clearinghouse_config
  FOR EACH ROW EXECUTE FUNCTION tenant_clearinghouse_config_revocation_guard();--> statement-breakpoint

INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('tenant_clearinghouse.revoke_baa_platform', 'tenant_clearinghouse', 'revoke_baa_platform', 'platform', 'tenant_lifecycle_platform_ops', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'tenant_clearinghouse.revoke_baa_platform'
  FROM "role" r
 WHERE r."organization_id" IS NULL
   AND r."key" = 'platform_ops'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
