import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
/**
 * M9 - `LatestAssessmentProvider.linkSummary` (the M36 WP 3.2 clinical-link read seam) proven against real
 * Postgres as the NOBYPASSRLS `wardenx_app` role: found, unknown id, cross-tenant, exactly four keys, no score or
 * interpretation leaking, and a Part 2 (sud_context) row withheld like a missing one.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m9:link-summary:live
 */
import { createDrizzleAssessmentReaderStore } from "../src/modules/09-assessments/seams/drizzle-store";
import { createLatestAssessmentProvider } from "../src/modules/09-assessments/seams/providers";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const UNKNOWN_ID = "99999999-9999-9999-9999-999999999999";
const SECRET_SCORE_TEXT = "SECRET-INTERPRETATION-71";

type Siting = { providerEntity: string; location: string; membership: string };

describe.skipIf(!DB_URL)("M9 linkSummary - LIVE Postgres as wardenx_app", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let provider: ReturnType<typeof createLatestAssessmentProvider>;
  const siting: Record<string, Siting> = {};
  let aId: string;
  let sudId: string;

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

  async function seedOrg(org: string, n: number): Promise<Siting> {
    const membership = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [USER, org],
      )
    ).rows[0].id as string;
    const providerEntity = (
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
        [providerEntity, `Loc-LS${n}`],
      )
    ).rows[0].id as string;
    return { providerEntity, location, membership };
  }

  async function seedAssessment(org: string, scale: string, sud: boolean): Promise<string> {
    const s = siting[org];
    return (
      await admin.query(
        `INSERT INTO clinical_assessment (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, scale_type, scale_version, data, score, score_interpretation, captured_at,
           captured_by_membership_id, captured_by_discipline, sud_context)
         VALUES ($1,$2,$3,$4,$5,$6,'1.0','{"notes":"SECRET-NOTE"}'::jsonb, 71, $7,
           '2031-03-15T12:00:00.000Z', $8, 'RN', $9) RETURNING id`,
        [
          org,
          s.providerEntity,
          s.location,
          PATIENT,
          ADMISSION,
          scale,
          SECRET_SCORE_TEXT,
          s.membership,
          sud,
        ],
      )
    ).rows[0].id as string;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id, email) VALUES ($1,'ls@x.test')`, [USER]);
    siting[ORG_A] = await seedOrg(ORG_A, 1);
    siting[ORG_B] = await seedOrg(ORG_B, 2);
    aId = await seedAssessment(ORG_A, "pps", false);
    sudId = await seedAssessment(ORG_A, "aims", true);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    provider = createLatestAssessmentProvider(createDrizzleAssessmentReaderStore(handle.db));
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
      current_user: "wardenx_app",
      rolsuper: false,
      rolbypassrls: false,
    });
  });

  it("finds the assessment: id, patient, status, captured_at", async () => {
    expect(await provider.linkSummary(ORG_A, aId)).toEqual({
      id: aId,
      patientId: PATIENT,
      status: "active",
      occurredAt: "2031-03-15T12:00:00.000Z",
    });
  });

  it("returns null for an unknown id", async () => {
    expect(await provider.linkSummary(ORG_A, UNKNOWN_ID)).toBeNull();
  });

  it("cross-tenant: org B cannot resolve org A's assessment", async () => {
    expect(await provider.linkSummary(ORG_B, aId)).toBeNull();
  });

  it("returns exactly four keys and leaks no score, interpretation or note", async () => {
    const out = await provider.linkSummary(ORG_A, aId);
    expect(Object.keys(out ?? {}).sort()).toEqual(["id", "occurredAt", "patientId", "status"]);
    const json = JSON.stringify(out);
    expect(json).not.toContain(SECRET_SCORE_TEXT);
    expect(json).not.toContain("SECRET-NOTE");
    expect(json).not.toContain("71");
  });

  it("withholds a Part 2 (sud_context) assessment like a missing row", async () => {
    expect(await provider.linkSummary(ORG_A, sudId)).toBeNull();
  });

  it("fails closed on a blank organization or id", async () => {
    await expect(provider.linkSummary("", aId)).rejects.toThrow();
    await expect(provider.linkSummary(ORG_A, "")).rejects.toThrow();
  });
});
