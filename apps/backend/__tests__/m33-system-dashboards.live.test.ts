/**
 * #138/F-060/F-116 — the M33 "day-one dashboards" seed, proven against real Postgres.
 *
 * `createDbSystemDashboardSeeder` is the DB layer of the fix: for every currently-`active` report base
 * (3 today — census/productivity/EVV), ensure a system-authored, org-shared `report_view` exists. This
 * drives it as the NOBYPASSRLS `wardenx_app` role (GAP-086) so the RLS + the partial unique-index
 * idempotency guard (`report_definition_system_org_base_uq`, migration 0248) are proven, not assumed.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m33:system-dashboards:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { eq } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbSystemDashboardSeeder } from "../src/modules/33-reporting/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-1111-1111-111111111138";
const ORG_B = "22222222-2222-2222-2222-222222222138";
const ORG_C = "33333333-3333-3333-3333-333333333138";
const USER_A = "44444444-4444-4444-4444-444444444138";
const USER_C = "55555555-5555-5555-5555-555555555138";

const ACTIVE_BASE_KEYS = [
  "census_org_daily",
  "encounter_productivity_membership_day",
  "evv_compliance_org_week",
].sort();

describe.skipIf(!DB_URL)("#138/F-060/F-116 — M33 day-one dashboards, LIVE Postgres", () => {
  let admin: Client;
  let appHandle: ReturnType<typeof createDbClient>;

  async function applyMigrations() {
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  async function seedOrgAndMembership(orgId: string, userId: string, membershipId: string) {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$4)",
      [orgId, orgId, orgId, orgId],
    );
    await admin.query(`INSERT INTO "user" (id,email,name) VALUES ($1,$2,$3)`, [
      userId,
      `${userId}@example.test`,
      userId,
    ]);
    await admin.query(
      `INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active')`,
      [membershipId, userId, orgId],
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await applyMigrations();
    const appUrl = await appRoleConnectionString(admin, DB_URL as string);
    appHandle = createDbClient({ connectionString: appUrl });
  }, 240_000);

  afterAll(async () => {
    await appHandle?.close();
    await admin?.end();
  });

  it("seeds one system-authored, org-shared dashboard per active base, for a fresh org", async () => {
    const membershipId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0138";
    await seedOrgAndMembership(ORG_A, USER_A, membershipId);
    const seeder = createDbSystemDashboardSeeder(appHandle.db);

    const first = await seeder.ensureSystemDashboards({
      organizationId: ORG_A,
      userId: USER_A,
      ownerMembershipId: membershipId,
    });
    expect([...first.created].sort()).toEqual(ACTIVE_BASE_KEYS);
    expect(first.alreadyPresent).toEqual([]);

    // Verified off the SUPERUSER connection (RLS-exempt) — this is a "did the row land" assertion, not
    // an RLS assertion; the isolation claim is the dedicated org-B test below, made from a genuinely
    // org-B-scoped connection rather than a bare read on a pooled connection whose `app.org_id` GUC may
    // have reverted to '' (loud, `22P02`) or NULL (silent, matches nothing either way) from a PRIOR
    // transaction — the exact hazard CLAUDE.md's F-030 `session_scope_chk` finding documents.
    const definitionRows = await admin.query<{
      base_key: string;
      status: string;
      latest_version_id: string | null;
    }>(
      `SELECT base_key, status, latest_version_id FROM report_definition WHERE organization_id = $1 AND authorship = 'system'`,
      [ORG_A],
    );
    expect(definitionRows.rows).toHaveLength(3);
    expect(
      definitionRows.rows.every((d) => d.status === "published" && d.latest_version_id !== null),
    ).toBe(true);
    expect([...definitionRows.rows.map((d) => d.base_key)].sort()).toEqual(ACTIVE_BASE_KEYS);

    const viewRows = await admin.query<{
      share_scope: string;
      owner_membership_id: string;
      status: string;
    }>(
      `SELECT share_scope, owner_membership_id, status FROM report_view WHERE organization_id = $1`,
      [ORG_A],
    );
    expect(viewRows.rows).toHaveLength(3);
    for (const v of viewRows.rows) {
      expect(v.share_scope).toBe("org");
      expect(v.owner_membership_id).toBe(membershipId);
      expect(v.status).toBe("active");
    }

    // Idempotent: a second accept for the same org (a second member accepting) is a full no-op.
    const second = await seeder.ensureSystemDashboards({
      organizationId: ORG_A,
      userId: USER_A,
      ownerMembershipId: membershipId,
    });
    expect(second.created).toEqual([]);
    expect([...second.alreadyPresent].sort()).toEqual(ACTIVE_BASE_KEYS);
    const definitionsAfter = await admin.query(
      `SELECT id FROM report_definition WHERE organization_id = $1 AND authorship = 'system'`,
      [ORG_A],
    );
    expect(definitionsAfter.rows).toHaveLength(3); // still 3, not 6
  });

  it("org B cannot see org A's system dashboards, from a genuinely org-B-scoped connection (RLS)", async () => {
    const membershipB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0138";
    const userB = "66666666-6666-6666-6666-666666666138";
    await seedOrgAndMembership(ORG_B, userB, membershipB);
    // Deliberately do NOT seed dashboards for org B — its own read of org A's rows must be empty under
    // its own tenant context, proving isolation rather than merely "org B has none of its own yet".
    const rows = await withOrgContext(
      appHandle.db,
      { organizationId: ORG_B, userId: userB },
      (tx) =>
        tx.select().from(schema.reportView).where(eq(schema.reportView.organizationId, ORG_A)),
    );
    expect(rows).toEqual([]);
    // Control: org A's OWN scoped connection sees its 3 rows — proving the empty result above is
    // isolation, not an RLS misconfiguration that hides everything from everybody.
    const ownRows = await withOrgContext(
      appHandle.db,
      { organizationId: ORG_A, userId: USER_A },
      (tx) =>
        tx.select().from(schema.reportView).where(eq(schema.reportView.organizationId, ORG_A)),
    );
    expect(ownRows).toHaveLength(3);
  });

  it("a concurrent second seeder call for a brand-new org creates each base exactly once", async () => {
    const membershipC = "cccccccc-cccc-cccc-cccc-cccccccc0138";
    await seedOrgAndMembership(ORG_C, USER_C, membershipC);
    const seederOne = createDbSystemDashboardSeeder(appHandle.db);
    const seederTwo = createDbSystemDashboardSeeder(appHandle.db);

    const input = { organizationId: ORG_C, userId: USER_C, ownerMembershipId: membershipC };
    const [a, b] = await Promise.all([
      seederOne.ensureSystemDashboards(input),
      seederTwo.ensureSystemDashboards(input),
    ]);

    // Exactly one of the two racing calls creates each base; the other sees it already present —
    // `report_definition_system_org_base_uq` (migration 0248) is what makes this true rather than a
    // fluke of scheduling.
    expect(a.created.length + b.created.length).toBe(3);
    expect(a.alreadyPresent.length + b.alreadyPresent.length).toBe(3);

    const definitions = await admin.query(
      `SELECT id FROM report_definition WHERE organization_id = $1 AND authorship = 'system'`,
      [ORG_C],
    );
    expect(definitions.rows).toHaveLength(3); // never 6
    const views = await admin.query(`SELECT id FROM report_view WHERE organization_id = $1`, [
      ORG_C,
    ]);
    expect(views.rows).toHaveLength(3);
  });
});
