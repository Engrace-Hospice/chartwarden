/**
 * M26 → M27 cost-report cap seam bind — LIVE Postgres proof (D13).
 *
 * Proves the full publish-side data path: seed a cap period + beneficiary/inpatient accruals, build M26's
 * real `CapAccrualReader` over a live Drizzle client, and assert `aggregateForCostReport` returns the right
 * cap-period aggregate — then run it through M27's `resolveCapContext` to confirm the cents-as-string →
 * integer `CapContext` map. The M1-registry typing + the deny-stub fail-closed path are covered by the unit
 * suites; this is the real aggregate-over-Postgres proof.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m26-cost-report-cap-seam.live.test.ts
 * (SUPERUSER to a THROWAWAY db; for a local PG without pgvector set CHARTWARDEN_TEST_NO_PGVECTOR=1.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDrizzleM26ReadService } from "../src/modules/26-cap/routes/read-service-drizzle";
import { buildM26SeamImpls } from "../src/modules/26-cap/seam-impls";
import {
  type CapAggregateSeam,
  resolveCapContext,
} from "../src/modules/27-cost-report/routes/cap-context";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const CAP_YEAR = "FY2025";

describe.skipIf(!DB_URL)("M26 → M27 cost-report cap seam — LIVE Postgres (D13)", () => {
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
    // One cap period (per-beneficiary cap $34,465.34) + two beneficiary accruals + an inpatient accrual.
    const period = (
      await admin.query(
        `INSERT INTO cap_period (organization_id, ccn, cap_year, starts_on, ends_on, aggregate_cap_amount_cents,
           inpatient_cap_pct, methodology, status, opened_by)
         VALUES ($1,'000000',$2,'2024-10-01','2025-09-30',3446534,0.2000,'streamlined','active',gen_random_uuid())
         RETURNING id`,
        [ORG, CAP_YEAR],
      )
    ).rows[0].id as string;
    for (const [patient, paid] of [
      ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 4_000_000],
      ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", 3_000_000],
    ] as const) {
      await admin.query(
        `INSERT INTO cap_beneficiary_accrual (organization_id, cap_period_id, patient_id, mbi_normalized, paid_cents, first_election_in_period)
         VALUES ($1,$2,$3,'1EG4TE5MK73',$4,'2024-10-01')`,
        [ORG, period, patient, paid],
      );
    }
    await admin.query(
      `INSERT INTO cap_inpatient_accrual (organization_id, cap_period_id, gip_days, irc_days, total_patient_days)
       VALUES ($1,$2,5,2,100)`,
      [ORG, period],
    );
    handle = createDbClient({ connectionString: DB_URL! });
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (admin) await admin.end();
  });

  it("aggregateForCostReport sums the live ledger (pre-settlement: cap = $34,465.34 × 2; payments = $70,000)", async () => {
    const impls = buildM26SeamImpls(handle.db, buildDrizzleM26ReadService(handle.db));
    const agg = await impls.accrual.aggregateForCostReport(ORG, CAP_YEAR);
    expect(agg).not.toBeNull();
    expect(agg).toMatchObject({
      capYear: CAP_YEAR,
      beneficiaryCount: 2,
      aggregateCapCents: String(3_446_534 * 2), // 6,893,068
      aggregatePaymentsCents: "7000000",
      inpatientDays: 7,
      totalMedicareDays: 100,
    });
  });

  it("resolveCapContext maps it to the M27 CapContext (string cents → integer) + binds", async () => {
    const impls = buildM26SeamImpls(handle.db, buildDrizzleM26ReadService(handle.db));
    const r = await resolveCapContext(() => impls.accrual as CapAggregateSeam, ORG, CAP_YEAR);
    expect(r.capProviderBound).toBe(true);
    expect(r.capContext).toEqual({
      aggregateCapCents: 6_893_068,
      aggregatePaymentsCents: 7_000_000,
      inpatientDays: 7,
      totalMedicareDays: 100,
    });
  });

  it("an unknown cap year → null aggregate → fail-closed CapContext", async () => {
    const impls = buildM26SeamImpls(handle.db, buildDrizzleM26ReadService(handle.db));
    const r = await resolveCapContext(() => impls.accrual as CapAggregateSeam, ORG, "FY2099");
    expect(r).toEqual({ capContext: null, capProviderBound: false });
  });
});
