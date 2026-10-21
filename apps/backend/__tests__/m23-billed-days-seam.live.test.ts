/**
 * M23 → M27 PatientDaysProvider seam — LIVE Postgres proof (§4.4).
 *
 * Proves the billed-and-accepted census aggregate over real Postgres: seed accepted + non-accepted claims with
 * per-diem (RHC/GIP) and non-per-diem (physician) lines, build M23's real `PatientDaysProvider`, and assert
 * `billedDaysForFiscalYear` sums ONLY the per-diem days on MAC-accepted claims whose service falls in the FY —
 * DRAFT claims, out-of-FY lines, and physician (visit) lines are excluded. The M1-registry typing + the
 * deny-stub fail-closed path are covered by the unit/m27 suites; this is the real aggregate-over-Postgres proof.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m23-billed-days-seam.live.test.ts
 * (SUPERUSER to a THROWAWAY db; for a local PG without pgvector set CHARTWARDEN_TEST_NO_PGVECTOR=1.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildM23PatientDaysProvider } from "../src/modules/23-billing-medicare/cost-report-seams";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const FY_START = "2025-10-01";
const FY_END = "2026-09-30";
const U = "00000000-0000-0000-0000-0000000000ff"; // a throwaway uuid for the many logical-FK columns

describe.skipIf(!DB_URL)("M23 → M27 PatientDaysProvider seam — LIVE Postgres (§4.4)", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  /** Insert one claim + its lines. `lines` = [revenueCode, levelOfCare, days, serviceFrom]. Each claim gets a
   *  distinct patient so the partial-unique (PE, patient, from, to) index on `claim` is not tripped. */
  async function seedClaim(
    state: string,
    patient: string,
    lines: ReadonlyArray<[string, string, number, string]>,
  ) {
    const claimId = (
      await admin.query(
        `INSERT INTO claim (organization_id, provider_entity_id, patient_id, admission_id, election_period_id_from,
           election_period_id_to, patient_payer_id, tob, service_from, service_to, state, claim_control_number,
           mac_jurisdiction, total_expected_payment_cents, sequestration_applied_pct, sequestration_policy_id,
           created_by_membership_id)
         VALUES ($1,$2,$3,$2,$2,$2,$2,'811',$4,$5,$6,$7,'ngs_j6',0,'2.00',$2,$2) RETURNING id`,
        [ORG, U, patient, FY_START, FY_END, state, `cc-${patient}-${state}`],
      )
    ).rows[0].id as string;
    let n = 0;
    for (const [rev, loc, days, from] of lines) {
      n += 1;
      await admin.query(
        `INSERT INTO claim_line (organization_id, claim_id, line_number, revenue_code, q_code, level_of_care,
           service_date_from, service_date_to, unit_count, unit_rate_cents, line_charge_cents, level_of_care_period_id)
         VALUES ($1,$2,$3,$4,'Q5001',$5,$6,$6,$7,20000,$8,$1)`,
        [ORG, claimId, n, rev, loc, from, days, days * 20000],
      );
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
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG],
    );
    const P1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const P2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const P3 = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const P4 = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const P5 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    // Accepted: 200 RHC + 165 GIP days in the FY (= 365 per-diem days) + a physician line (excluded, not per-diem).
    await seedClaim("ACK_ACCEPTED", P1, [
      ["0651", "RHC", 200, "2025-11-01"],
      ["0656", "GIP", 165, "2026-02-01"],
      ["0657", "RHC", 50, "2026-02-01"], // physician services — NOT a per-diem revenue code → excluded
    ]);
    // Accepted CHC: one dated line per day in 15-minute units (10h = 40 units) — each line is ONE billed day.
    await seedClaim("ACK_ACCEPTED", P4, [
      ["0652", "CHC", 40, "2025-12-01"],
      ["0652", "CHC", 36, "2025-12-02"],
    ]);
    // Accepted visit line (0551, 15-minute units) — NOT a per-diem revenue code → excluded.
    await seedClaim("ACK_ACCEPTED", P5, [["0551", "RHC", 3, "2026-01-05"]]);
    // Accepted but the line's service is OUTSIDE the FY → excluded.
    await seedClaim("ACK_ACCEPTED", P2, [["0651", "RHC", 99, "2025-01-01"]]);
    // DRAFT (not yet MAC-accepted) → excluded entirely.
    await seedClaim("DRAFT", P3, [["0651", "RHC", 77, "2026-03-01"]]);
    handle = createDbClient({ connectionString: DB_URL! });
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (admin) await admin.end();
  });

  it("sums only the in-FY per-diem days on accepted claims (200 RHC + 2 CHC days + 165 GIP = 367)", async () => {
    const provider = buildM23PatientDaysProvider(handle.db);
    const agg = await provider.billedDaysForFiscalYear(ORG, FY_START, FY_END);
    // CHC lines carry 15-minute units (40 + 36), but each is one billed DAY.
    expect(agg.totalPatientDays).toBe(367);
    expect(agg.byLevelOfCare).toEqual({ rhc: 200, chc: 2, irc: 0, gip: 165 });
  });
});
