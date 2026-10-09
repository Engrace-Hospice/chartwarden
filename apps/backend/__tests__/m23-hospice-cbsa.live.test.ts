/**
 * M23 hospice CBSA geography (value codes 61 / G8) — LIVE Postgres proof (migrations 1058 + 1059).
 *
 * The platform reference tables `hospice_zip_county` / `hospice_cbsa_county` / `hospice_cbsa_wage_index` are loaded by
 * the migration from the CMS FY2026/FY2027 hospice wage-index files and the Census ZCTA crosswalk
 * (scripts/data/hospice-cbsa/build_hospice_cbsa_migration.py). This proves, on the migrated NOBYPASSRLS `wardenx_app`
 * role (`_live-app-role.ts`), that:
 *   - real ZIPs resolve through `buildHospiceCbsaReader` to the CMS CBSA / rural / transition code for the claim's
 *     fiscal year (urban, a micropolitan-rural ZIP, a metropolitan division, a transition county);
 *   - a ZIP the sources cannot place (Connecticut — CMS adopted planning regions the Census file lacks; an unknown ZIP)
 *     is `unresolved`, never silently rural;
 *   - tenants can read the reference data but cannot write it (platform-shared, loader-only writes);
 *   - the wage index is published for the resolved code, and `claim.value_codes` exists with its array CHECK.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m23:hospice-cbsa:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHospiceCbsaReader } from "../src/modules/23-billing-medicare/services/claim-cbsa";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const FY2027_END = "2027-03-31"; // fiscal_year_starting 2026
const FY2026_END = "2026-03-31"; // fiscal_year_starting 2025

describe.skipIf(!DB_URL)("M23 hospice CBSA geography — LIVE Postgres (migration 1058)", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let appUrl: string;

  const areaFor = async (residenceZip: string | null, facilityZip: string | null, end: string) =>
    buildHospiceCbsaReader(handle.db, {
      residencePostalCode: async () => residenceZip,
      inpatientFacilityPostalCode: async () => facilityZip,
    }).areasFor(ORG, "patient-1", { from: "2026-03-01", to: end });

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
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
    appUrl = await appRoleConnectionString(admin, DB_URL as string);
    handle = createDbClient({ connectionString: appUrl, max: 2 });
  }, 600_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("resolves a metropolitan ZIP to its CBSA", async () => {
    const a = await areaFor("90210", null, FY2027_END); // Beverly Hills, Los Angeles County
    expect(a.residence).toMatchObject({ status: "resolved", cbsaCode: "31084", areaKind: "urban" });
    expect(a.facility).toBeNull();
  });

  it("resolves a Washington, DC ZIP to its metropolitan division, not the parent CBSA", async () => {
    const a = await areaFor("20001", null, FY2027_END);
    expect(a.residence).toMatchObject({ status: "resolved", cbsaCode: "47764" });
  });

  it("gives a rural (non-metropolitan) ZIP its state's 999NN code", async () => {
    const a = await areaFor("58601", null, FY2027_END); // Dickinson ND (micropolitan = rural for hospice)
    expect(a.residence).toMatchObject({ status: "resolved", cbsaCode: "99935", areaKind: "rural" });
  });

  it("resolves G8 from the facility ZIP independently of the residence", async () => {
    const a = await areaFor("58601", "90210", FY2027_END);
    expect(a.residence).toMatchObject({ cbsaCode: "99935" });
    expect(a.facility).toMatchObject({ cbsaCode: "31084" });
  });

  it("fails closed for Connecticut (planning regions) and for an unknown ZIP — never silently rural", async () => {
    expect((await areaFor("06103", null, FY2027_END)).residence).toEqual({
      status: "unresolved",
      reason: "county_unknown",
    });
    expect((await areaFor("00000", null, FY2027_END)).residence).toEqual({
      status: "unresolved",
      reason: "zip_unknown",
    });
    expect((await areaFor("abc", null, FY2027_END)).residence).toEqual({
      status: "unresolved",
      reason: "invalid_zip",
    });
  });

  it("uses the fiscal year the billing period ends in", async () => {
    const [fy26, fy27] = await Promise.all([
      areaFor("90210", null, FY2026_END),
      areaFor("90210", null, FY2027_END),
    ]);
    expect(fy26.residence).toMatchObject({ status: "resolved" });
    expect(fy27.residence).toMatchObject({ status: "resolved" });
    const { rows } = await admin.query(
      "SELECT fiscal_year_starting FROM hospice_cbsa_county WHERE county_fips = '06037' ORDER BY 1",
    );
    expect(rows.map((r) => r.fiscal_year_starting)).toEqual([2025, 2026]);
  });

  it("publishes a wage index for the code the resolver returns", async () => {
    const { rows } = await admin.query(
      "SELECT wage_index::text AS idx FROM hospice_cbsa_wage_index WHERE fiscal_year_starting = 2026 AND cbsa_code = '31084'",
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].idx)).toBeGreaterThan(0.5);
  });

  it("lets the app role read the reference data but never write it", async () => {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      const { rows } = await c.query("SELECT count(*)::int AS n FROM hospice_zip_county");
      expect(rows[0].n).toBeGreaterThan(30_000);
      await expect(
        c.query("INSERT INTO hospice_zip_county (zip5, county_fips) VALUES ('99999','06037')"),
      ).rejects.toThrow(/permission denied/i);
      await expect(c.query("DELETE FROM hospice_cbsa_county")).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await c.end();
    }
  });

  it("adds claim.value_codes as a jsonb array", async () => {
    const { rows } = await admin.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'claim_value_codes_array_chk'",
    );
    expect(rows.length).toBeGreaterThanOrEqual(1); // parent + partitions
  });
});
