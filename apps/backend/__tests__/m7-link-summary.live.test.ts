import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
/**
 * M7 - `CarePlanReader.linkSummary` (the M36 WP 3.2 clinical-link read seam) proven against real Postgres as the
 * NOBYPASSRLS `chartwarden_app` role: found, unknown id, cross-tenant, exactly four keys, and no plan content.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m7:link-summary:live
 * (no pgvector locally: CHARTWARDEN_TEST_NO_PGVECTOR=1)
 */
import { createDrizzleCarePlanReaderStore } from "../src/modules/07-care-plan/seams/drizzle-store";
import { createCarePlanReader } from "../src/modules/07-care-plan/seams/reader";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const UNKNOWN_ID = "99999999-9999-9999-9999-999999999999";
const SECRET = "SECRET-SUD-PROBLEM-TEXT";

describe.skipIf(!DB_URL)("M7 CarePlanReader.linkSummary - LIVE Postgres as chartwarden_app", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let reader: ReturnType<typeof createCarePlanReader>;
  const planOf: Record<string, string> = {};
  const siting: Record<string, { provider: string; location: string }> = {};

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

  async function seedOrg(org: string, n: number) {
    const provider = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-LS${n}`, `LS Provider ${n}`, `NPI-LS${n}`],
      )
    ).rows[0].id as string;
    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [provider, `Loc-LS${n}`],
      )
    ).rows[0].id as string;
    siting[org] = { provider, location };
    planOf[org] = (
      await admin.query(
        `INSERT INTO care_plan (organization_id, provider_entity_id, location_id, patient_id, admission_id,
           initial_due_at, status, updated_at)
         VALUES ($1,$2,$3,$4,gen_random_uuid(), now() + interval '5 days', 'active', '2031-03-15T12:00:00Z')
         RETURNING id`,
        [org, provider, location, PATIENT],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO problem (organization_id, provider_entity_id, location_id, care_plan_id, description, kind, status)
       VALUES ($1,$2,$3,$4,$5,'terminal','active')`,
      [org, provider, location, planOf[org], SECRET],
    );
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
    await seedOrg(ORG_A, 1);
    await seedOrg(ORG_B, 2);
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    reader = createCarePlanReader(createDrizzleCarePlanReaderStore(handle.db));
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

  it("returns id, patient, status and updated_at for a plan in the org", async () => {
    const got = await reader.linkSummary(ORG_A, planOf[ORG_A]);
    expect(got).toEqual({
      id: planOf[ORG_A],
      patientId: PATIENT,
      status: "active",
      occurredAt: "2031-03-15T12:00:00.000Z",
    });
  });

  it("returns null for an unknown id", async () => {
    expect(await reader.linkSummary(ORG_A, UNKNOWN_ID)).toBeNull();
  });

  it("returns null for another tenant's plan, in both directions", async () => {
    expect(await reader.linkSummary(ORG_A, planOf[ORG_B])).toBeNull();
    expect(await reader.linkSummary(ORG_B, planOf[ORG_A])).toBeNull();
    expect((await reader.linkSummary(ORG_B, planOf[ORG_B]))?.id).toBe(planOf[ORG_B]);
  });

  it("exposes exactly four keys and none of the seeded plan content or siting", async () => {
    const got = await reader.linkSummary(ORG_A, planOf[ORG_A]);
    expect(Object.keys(got ?? {}).sort()).toEqual(["id", "occurredAt", "patientId", "status"]);
    const json = JSON.stringify(got);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(siting[ORG_A].provider);
    expect(json).not.toContain(siting[ORG_A].location);
  });

  it("throws on a blank organizationId or id", async () => {
    await expect(reader.linkSummary("", planOf[ORG_A])).rejects.toThrow();
    await expect(reader.linkSummary(ORG_A, "")).rejects.toThrow();
  });
});
