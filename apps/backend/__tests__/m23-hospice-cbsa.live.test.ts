/**
 * M23 hospice CBSA geography (value codes 61 / G8) — LIVE Postgres proof (migrations 1058 + 1059).
 *
 * The platform reference tables `hospice_zip_county` / `hospice_cbsa_county` / `hospice_cbsa_wage_index` are loaded by
 * the migration from the CMS FY2026/FY2027 hospice wage-index files and the Census ZCTA crosswalk
 * (scripts/data/hospice-cbsa/build_hospice_cbsa_migration.py). This proves, on the migrated NOBYPASSRLS `wardenx_app`
 * role (`_live-app-role.ts`), that:
 *   - real ZIPs resolve through `buildHospiceCbsaReader` to the CMS CBSA / rural / transition code for the claim's
 *     fiscal year (urban, a micropolitan-rural ZIP, a metropolitan division, a transition county);
 *   - Connecticut resolves via its planning regions; a PO-box ZIP via its ZIP3 only when unanimous; G8 reads the facility ZIP;
 *     a ZIP nothing can place is `unresolved`, never silently rural;
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
import {
  buildHospiceCbsaReader,
  toFacilitySpans,
} from "../src/modules/23-billing-medicare/services/claim-cbsa";
import { facilityPostalCodesForIds } from "../src/modules/40-mdm/facility-kind-reader";
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
      facilitySpans: async () => [
        { effectiveFrom: "2026-01-01", effectiveTo: null, postalCode: facilityZip },
      ],
    }).areasFor(
      ORG,
      "patient-1",
      { from: "2026-03-01", to: end },
      facilityZip === null ? [] : [{ from: "2026-03-05", to: "2026-03-08" }],
    );

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

  it("resolves Connecticut through its 2022 planning regions (Census town crosswalk + OMB 23-01)", async () => {
    const hartford = await areaFor("06103", null, FY2027_END); // Hartford -> Capitol planning region
    expect(hartford.residence).toMatchObject({
      status: "resolved",
      cbsaCode: "25540",
      areaKind: "urban",
      via: "zip",
    });
    // Pomfret (Northeastern CT region) is rural under the planning-region delineation.
    expect((await areaFor("06259", null, FY2027_END)).residence).toMatchObject({
      status: "resolved",
      areaKind: "rural",
    });
  });

  it("places the demo provider (CCN 381588, Pendleton OR, ZIP 97801) in Umatilla County's area", async () => {
    const { residence } = await areaFor("97801", null, FY2027_END);
    expect(residence).toMatchObject({ status: "resolved", countyFips: "41059", via: "zip" });
    expect(residence?.status === "resolved" && residence.wageIndex).toMatch(/^\d\.\d{4}$/);
  });

  // A 5-digit ZIP under `zip3` that has no ZCTA (the stand-in for a PO-box / unique-organisation ZIP).
  const unusedZipUnder = async (zip3: string): Promise<string | null> => {
    const { rows } = await admin.query(
      `SELECT lpad(n::text, 2, '0') AS tail FROM generate_series(0, 99) n
        WHERE NOT EXISTS (SELECT 1 FROM hospice_zip_county z WHERE z.zip5 = $1 || lpad(n::text, 2, '0'))
        LIMIT 1`,
      [zip3],
    );
    return rows[0] ? zip3 + (rows[0].tail as string) : null;
  };

  it("places a PO-box ZIP (no ZCTA) by its 3-digit prefix only when every ZIP sharing it agrees", async () => {
    const { rows } = await admin.query(
      "SELECT zip3, cbsa_code FROM hospice_zip3_area WHERE fiscal_year_starting = 2026 ORDER BY zip3",
    );
    let poBox: string | null = null;
    let expected = "";
    for (const row of rows) {
      poBox = await unusedZipUnder(row.zip3 as string);
      if (poBox) {
        expected = row.cbsa_code as string;
        break;
      }
    }
    expect(poBox).not.toBeNull();
    expect((await areaFor(poBox as string, null, FY2027_END)).residence).toMatchObject({
      status: "resolved",
      cbsaCode: expected,
      countyFips: null,
      via: "zip3_unanimous",
    });
  });

  it("does NOT guess a PO-box ZIP whose prefix spans different areas — it stays unresolved", async () => {
    const { rows } = await admin.query(
      `SELECT DISTINCT left(z.zip5, 3) AS zip3 FROM hospice_zip_county z
        WHERE NOT EXISTS (SELECT 1 FROM hospice_zip3_area a
                           WHERE a.fiscal_year_starting = 2026 AND a.zip3 = left(z.zip5, 3))
        ORDER BY 1`,
    );
    let poBox: string | null = null;
    for (const row of rows) {
      poBox = await unusedZipUnder(row.zip3 as string);
      if (poBox) break;
    }
    expect(poBox).not.toBeNull();
    expect((await areaFor(poBox as string, null, FY2027_END)).residence).toEqual({
      status: "unresolved",
      reason: "zip_unknown",
    });
  });

  it("never defaults an unknown or malformed ZIP to rural", async () => {
    expect((await areaFor("00000", null, FY2027_END)).residence).toEqual({
      status: "unresolved",
      reason: "zip_unknown",
    });
    expect((await areaFor("abc", null, FY2027_END)).residence).toEqual({
      status: "unresolved",
      reason: "invalid_zip",
    });
  });

  it("reads a facility's ZIP from the real facility.primary_address shape and resolves G8 from it", async () => {
    const FACILITY = "f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0";
    const MERGED = "e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0";
    const NO_ADDRESS = "d0d0d0d0-d0d0-40d0-80d0-d0d0d0d0d0d0";
    // The seed-mdm.ts shape: { line1, city, state, postalCode }.
    await admin.query(
      `INSERT INTO facility (id, ccn, npi, kind, name, primary_address, sending_facility_codes, status, merged_from, created_at, updated_at)
       VALUES ($1,NULL,NULL,'hospital','Good Shepherd Medical Center',$2,'[]','active','{}',now(),now()),
              ($3,NULL,NULL,'snf','No Address SNF',NULL,'[]','active','{}',now(),now())`,
      [
        FACILITY,
        JSON.stringify({
          line1: "610 NW 11th St",
          city: "Hermiston",
          state: "OR",
          postalCode: "97838",
        }),
        NO_ADDRESS,
      ],
    );
    await admin.query(
      `INSERT INTO facility (id, ccn, npi, kind, name, primary_address, sending_facility_codes, status, merged_from, merged_into_id, created_at, updated_at)
       VALUES ($1,NULL,NULL,'hospital','Old Name','{"postalCode":"00000"}','[]','merged','{}',$2,now(),now())`,
      [MERGED, FACILITY],
    );
    const postal = await facilityPostalCodesForIds(handle.db, [FACILITY, MERGED, NO_ADDRESS]);
    expect(postal.get(FACILITY)).toBe("97838");
    expect(postal.get(MERGED)).toBe("97838"); // chases merged_into_id to the survivor
    expect(postal.has(NO_ADDRESS)).toBe(false); // no address -> absent, never a guess

    // A nursing-home resident (ZIP 97801) admitted to the hospital (ZIP 97838) for a GIP stay: G8 is the HOSPITAL,
    // because only its span overlaps the inpatient dates - not "the latest facility".
    const NURSING_HOME = "c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0";
    await admin.query(
      `INSERT INTO facility (id, ccn, npi, kind, name, primary_address, sending_facility_codes, status, merged_from, created_at, updated_at)
       VALUES ($1,NULL,NULL,'nf','Pendleton Care Center',$2,'[]','active','{}',now(),now())`,
      [
        NURSING_HOME,
        JSON.stringify({
          line1: "1 Care Way",
          city: "Pendleton",
          state: "OR",
          postalCode: "97801",
        }),
      ],
    );
    const postalById = await facilityPostalCodesForIds(handle.db, [NURSING_HOME, FACILITY]);
    const gipDates = [{ from: "2026-11-10", to: "2026-11-14" }];
    const readerFor = (spans: Parameters<typeof toFacilitySpans>[0]) =>
      buildHospiceCbsaReader(handle.db, {
        residencePostalCode: async () => "97801",
        facilitySpans: async () => toFacilitySpans(spans, postalById),
      });
    const range = { from: "2026-11-01", to: FY2027_END };
    const facilityResidence = (id: string, from: string, to: string | null) => ({
      kind: "facility",
      facilityId: id,
      effectiveFrom: from,
      effectiveTo: to,
    });

    // overlap: the nursing home ended before the GIP stay, the hospital span covers it
    const overlap = await readerFor([
      facilityResidence(NURSING_HOME, "2026-01-01", "2026-11-09"),
      facilityResidence(FACILITY, "2026-11-10", "2026-11-14"),
      facilityResidence(NURSING_HOME, "2026-11-15", null),
    ]).areasFor(ORG, "patient-1", range, gipDates);
    expect(overlap.facility).toMatchObject({ status: "resolved", countyFips: "41059" });

    // ambiguous: the nursing-home span is still open across the GIP dates and a hospital span overlaps too
    const ambiguous = await readerFor([
      facilityResidence(NURSING_HOME, "2026-01-01", null),
      facilityResidence(FACILITY, "2026-11-10", "2026-11-14"),
    ]).areasFor(ORG, "patient-1", range, gipDates);
    expect(ambiguous.facility).toEqual({ status: "unresolved", reason: "ambiguous_facility" });

    // none overlap: the facility spans do not touch the GIP dates
    const none = await readerFor([
      facilityResidence(NURSING_HOME, "2026-01-01", "2026-11-09"),
    ]).areasFor(ORG, "patient-1", range, gipDates);
    expect(none.facility).toEqual({ status: "unresolved", reason: "no_facility_stay" });

    // no inpatient care on the claim: G8 is not needed at all
    const noGip = await readerFor([]).areasFor(ORG, "patient-1", range, []);
    expect(noGip.facility).toBeNull();
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

  it("migration 1058 is idempotent: re-applying it changes nothing and does not error", async () => {
    const count = async () =>
      (
        await admin.query(
          `SELECT (SELECT count(*) FROM hospice_zip_county) AS z, (SELECT count(*) FROM hospice_zip3_area) AS z3,
                  (SELECT count(*) FROM hospice_cbsa_county) AS c, (SELECT count(*) FROM hospice_cbsa_wage_index) AS w`,
        )
      ).rows[0];
    const before = await count();
    const sql = readFileSync(join(MIGRATIONS_DIR, "1058_m23_hospice_cbsa_reference.sql"), "utf8");
    await admin.query(sql);
    expect(await count()).toEqual(before);
  });

  it("adds claim.value_codes as a jsonb array", async () => {
    const { rows } = await admin.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'claim_value_codes_array_chk'",
    );
    expect(rows.length).toBeGreaterThanOrEqual(1); // parent + partitions
  });
});
