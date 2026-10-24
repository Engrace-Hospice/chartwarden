/**
 * M34 — platform-ops operators are bound into a freshly provisioned tenant org, LIVE Postgres, real NOBYPASSRLS
 * `chartwarden_app`. Before this, `role_set` alerts (stuck activation, oversized export hold) resolved
 * to nobody in a new tenant, because `platform_ops` is bound per membership and the org had none. Proves:
 *   - every operator holding the platform-owned `platform_ops` role gets an ACTIVE membership + binding in the org,
 *     and M36's real `role_set` reader then returns exactly them (a plain tenant user is not an operator);
 *   - the binding is to the platform-owned row (`organization_id IS NULL`), never a tenant-owned copy;
 *   - a re-run is a no-op, and a pre-existing non-active membership (pending, or revoked by a tenant admin) is
 *     never reactivated or resurrected;
 *   - the bound role holds exactly `alert.inbox.self`: an operator reads their OWN in-app alert in the tenant and
 *     cannot read or mark-read another user's, and holds none of the password-reset / deactivate / role / PHI /
 *     messaging keys;
 *   - `reconcilePlatformStaff` binds a missed/late operator, expires the binding of an operator who lost
 *     platform_ops (or was deactivated), re-syncs a returning operator, and never resurrects a revoked membership
 *     or re-adds a role a tenant admin removed; a failed bind is reported to the failure sink.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m34:platform-staff-binding:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbPermissionHolderReader } from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bindPlatformStaffToOrg,
  reconcilePlatformStaff,
  setPlatformStaffFailureSink,
} from "../src/bootstrap/bind-platform-staff";
import { createDrizzleRoleSetMembersReader } from "../src/modules/36-messaging/alert-emitter-drizzle";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const HOME_ORG = "11111111-1111-4111-8111-1111f3400101";
const NEW_ORG = "22222222-2222-4222-8222-2222f3400102";
const OPS_USER = "33333333-3333-4333-8333-3333f3400103";
const OPS_USER_2 = "44444444-4444-4444-8444-4444f3400104";
const PLAIN_USER = "55555555-5555-4555-8555-5555f3400105";
const PENDING_OPS = "66666666-6666-4666-8666-6666f3400106";
const EXPIRY = new Date(Date.now() + 30 * 86_400_000).toISOString();
const DEACTIVATED_OPS = "77777777-7777-4777-8777-7777f3400107";

describe.skipIf(!DB_URL)(
  "M34 platform-staff binding — LIVE Postgres, real chartwarden_app role",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let platformOpsRoleId: string;
    let audienceRoleId: string;

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
      }
      const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        let ddl = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (stripVector)
          ddl = ddl.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
        await admin.query(ddl);
      }
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES
         ($1,'f3401-home','Platform Home LLC','Platform Home','active'),
         ($2,'f3401-new','New Tenant LLC','New Tenant','active')`,
        [HOME_ORG, NEW_ORG],
      );
      await admin.query(
        `INSERT INTO "user" (id,email,name) VALUES
         ($1,'f3401-ops@example.test','Ops One'),($2,'f3401-ops2@example.test','Ops Two'),
         ($3,'f3401-plain@example.test','Plain'),($4,'f3401-pending@example.test','Pending Ops'),
         ($5,'f3401-deact@example.test','Deactivated Ops')`,
        [OPS_USER, OPS_USER_2, PLAIN_USER, PENDING_OPS, DEACTIVATED_OPS],
      );
      const role = await admin.query<{ id: string }>(
        `INSERT INTO role (organization_id, key, name, category, scope_level, enabled, description)
       VALUES (NULL, 'platform_ops', 'Platform Operations', 'platform_staff'::role_category, 'organization', true, 'live test')
       RETURNING id`,
      );
      platformOpsRoleId = role.rows[0]?.id as string;
      // Created by migration 1097 (platform-owned, zero permissions).
      const audience = await admin.query<{ id: string }>(
        `SELECT id FROM role WHERE organization_id IS NULL AND key = 'platform_alert_audience'`,
      );
      audienceRoleId = audience.rows[0]?.id as string;
      // Operators hold platform_ops via a membership in the platform home org; the plain user is a tenant member only.
      for (const userId of [OPS_USER, OPS_USER_2, PENDING_OPS, PLAIN_USER, DEACTIVATED_OPS]) {
        const m = await admin.query<{ id: string }>(
          `INSERT INTO membership (user_id, organization_id, status, accepted_at)
         VALUES ($1,$2,'active',now()) RETURNING id`,
          [userId, HOME_ORG],
        );
        if (userId === PLAIN_USER) continue;
        await admin.query(
          `INSERT INTO membership_role (organization_id, membership_id, role_id, expires_at) VALUES ($1,$2,$3,$4)`,
          [HOME_ORG, m.rows[0]?.id, platformOpsRoleId, userId === OPS_USER_2 ? EXPIRY : null],
        );
      }
      await admin.query(`UPDATE "user" SET status = 'deactivated' WHERE id = $1`, [
        DEACTIVATED_OPS,
      ]);
      // PENDING_OPS already has a NON-active membership in the new org: the binder must not reactivate it.
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'pending')`,
        [PENDING_OPS, NEW_ORG],
      );
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    }, 240_000);

    async function seedInAppAlert(recipient: string): Promise<string> {
      const a = await admin.query<{ id: string }>(
        `INSERT INTO alert (organization_id, event_type, severity, payload, correlation_id)
         VALUES ($1,'m34.tenant_export.oversized_hold','warn','{}',$2) RETURNING id`,
        [NEW_ORG, `f3401-${recipient}`],
      );
      const id = a.rows[0]?.id as string;
      await admin.query(
        `INSERT INTO notification_delivery (alert_id, recipient_user_id, alert_category, alert_severity, channel)
         VALUES ($1,$2,'administrative','warn','in_app')`,
        [id, recipient],
      );
      return id;
    }

    afterAll(async () => {
      await handle?.close();
      await admin?.end();
    });

    it("binds every active operator into the new org, and the real role_set reader resolves exactly them", async () => {
      const result = await bindPlatformStaffToOrg(handle.db, NEW_ORG);

      // PENDING_OPS has a pending membership in the new org: skipped, so two of the three operators are bound.
      expect(result.bound).toBe(2);
      expect(result.skipped).toBe(1);
      const recipients = await createDrizzleRoleSetMembersReader(handle.db)(NEW_ORG, [
        "platform_alert_audience",
      ]);
      expect([...recipients].sort()).toEqual([OPS_USER, OPS_USER_2].sort());
      expect(recipients).not.toContain(PLAIN_USER);
    });

    it("binds the platform-owned role row, never a tenant-owned copy", async () => {
      const { rows } = await admin.query(
        `SELECT r.id, r.organization_id FROM membership_role mr JOIN role r ON r.id = mr.role_id
        WHERE mr.organization_id = $1`,
        [NEW_ORG],
      );

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.organization_id).toBeNull();
        expect(row.id).toBe(audienceRoleId);
        expect(row.id).not.toBe(platformOpsRoleId);
      }
    });

    it("skips globally deactivated operators and copies the home-org grant expiry", async () => {
      const deact = await admin.query(
        `SELECT 1 FROM membership WHERE user_id=$1 AND organization_id=$2`,
        [DEACTIVATED_OPS, NEW_ORG],
      );
      expect(deact.rowCount).toBe(0);
      const exp = await admin.query<{ user_id: string; expires_at: Date | null }>(
        `SELECT m.user_id, mr.expires_at FROM membership_role mr JOIN membership m ON m.id = mr.membership_id
         WHERE mr.organization_id = $1`,
        [NEW_ORG],
      );
      const byUser = new Map(exp.rows.map((r) => [r.user_id, r.expires_at]));
      expect(byUser.get(OPS_USER)).toBeNull();
      expect(new Date(byUser.get(OPS_USER_2) as Date).toISOString()).toBe(EXPIRY);
    });

    it("writes one audit event per binding, and the bound role satisfies no permission key", async () => {
      const ev = await admin.query(
        `SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND event_type='m2.platform_staff.bound'`,
        [NEW_ORG],
      );
      expect(ev.rows[0].n).toBe(2);
      // Neither the role itself nor any key an operator holds in the tenant may satisfy the password-reset /
      // deactivate gates (requirePermission reads role_permission through membership_role).
      const keys = await admin.query<{ permission_key: string }>(
        `SELECT rp.permission_key FROM membership_role mr
           JOIN role_permission rp ON rp.role_id = mr.role_id
          WHERE mr.organization_id = $1`,
        [NEW_ORG],
      );
      expect(keys.rows.map((r) => r.permission_key)).toEqual([
        "alert.inbox.self",
        "alert.inbox.self",
      ]);
      const roleKeys = await admin.query<{ permission_key: string }>(
        `SELECT permission_key FROM role_permission WHERE role_id = $1`,
        [audienceRoleId],
      );
      expect(roleKeys.rows.map((r) => r.permission_key)).toEqual(["alert.inbox.self"]);
    });

    it("the bound operator holds alert.inbox.self and none of the authority keys", async () => {
      const holders = createDbPermissionHolderReader(handle.db);
      expect([...(await holders(NEW_ORG, ["alert.inbox.self"]))].sort()).toEqual(
        [OPS_USER, OPS_USER_2].sort(),
      );
      const authority = [
        "user.password.reset",
        "user.deactivate",
        "user.create",
        "role.assign",
        "member.invite",
        "member.manage",
        "patient.read",
        "messaging.read",
        "messaging.send",
        "messaging.dm",
        "alert.rules.manage",
      ];
      expect(await holders(NEW_ORG, authority)).toEqual([]);
    });

    it("an operator lists and marks read their OWN alert, and cannot read or mark another user's", async () => {
      const mine = await seedInAppAlert(OPS_USER);
      const theirs = await seedInAppAlert(OPS_USER_2);
      const service = createDbMessagingRouteService(handle.db, {});

      const inbox = await service.alertInbox(NEW_ORG, OPS_USER);
      expect(inbox.map((a) => a.alertId)).toEqual([mine]);
      await service.markAlertRead(NEW_ORG, OPS_USER, mine);
      const read = await service.alertInbox(NEW_ORG, OPS_USER);
      expect(read[0]?.readAt).not.toBeNull();

      await expect(service.markAlertRead(NEW_ORG, OPS_USER, theirs)).rejects.toThrow();
      const receipt = await admin.query(
        `SELECT 1 FROM alert_receipt WHERE alert_id = $1 AND recipient_user_id = $2`,
        [theirs, OPS_USER],
      );
      expect(receipt.rowCount).toBe(0);
    });

    it("is idempotent, and never reactivates or resurrects a non-active membership", async () => {
      // A tenant admin revokes operator 2's membership; a retried provision must not bring it back.
      await admin.query(
        "UPDATE membership SET status='revoked', revoked_at=now() WHERE user_id=$1 AND organization_id=$2",
        [OPS_USER_2, NEW_ORG],
      );
      await bindPlatformStaffToOrg(handle.db, NEW_ORG);

      const members = await admin.query(
        "SELECT user_id, status FROM membership WHERE organization_id = $1 ORDER BY user_id",
        [NEW_ORG],
      );
      const byUser = Object.fromEntries(members.rows.map((m) => [m.user_id, m.status]));
      expect(byUser[OPS_USER]).toBe("active");
      expect(byUser[PENDING_OPS]).toBe("pending");
      expect(byUser[OPS_USER_2]).toBe("revoked");
      expect(members.rows.filter((m) => m.user_id === OPS_USER_2)).toHaveLength(1);
      const bindings = await admin.query(
        "SELECT count(*)::int AS n FROM membership_role WHERE organization_id = $1",
        [NEW_ORG],
      );
      expect(bindings.rows[0].n).toBe(2);
    });

    it("does not re-add a role a tenant admin removed from a still-active operator", async () => {
      await admin.query(
        `DELETE FROM membership_role WHERE organization_id = $1 AND membership_id IN
         (SELECT id FROM membership WHERE user_id = $2 AND organization_id = $1)`,
        [NEW_ORG, OPS_USER],
      );
      await bindPlatformStaffToOrg(handle.db, NEW_ORG);

      const bindings = await admin.query(
        `SELECT count(*)::int AS n FROM membership_role mr JOIN membership m ON m.id = mr.membership_id
         WHERE mr.organization_id = $1 AND m.user_id = $2`,
        [NEW_ORG, OPS_USER],
      );
      expect(bindings.rows[0].n).toBe(0);
    });
    describe("reconcilePlatformStaff", () => {
      const ORG3 = "88888888-8888-4888-8888-8888f3400108";
      const roleSet = () =>
        createDrizzleRoleSetMembersReader(handle.db)(ORG3, ["platform_alert_audience"]).then((r) =>
          [...r].sort(),
        );
      const bindingOf = async (userId: string) =>
        (
          await admin.query<{ expires_at: Date | null }>(
            `SELECT mr.expires_at FROM membership_role mr JOIN membership m ON m.id = mr.membership_id
              WHERE mr.organization_id = $1 AND m.user_id = $2 AND mr.role_id = $3`,
            [ORG3, userId, audienceRoleId],
          )
        ).rows[0];

      beforeAll(async () => {
        await admin.query(
          `INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'f3401-org3','Org Three LLC','Org Three','active')`,
          [ORG3],
        );
      });

      it("binds operators a failed/missed provision left out (and not deactivated ones)", async () => {
        const r = await reconcilePlatformStaff(handle.db, [{ organizationId: ORG3 }]);
        expect(r.bound).toBe(3); // OPS_USER, OPS_USER_2, PENDING_OPS (its pending row is in NEW_ORG, not here)
        expect(await roleSet()).toEqual([OPS_USER, OPS_USER_2, PENDING_OPS].sort());
        const again = await reconcilePlatformStaff(handle.db, [{ organizationId: ORG3 }]);
        expect(again).toEqual({ bound: 0, skipped: 0, unbound: 0, refreshed: 0 });
      });

      it("expires only the audience binding of an operator who lost platform_ops, and revives it on re-grant", async () => {
        await admin.query(
          `DELETE FROM membership_role WHERE role_id = $2 AND organization_id = $3 AND membership_id IN
             (SELECT id FROM membership WHERE user_id = $1 AND organization_id = $3)`,
          [OPS_USER, platformOpsRoleId, HOME_ORG],
        );
        const r = await reconcilePlatformStaff(handle.db, [{ organizationId: ORG3 }]);
        expect(r.unbound).toBe(1);
        expect(await roleSet()).toEqual([OPS_USER_2, PENDING_OPS].sort());
        const m = await admin.query(
          `SELECT status FROM membership WHERE user_id=$1 AND organization_id=$2`,
          [OPS_USER, ORG3],
        );
        expect(m.rows).toEqual([{ status: "active" }]); // membership itself untouched
        const ev = await admin.query(
          `SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND event_type='m2.platform_staff.unbound'`,
          [ORG3],
        );
        expect(ev.rows[0].n).toBe(1);
        expect((await reconcilePlatformStaff(handle.db, [{ organizationId: ORG3 }])).unbound).toBe(
          0,
        );

        // The operator is granted platform_ops again: the same binding row is revived, not duplicated.
        const hm = await admin.query<{ id: string }>(
          `SELECT id FROM membership WHERE user_id=$1 AND organization_id=$2`,
          [OPS_USER, HOME_ORG],
        );
        await admin.query(
          `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)`,
          [HOME_ORG, hm.rows[0]?.id, platformOpsRoleId],
        );
        const back = await reconcilePlatformStaff(handle.db, [{ organizationId: ORG3 }]);
        expect(back.refreshed).toBe(1);
        expect(await roleSet()).toEqual([OPS_USER, OPS_USER_2, PENDING_OPS].sort());
        expect((await bindingOf(OPS_USER))?.expires_at).toBeNull();
      });

      it("expires the binding of a globally deactivated operator and re-syncs a changed grant expiry", async () => {
        await admin.query(`UPDATE "user" SET status='deactivated' WHERE id=$1`, [PENDING_OPS]);
        const later = new Date(Date.now() + 90 * 86_400_000);
        await admin.query(
          `UPDATE membership_role SET expires_at = $4 WHERE role_id = $2 AND organization_id = $3 AND membership_id IN
             (SELECT id FROM membership WHERE user_id = $1 AND organization_id = $3)`,
          [OPS_USER_2, platformOpsRoleId, HOME_ORG, later],
        );
        const r = await reconcilePlatformStaff(handle.db, [{ organizationId: ORG3 }]);
        expect(r).toMatchObject({ unbound: 1, refreshed: 1 });
        expect(await roleSet()).toEqual([OPS_USER, OPS_USER_2].sort());
        expect((await bindingOf(OPS_USER_2))?.expires_at?.toISOString()).toBe(later.toISOString());
      });

      it("never resurrects a revoked membership or re-adds a role a tenant admin removed", async () => {
        // State left in NEW_ORG by the earlier tests: OPS_USER_2 revoked, OPS_USER active with its role removed.
        const before = await admin.query(
          `SELECT user_id, status FROM membership WHERE organization_id=$1 ORDER BY user_id`,
          [NEW_ORG],
        );
        await reconcilePlatformStaff(handle.db, [{ organizationId: NEW_ORG }]);
        const after = await admin.query(
          `SELECT user_id, status FROM membership WHERE organization_id=$1 ORDER BY user_id`,
          [NEW_ORG],
        );
        expect(after.rows).toEqual(before.rows);
        const recipients = await createDrizzleRoleSetMembersReader(handle.db)(NEW_ORG, [
          "platform_alert_audience",
        ]);
        expect(recipients).toEqual([]);
        const bindings = await admin.query(
          `SELECT m.user_id FROM membership_role mr JOIN membership m ON m.id = mr.membership_id
            WHERE mr.organization_id = $1 AND mr.role_id = $2`,
          [NEW_ORG, audienceRoleId],
        );
        expect(bindings.rows.map((b) => b.user_id)).toEqual([OPS_USER_2]); // revoked member's row, not revived
      });

      it("reports a failed bind to the failure sink instead of throwing", async () => {
        const seen: Array<{ fields: Record<string, unknown>; message: string }> = [];
        setPlatformStaffFailureSink((fields, message) => seen.push({ fields, message }));
        const r = await bindPlatformStaffToOrg(handle.db, "not-a-uuid");
        expect(r).toEqual({ bound: 0, skipped: 0, unbound: 0, refreshed: 0 });
        expect(seen).toHaveLength(1);
        expect(seen[0]?.fields).toMatchObject({ organizationId: "not-a-uuid", phase: "bind" });
      });
    });
  },
);
