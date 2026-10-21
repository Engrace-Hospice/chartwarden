/**
 * F-001 (#15) — the pre-organization membership picker, driven through the PRODUCTION repository,
 * LIVE Postgres.
 *
 * The defect: migrations 0213/0214 served `GET /api/v1/auth/memberships` by adding two PERMISSIVE
 * `app.user_id` RLS policies for `wardenx_app`. PostgreSQL UNIONs every permissive policy matching a
 * role+command, and `withOrgContext()` sets `app.user_id` on ORDINARY requests too (M4 audit
 * attribution) — so those policies were live on every org-scoped request and widened each one into a
 * cross-org read of the caller's memberships and of the organizations behind them. Migration 0215
 * drops both and moves the picker behind the `membership_pre_org_picker` SECURITY DEFINER function.
 *
 * `packages/db/migrations/__tests__/m1-rls-isolation.live.test.ts` proves the POLICY behaviour at the
 * table level. This suite proves the other half, which that one cannot: that
 * `createDbMembershipRepository().listForUser()` — the actual code path behind the sign-in org picker —
 * still returns the right rows through the new function, with the row SHAPE the route expects. That
 * mapping is hand-written (`tx.execute` is a raw query: no Drizzle column aliasing, no type
 * deserialization), so it is exactly the part a table-level policy test cannot cover. Before this
 * suite existed, `listForUser` had no live coverage at all.
 *
 * Everything runs as the NOBYPASSRLS `wardenx_app` role, so a missing GRANT or EXECUTE fails it.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m2:pre-org-picker:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbAdminMembershipReader } from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  MembershipRepository,
  UserDirectory,
} from "../src/modules/02-identity/identity-ports";
import { createDbUserDirectory } from "../src/modules/02-identity/identity-stores-db";
import { createDbMembershipRepository } from "../src/modules/02-identity/membership-repository";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111f0010001";
const ORG_B = "22222222-2222-4222-8222-2222f0010002";
/** A tenant the picker user has NO membership in — it must never appear in the picker. */
const ORG_FOREIGN = "33333333-3333-4333-8333-3333f0010003";
const USER = "44444444-4444-4444-8444-4444f0010004";
/** A second user, member of ORG_FOREIGN only — proves the picker is scoped to ONE user. */
const OTHER_USER = "55555555-5555-4555-8555-5555f0010005";

describe.skipIf(!DB_URL)("F-001 pre-org membership picker — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let repo: MembershipRepository;
  let users: UserDirectory;

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

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
    await applyMigrations();

    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES
         ($1,'f001-a','Alpha Hospice LLC','Alpha Hospice','active'),
         ($2,'f001-b','Beta Hospice LLC','Beta Hospice','active'),
         ($3,'f001-x','Foreign Hospice LLC','Foreign Hospice','active')`,
      [ORG_A, ORG_B, ORG_FOREIGN],
    );
    await admin.query(
      `INSERT INTO "user" (id,email,name) VALUES ($1,'picker@f001.test','Pat Picker'),($2,'other@f001.test','Other Person')`,
      [USER, OTHER_USER],
    );
    // The picker user belongs to A and B. OTHER_USER belongs only to the foreign org.
    await admin.query(
      `INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active'),($1,$3,'active'),($4,$5,'active')`,
      [USER, ORG_A, ORG_B, OTHER_USER, ORG_FOREIGN],
    );

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    repo = createDbMembershipRepository(handle.db, createDbAdminMembershipReader(handle.db));
    users = createDbUserDirectory(handle.db);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("returns every org the user belongs to, with the display name the picker renders", async () => {
    const rows = await repo.listForUser(USER);
    expect(rows.map((r) => r.organizationId).sort()).toEqual([ORG_A, ORG_B].sort());
    expect(rows.map((r) => r.organizationName).sort()).toEqual(["Alpha Hospice", "Beta Hospice"]);
  });

  it("maps the whole row shape, not just the ids (the raw-query mapping is hand-written)", async () => {
    const row = (await repo.listForUser(USER)).find((r) => r.organizationId === ORG_A);
    expect(row).toBeDefined();
    // Every field the route serialises. A snake_case/camelCase slip in the mapping lands as
    // `undefined` here rather than as a type error, which is precisely why this is asserted live.
    expect(row).toMatchObject({
      userId: USER,
      organizationId: ORG_A,
      organizationName: "Alpha Hospice",
      status: "active",
      displayName: "Pat Picker",
      email: "picker@f001.test",
      accountStatus: "active",
    });
    expect(row?.membershipId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is scoped to the requested user — a foreign org's member never leaks in", async () => {
    const rows = await repo.listForUser(USER);
    expect(rows.map((r) => r.organizationId)).not.toContain(ORG_FOREIGN);
    // ...and asking for the other user returns THEIR org, never the picker user's.
    const other = await repo.listForUser(OTHER_USER);
    expect(other.map((r) => r.organizationId)).toEqual([ORG_FOREIGN]);
  });

  it("GAP-001: returns revoked and other-org memberships, so deactivate can bound itself to one org", async () => {
    // POST /users/:id/deactivate refuses (404) a target with no membership in the caller's org and
    // (409) one still live elsewhere. Both decisions read listForUser, so it must see every org and
    // every status — a filter to `active` here would let a revoked-elsewhere user look foreign.
    const leaver = "66666666-6666-4666-8666-6666f0010006";
    await admin.query(
      `INSERT INTO "user" (id,email,name) VALUES ($1,'leaver@f001.test','Lee Ver')`,
      [leaver],
    );
    await admin.query(
      `INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active'),($1,$3,'revoked')`,
      [leaver, ORG_A, ORG_FOREIGN],
    );
    const rows = await repo.listForUser(leaver);
    expect(rows.map((r) => [r.organizationId, r.status]).sort()).toEqual(
      [
        [ORG_A, "active"],
        [ORG_FOREIGN, "revoked"],
      ].sort(),
    );
  });

  it("an org-scoped session still cannot read another org's membership rows (F-001)", async () => {
    // The regression itself, through the production tenancy helper: withOrgContext sets BOTH
    // app.org_id and app.user_id, which is the envelope that made the dropped pre-org policies
    // reachable on every ordinary request.
    const visible = await withOrgContext(
      handle.db,
      { organizationId: ORG_B, userId: USER },
      async (tx) => {
        const r = await tx.execute<{ n: number }>(
          `SELECT count(*)::int AS n FROM membership WHERE organization_id = '${ORG_A}'`,
        );
        return r.rows[0]?.n ?? -1;
      },
    );
    expect(visible).toBe(0);
  });
  describe("GAP-001 createDbUserDirectory.deactivateFromOrg (as wardenx_app)", () => {
    async function seedUser(id: string, email: string, memberships: [string, string][]) {
      await admin.query(`INSERT INTO "user" (id,email,name) VALUES ($1,$2,'Gap One')`, [id, email]);
      for (const [org, status] of memberships) {
        await admin.query(
          `INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,$3)`,
          [id, org, status],
        );
      }
    }
    async function statusOf(id: string): Promise<string | undefined> {
      const r = await admin.query<{ status: string }>(`SELECT status FROM "user" WHERE id=$1`, [
        id,
      ]);
      return r.rows[0]?.status;
    }

    it("deactivates a user whose only live membership is in the caller's org", async () => {
      const id = "77777777-7777-4777-8777-7777f0010001";
      await seedUser(id, "sole@f001.test", [
        [ORG_A, "active"],
        [ORG_B, "revoked"],
      ]);
      expect(
        await users.deactivateFromOrg({ userId: id, organizationId: ORG_A, reason: "x" }),
      ).toBe("deactivated");
      expect(await statusOf(id)).toBe("deactivated");
    });

    it("a former member (revoked in the caller's org, nothing live) is not_member — status untouched", async () => {
      const id = "77777777-7777-4777-8777-7777f0010002";
      await seedUser(id, "former@f001.test", [[ORG_A, "revoked"]]);
      expect(
        await users.deactivateFromOrg({ userId: id, organizationId: ORG_A, reason: "x" }),
      ).toBe("not_member");
      expect(await statusOf(id)).toBe("active");
    });

    it("a live member of another org is member_elsewhere — status untouched", async () => {
      const id = "77777777-7777-4777-8777-7777f0010003";
      await seedUser(id, "multi@f001.test", [
        [ORG_A, "active"],
        [ORG_B, "suspended"],
      ]);
      expect(
        await users.deactivateFromOrg({ userId: id, organizationId: ORG_A, reason: "x" }),
      ).toBe("member_elsewhere");
      expect(await statusOf(id)).toBe("active");
    });

    it("a non-UUID or unknown id is not_member (no 500 on the ::uuid cast)", async () => {
      expect(
        await users.deactivateFromOrg({ userId: "not-a-uuid", organizationId: ORG_A, reason: "x" }),
      ).toBe("not_member");
      expect(
        await users.deactivateFromOrg({
          userId: "77777777-7777-4777-8777-7777f00100ff",
          organizationId: ORG_A,
          reason: "x",
        }),
      ).toBe("not_member");
    });

    it("TOCTOU: a membership insert in another org that is in flight is waited for, then refuses (409 path)", async () => {
      const id = "77777777-7777-4777-8777-7777f0010004";
      await seedUser(id, "race@f001.test", [[ORG_A, "active"]]);
      // A concurrent invite-accept in ORG_B: inserted but not yet committed. Its FK check holds
      // FOR KEY SHARE on the user row, so the directory's FOR UPDATE must wait for it.
      const accept = new Client({ connectionString: DB_URL });
      await accept.connect();
      try {
        await accept.query("BEGIN");
        await accept.query(
          `INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active')`,
          [id, ORG_B],
        );
        let settled = false;
        const pending = Promise.resolve(
          users.deactivateFromOrg({ userId: id, organizationId: ORG_A, reason: "x" }),
        ).finally(() => {
          settled = true;
        });
        await new Promise((r) => setTimeout(r, 300));
        expect(settled).toBe(false); // blocked on the accept's lock, not deciding on a stale read
        await accept.query("COMMIT");
        expect(await pending).toBe("member_elsewhere");
        expect(await statusOf(id)).toBe("active");
      } finally {
        await accept.end();
      }
    });
  });
});
