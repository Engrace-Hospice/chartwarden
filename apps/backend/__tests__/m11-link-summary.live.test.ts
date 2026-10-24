import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
/**
 * M11 — `OrderProvider.linkSummary` (the M36 WP 3.2 clinical-link read seam) proven against real Postgres as
 * the NOBYPASSRLS `chartwarden_app` role: found, unknown id, tenant isolation (wrong org -> null), and the
 * 4-key shape (no order data / indication text).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m11:link-summary:live
 * (no pgvector locally: CHARTWARDEN_TEST_NO_PGVECTOR=1)
 */
import { createDrizzleOrderSeamStore } from "../src/modules/11-orders/seams/drizzle-store";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const PHYSICIAN = "66666666-6666-6666-6666-666666666666";
const SECRET = "SECRET-INDICATION";

type OrgFixture = { provider: string; membership: string };

describe.skipIf(!DB_URL)("M11 OrderProvider.linkSummary — LIVE Postgres as chartwarden_app", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let store: ReturnType<typeof createDrizzleOrderSeamStore>;
  const fixtures: Record<string, OrgFixture> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  async function seedOrg(org: string, n: number): Promise<OrgFixture> {
    const provider = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-LS${n}`, `LS Provider ${n}`, `NPI-LS${n}`],
      )
    ).rows[0].id as string;
    const user = (
      await admin.query(`INSERT INTO "user" (email) VALUES ('ls-rn-${n}@x.test') RETURNING id`)
    ).rows[0].id as string;
    const membership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [user, org],
      )
    ).rows[0].id as string;
    return { provider, membership };
  }

  async function seedOrder(org: string, status: string, signedAt: Date | null): Promise<string> {
    const f = fixtures[org];
    return (
      await admin.query(
        `INSERT INTO order_record
           (organization_id, provider_entity_id, patient_id, admission_id, kind, kind_version, data,
            status, drafter_membership_id, drafter_discipline, ordering_physician_mdm_id,
            indication_text, signed_at)
         VALUES ($1,$2,$3,$4,'lab','v1','{"secret":"${SECRET}"}'::jsonb,$5,$6,'rn_case_manager',$7,$8,$9)
         RETURNING id`,
        [org, f.provider, PATIENT, ADMISSION, status, f.membership, PHYSICIAN, SECRET, signedAt],
      )
    ).rows[0].id as string;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    fixtures[ORG_A] = await seedOrg(ORG_A, 1);
    fixtures[ORG_B] = await seedOrg(ORG_B, 2);
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    store = createDrizzleOrderSeamStore(handle.db);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("proves the connection is the NOBYPASSRLS app role", async () => {
    const probe = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await probe.connect();
    const { rows } = await probe.query(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user",
    );
    await probe.end();
    expect(rows[0]).toMatchObject({
      current_user: "chartwarden_app",
      rolsuper: false,
      rolbypassrls: false,
    });
  });

  it("finds a draft order: patient, status, occurredAt = createdAt", async () => {
    const id = await seedOrder(ORG_A, "draft", null);
    const created = (await admin.query("SELECT created_at FROM order_record WHERE id=$1", [id]))
      .rows[0].created_at as Date;
    const out = await store.linkSummary(ORG_A, id);
    expect(out).toEqual({
      id,
      patientId: PATIENT,
      status: "draft",
      occurredAt: created.toISOString(),
    });
  });

  it("occurredAt = signedAt when signed", async () => {
    const signed = new Date("2031-03-15T12:00:00.000Z");
    const id = await seedOrder(ORG_A, "active", signed);
    expect((await store.linkSummary(ORG_A, id))?.occurredAt).toBe(signed.toISOString());
  });

  it("returns null for an unknown id", async () => {
    expect(await store.linkSummary(ORG_A, "99999999-9999-9999-9999-999999999999")).toBeNull();
  });

  it("cross-tenant: org B's order is never returned for org A; the wrong org yields null", async () => {
    const aId = await seedOrder(ORG_A, "draft", null);
    const bId = await seedOrder(ORG_B, "draft", null);
    expect((await store.linkSummary(ORG_A, aId))?.id).toBe(aId);
    expect((await store.linkSummary(ORG_B, bId))?.id).toBe(bId);
    expect(await store.linkSummary(ORG_A, bId)).toBeNull();
    expect(await store.linkSummary(ORG_B, aId)).toBeNull();
  });

  it("returns exactly 4 keys and none of the seeded sensitive columns", async () => {
    const id = await seedOrder(ORG_A, "draft", null);
    const out = await store.linkSummary(ORG_A, id);
    expect(Object.keys(out ?? {}).sort()).toEqual(["id", "occurredAt", "patientId", "status"]);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});
