/**
 * M25 → M27 ClaimSettlementProvider seam — LIVE Postgres proof (§4.4).
 *
 * Proves the actual interim-payment aggregate over real Postgres: seed an 835 advice + claim-level remittance
 * lines (CLP04 payments) received inside and outside the fiscal year, build M25's real `ClaimSettlementProvider`,
 * and assert `interimPaymentsForFiscalYear` sums ONLY the CLP04 dollars on lines RECEIVED in the FY window —
 * converted dollars→integer cents. The M1-registry typing + the deny-stub fail-closed path are covered by the
 * unit/m27 suites; this is the real aggregate-over-Postgres proof.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m25-interim-payments-seam.live.test.ts
 * (SUPERUSER to a THROWAWAY db; for a local PG without pgvector set CHARTWARDEN_TEST_NO_PGVECTOR=1.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildM25ClaimSettlementProvider } from "../src/modules/25-remittance/cost-report-seams";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const U = "00000000-0000-0000-0000-0000000000ff";
const FY_START = "2025-10-01";
const FY_END = "2026-09-30";

describe.skipIf(!DB_URL)("M25 → M27 ClaimSettlementProvider seam — LIVE Postgres (§4.4)", () => {
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

  /** Insert a claim-level remittance line (CLP04 dollars) received at `receivedAt` under one advice. */
  async function seedLine(adviceId: string, clp04Dollars: string, receivedAt: string) {
    await admin.query(
      `INSERT INTO remittance_line (organization_id, remittance_advice_id, clp02_status_code,
         clp03_total_charge_amount, clp04_total_payment_amount, clp05_patient_responsibility_amount, received_at)
       VALUES ($1,$2,1,$3,$3,0,$4)`,
      [ORG, adviceId, clp04Dollars, receivedAt],
    );
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
    const adviceId = (
      await admin.query(
        `INSERT INTO remittance_advice (organization_id, provider_entity_id, payer_id, payer_kind,
           interchange_control_number, transaction_set_control_number, payment_method, total_payment_amount,
           production_date, received_at, minio_object_key, file_sha256)
         VALUES ($1,$2,$2,'medicare','000000001','0001','eft',40000.00,'2026-02-01','2026-02-01','k','sha') RETURNING id`,
        [ORG, U],
      )
    ).rows[0].id as string;
    // Two payments received in the FY (30,000 + 10,000 = $40,000 → 4,000,000 cents) + one received before it.
    await seedLine(adviceId, "30000.00", "2025-11-15");
    await seedLine(adviceId, "10000.00", "2026-02-01");
    await seedLine(adviceId, "99999.00", "2024-06-01"); // received before the FY window → excluded
    handle = createDbClient({ connectionString: DB_URL! });
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (admin) await admin.end();
  });

  it("sums only the in-FY CLP04 payments, dollars→cents ($40,000 → 4,000,000)", async () => {
    const provider = buildM25ClaimSettlementProvider(handle.db);
    const agg = await provider.interimPaymentsForFiscalYear(ORG, FY_START, FY_END);
    expect(agg.interimPaymentsCents).toBe(4_000_000);
  });
});
