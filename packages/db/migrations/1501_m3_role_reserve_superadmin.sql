-- compat: contract
-- `superadmin` is platform authority too: the platform-owned role that reads as administrator + org_admin + every
-- platform role (packages/auth/src/roles/platform-reserved.ts, expandSuperadminRoles) and is granted the permission
-- catalog less the keys withheld from the admin roles (packages/auth/src/rbac/superadmin-permissions.ts).
-- The code-side rule (RESERVED_PLATFORM_ROLE_KEYS) already refuses a tenant row with that key at create and
-- ignores it at read; this widens 0318/0321's backstop to match, so a tenant admin cannot mint the one role that
-- would satisfy every platform predicate at once. Widening a CHECK is DROP + ADD, hence `contract`.
-- NOT VALID for the same reason as 0318/0321: a pre-existing tenant row named `superadmin` is ignored by the
-- reader (roleConfersKey), and every INSERT/UPDATE from here on is checked.
ALTER TABLE "role" DROP CONSTRAINT IF EXISTS "role_platform_authority_platform_owned";--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_platform_authority_platform_owned"
  CHECK ("organization_id" IS NULL
    OR ("key" NOT LIKE 'platform\_%' AND "key" NOT IN ('ai_safety_owner', 'superadmin')
        AND "category" <> 'platform_staff')) NOT VALID;--> statement-breakpoint
-- A tenant that already made a custom role called `superadmin` loses everything that role granted, silently,
-- because the reader now drops it. Say so at apply time instead of leaving it to be found by a user.
DO $$
DECLARE
  tenant_rows integer;
BEGIN
  SELECT count(*) INTO tenant_rows FROM "role" WHERE "organization_id" IS NOT NULL AND "key" = 'superadmin';
  IF tenant_rows > 0 THEN
    RAISE WARNING '% tenant-owned role row(s) are keyed superadmin and confer nothing from now on (superadmin is platform authority); a role key cannot be edited, so delete them', tenant_rows;
  END IF;
END $$;--> statement-breakpoint
-- The binding backstop. The CHECK above constrains `role` rows, but nothing constrained WHERE the platform-owned
-- superadmin row may be bound: a membership in a tenant would carry the whole catalog with no consented support
-- session in front of that tenant's PHI. An organization with a tenant_account is a tenant; ChartWarden's own
-- platform organization has none. The tenant_account table is read only once the role is the platform-owned
-- superadmin, so every other role assignment (including the app role's) never touches it.
--   * SECURITY DEFINER with a pinned search_path, like the M4 audit functions: `tenant_account`, `role` and
--     `membership` are RLS-protected, and an invoker that sees no row would fail open silently.
--   * It tests the MEMBERSHIP's organization as well as the row's: `membership_role` has no composite FK tying
--     the two together, so (platform org, tenant member, superadmin) would otherwise pass.
--   * ENABLE ALWAYS: the seeds run with session_replication_role = replica, which skips an ordinary trigger.
CREATE OR REPLACE FUNCTION membership_role_superadmin_platform_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "role" r
     WHERE r."id" = NEW."role_id" AND r."organization_id" IS NULL AND r."key" = 'superadmin'
  ) THEN
    -- Serialise with tenant_account_no_superadmin below: under READ COMMITTED a binding and a tenant_account
    -- inserted at the same instant would each pass their own check, neither seeing the other's uncommitted row.
    -- SHARE here conflicts with that trigger's NO KEY UPDATE, so whichever commits second re-reads the first.
    PERFORM 1 FROM "organization" o
     WHERE o."id" IN (
       NEW."organization_id",
       (SELECT m."organization_id" FROM "membership" m WHERE m."id" = NEW."membership_id")
     ) FOR SHARE;
    IF EXISTS (
      SELECT 1 FROM "tenant_account" t
       WHERE t."organization_id" IN (
         NEW."organization_id",
         (SELECT m."organization_id" FROM "membership" m WHERE m."id" = NEW."membership_id")
       )
    ) THEN
      RAISE EXCEPTION 'superadmin belongs to the ChartWarden platform org, not a tenant (organization %)', NEW."organization_id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "membership_role_superadmin_platform_only" ON "membership_role";--> statement-breakpoint
CREATE TRIGGER "membership_role_superadmin_platform_only"
  BEFORE INSERT OR UPDATE ON "membership_role"
  FOR EACH ROW EXECUTE FUNCTION membership_role_superadmin_platform_only();--> statement-breakpoint
ALTER TABLE "membership_role" ENABLE ALWAYS TRIGGER "membership_role_superadmin_platform_only";--> statement-breakpoint
-- The reverse order. Giving an organization a tenant_account AFTER a superadmin is bound in it would turn the
-- platform org into a tenant with the binding intact. No code path does it (M34 mints a fresh org id), so this is
-- the ad-hoc-SQL backstop, same shape and same ENABLE ALWAYS as above.
CREATE OR REPLACE FUNCTION tenant_account_no_superadmin() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  -- NO KEY UPDATE conflicts with the SHARE lock the binding trigger takes but not with the KEY SHARE every foreign
  -- key insert takes, so ordinary tenant_account writes are unaffected. See membership_role_superadmin_platform_only.
  PERFORM 1 FROM "organization" o WHERE o."id" = NEW."organization_id" FOR NO KEY UPDATE;
  IF EXISTS (
    SELECT 1 FROM "membership_role" mr
      JOIN "role" r ON r."id" = mr."role_id"
     WHERE r."organization_id" IS NULL AND r."key" = 'superadmin'
       AND (mr."organization_id" = NEW."organization_id"
            OR mr."membership_id" IN (SELECT m."id" FROM "membership" m WHERE m."organization_id" = NEW."organization_id"))
  ) THEN
    RAISE EXCEPTION 'organization % holds a superadmin binding and cannot become a tenant', NEW."organization_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "tenant_account_no_superadmin" ON "tenant_account";--> statement-breakpoint
CREATE TRIGGER "tenant_account_no_superadmin"
  BEFORE INSERT OR UPDATE OF "organization_id" ON "tenant_account"
  FOR EACH ROW EXECUTE FUNCTION tenant_account_no_superadmin();--> statement-breakpoint
ALTER TABLE "tenant_account" ENABLE ALWAYS TRIGGER "tenant_account_no_superadmin";
