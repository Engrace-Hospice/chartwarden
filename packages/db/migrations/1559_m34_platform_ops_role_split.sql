-- 1559: CW-AC-22 - the platform_ops split's database half: default predicates, and the separation-of-duties backstop.
-- compat: expand (re-points the recorded default predicate of seven permission keys and adds a trigger that refuses a conflicting role
-- pair. Nothing is dropped, renamed or narrowed for the previous release: it never reads `permission.default_abac` to decide a request, and
-- it never grants the roles the trigger watches, so it can run against this schema unchanged. deploy.sh applies it like any expand.)
--
-- WHY. `platform_ops` held data entry, the signed-BAA upload, the platform BAA register write, go-live approval and tenant pricing
-- together, so one account could enter a tenant's data, file its BAA and approve its go-live. The checks that stop that compare
-- accounts, never roles. The release that ships this file binds each of the last four powers to a role of its own and admits that
-- role alone (`tenant_platform_baa_steward`, `tenant_platform_go_live_approver`, `tenant_platform_pricing_operator`):
--   platform_baa_steward        tenant_baa_document.upload_platform, platform_tenant_baa.write_platform (+ the register read)
--   platform_go_live_approver   go_live.approve_platform
--   platform_pricing_operator   subscription.onboard_platform
-- Those three roles are platform-owned rows created by `bun run db:platform-role grant` with their template permissions (the keys already
-- exist in `permission`); nothing here creates a role, a table or a column.
--
-- WHAT IS NOT HERE, ON PURPOSE. The four keys stay on an existing `platform_ops` row until an operator removes them. They are inert: every
-- route behind them now also needs a predicate that admits only the new role (a `platform_ops` holder is refused 403 even holding the key),
-- so leaving them costs a console button that answers 403, not an authorization. Removing them is a `contract` change (the previous release
-- gates those routes on `platform_ops` alone), which `deploy.sh` would hold and which would open an outage window for the four duties, so it
-- is a separate step AFTER the roles are granted: docs/runbooks/m34-platform-console-hardening.md, step "Clean up".
--
-- 1. The default predicate recorded on each key's mirror row (the catalog in packages/auth declares the same value).
UPDATE "permission" SET "default_abac" = 'tenant_platform_baa_steward'
 WHERE "key" IN ('tenant_baa_document.upload_platform', 'platform_tenant_baa.write_platform')
   AND "default_abac" IS DISTINCT FROM 'tenant_platform_baa_steward';--> statement-breakpoint

UPDATE "permission" SET "default_abac" = 'tenant_platform_go_live_approver'
 WHERE "key" = 'go_live.approve_platform'
   AND "default_abac" IS DISTINCT FROM 'tenant_platform_go_live_approver';--> statement-breakpoint

UPDATE "permission" SET "default_abac" = 'tenant_platform_pricing_operator'
 WHERE "key" = 'subscription.onboard_platform'
   AND "default_abac" IS DISTINCT FROM 'tenant_platform_pricing_operator';--> statement-breakpoint

UPDATE "permission" SET "default_abac" = 'tenant_platform_onboarding_staff'
 WHERE "key" IN ('onboarding.read_platform', 'platform_tenant_baa.read_platform', 'tenant_clearinghouse.read_platform')
   AND "default_abac" IS DISTINCT FROM 'tenant_platform_onboarding_staff';--> statement-breakpoint

-- 2. The separation-of-duties backstop. The go-live approver is the second party of the two-party go-live, so a trigger on
-- `membership_role` refuses it on any account that holds platform_ops, the BAA steward or the pricing operator (and those roles on an
-- approver's account), across ALL memberships of the user. `db:platform-role grant` checks the same rule first, for a readable error; the
-- trigger is what ad-hoc SQL, a seed and two concurrent grants meet. The pairs mirror PLATFORM_ROLE_CONFLICTS in
-- packages/auth/src/roles/templates.ts, and the live suite pins the two together. `superadmin` stands for every role by design and is
-- outside the rule (ADR-0112). Not watched, and said so: re-pointing a membership at another user (UPDATE membership.user_id) or renaming
-- a platform role (UPDATE role.key) after the fact; neither has a code path, and both are audited by the M4 triggers.
-- The shape is migration 1501's:
--   * SECURITY DEFINER with a pinned search_path that ends in pg_temp (migration 1556's rule, so a temp table cannot shadow `role`, `membership`
--     or `membership_role` and blind the check): `membership`, `membership_role` and `role` are RLS-protected, and an invoker that sees only
--     its own tenant's rows would fail open silently. The function reads other memberships of the same USER, which no tenant scope shows.
--   * ENABLE ALWAYS: the seeds run with session_replication_role = replica, which skips an ordinary trigger.
--   * Only platform-owned role rows (organization_id IS NULL) count: a tenant cannot own a `platform_*` role (0318, 0320).
--   * A grant that has expired does not hold, on either side (the same rule `m34_platform_role_holders` uses).
--   * An advisory transaction lock per user serialises two concurrent grants to one account: under READ COMMITTED each would otherwise
--     pass its own check without seeing the other's uncommitted row.
CREATE OR REPLACE FUNCTION membership_role_platform_duty_conflict() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  new_key text;
  new_user uuid;
  conflicting text[];
  clash text;
BEGIN
  SELECT r."key" INTO new_key FROM "role" r WHERE r."id" = NEW."role_id" AND r."organization_id" IS NULL;
  IF new_key = 'platform_go_live_approver' THEN
    conflicting := ARRAY['platform_ops', 'platform_baa_steward', 'platform_pricing_operator'];
  ELSIF new_key IN ('platform_ops', 'platform_baa_steward', 'platform_pricing_operator') THEN
    conflicting := ARRAY['platform_go_live_approver'];
  ELSE
    RETURN NEW;
  END IF;
  IF NEW."expires_at" IS NOT NULL AND NEW."expires_at" <= now() THEN
    RETURN NEW;
  END IF;
  SELECT m."user_id" INTO new_user FROM "membership" m WHERE m."id" = NEW."membership_id";
  IF new_user IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('platform_duty_conflict:' || new_user::text, 0));
  SELECT r2."key" INTO clash
    FROM "membership_role" mr
    JOIN "membership" m2 ON m2."id" = mr."membership_id"
    JOIN "role" r2 ON r2."id" = mr."role_id"
   WHERE m2."user_id" = new_user
     AND r2."organization_id" IS NULL
     AND r2."key" = ANY (conflicting)
     AND mr."id" IS DISTINCT FROM NEW."id"
     AND (mr."expires_at" IS NULL OR mr."expires_at" > now())
   LIMIT 1;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'platform roles % and % may not share one account (separation of duties, CW-AC-22)', new_key, clash
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE OR REPLACE TRIGGER "membership_role_platform_duty_conflict"
  BEFORE INSERT OR UPDATE ON "membership_role"
  FOR EACH ROW EXECUTE FUNCTION membership_role_platform_duty_conflict();--> statement-breakpoint
ALTER TABLE "membership_role" ENABLE ALWAYS TRIGGER "membership_role_platform_duty_conflict";
