/**
 * M34 — platform-ops operators are bound into a freshly provisioned tenant org, LIVE Postgres, real NOBYPASSRLS
 * `wardenx_app`. Before this, `role_set[platform_ops]` alerts (stuck activation, oversized export hold) resolved
 * to nobody in a new tenant, because `platform_ops` is bound per membership and the org had none. Proves:
 *   - every operator holding the platform-owned `platform_ops` role gets an ACTIVE membership + binding in the org,
 *     and M36's real `role_set` reader then returns exactly them (a plain tenant user is not an operator);
 *   - the binding is to the platform-owned row (`organization_id IS NULL`), never a tenant-owned copy;
 *   - a re-run is a no-op, and a pre-existing non-active membership (pending, or revoked by a tenant admin) is
 *     never reactivated or resurrected.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m34:platform-staff-binding:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindPlatformStaffToOrg } from "../src/bootstrap/bind-platform-staff";
import { createDrizzleRoleSetMembersReader } from "../src/modules/36-messaging/alert-emitter-drizzle";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const HOME_ORG = "11111111-1111-4111-8111-1111f3400101";
const NEW_ORG = "22222222-2222-4222-8222-2222f3400102";
const OPS_USER = "33333333-3333-4333-8333-3333f3400103";
const OPS_USER_2 = "44444444-4444-4444-8444-4444f3400104";
const PLAIN_USER = "55555555-5555-4555-8555-5555f3400105";
const PENDING_OPS = "66666666-6666-4666-8666-6666f3400106";

describe.skipIf(!DB_URL)(
  "M34 platform-staff binding — LIVE Postgres, real wardenx_app role",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let platformOpsRoleId: string;

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
      const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
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
         ($3,'f3401-plain@example.test','Plain'),($4,'f3401-pending@example.test','Pending Ops')`,
        [OPS_USER, OPS_USER_2, PLAIN_USER, PENDING_OPS],
      );
      const role = await admin.query<{ id: string }>(
        `INSERT INTO role (organization_id, key, name, category, scope_level, enabled, description)
       VALUES (NULL, 'platform_ops', 'Platform Operations', 'platform_staff'::role_category, 'organization', true, 'live test')
       RETURNING id`,
      );
      platformOpsRoleId = role.rows[0]?.id as string;
      // Operators hold platform_ops via a membership in the platform home org; the plain user is a tenant member only.
      for (const userId of [OPS_USER, OPS_USER_2, PENDING_OPS, PLAIN_USER]) {
        const m = await admin.query<{ id: string }>(
          `INSERT INTO membership (user_id, organization_id, status, accepted_at)
         VALUES ($1,$2,'active',now()) RETURNING id`,
          [userId, HOME_ORG],
        );
        if (userId === PLAIN_USER) continue;
        await admin.query(
          `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)`,
          [HOME_ORG, m.rows[0]?.id, platformOpsRoleId],
        );
      }
      // PENDING_OPS already has a NON-active membership in the new org: the binder must not reactivate it.
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'pending')`,
        [PENDING_OPS, NEW_ORG],
      );
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    }, 240_000);

    afterAll(async () => {
      await handle?.close();
      await admin?.end();
    });

    it("binds every active operator into the new org, and the real role_set reader resolves exactly them", async () => {
      const result = await bindPlatformStaffToOrg(handle.db, NEW_ORG);

      // PENDING_OPS has a pending membership in the new org: skipped, so two of the three operators are bound.
      expect(result.operators).toBe(2);
      expect(result.skipped).toBe(1);
      const recipients = await createDrizzleRoleSetMembersReader(handle.db)(NEW_ORG, [
        "platform_ops",
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
        expect(row.id).toBe(platformOpsRoleId);
      }
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
  },
);
