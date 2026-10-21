/**
 * M27 ValidationContextBuilder — LIVE Postgres proof (§11.B).
 *
 * Proves the DB→context shaper end-to-end against real Postgres under RLS: seed an org + a cost report +
 * a couple worksheets (A carrying `grandTotalCostsCents`, B tying to A) + a compliance window, then build
 * the `ValidationContext` over a live org-scoped Drizzle tx with a STUB cap resolver (unbound → the M23/M26
 * gated rules skip) and a stub provider-entity resolver (a MAC jurisdiction → the rule-scope token). Assert
 * the worksheet totals are read straight from the jsonb and the deadline is computed from the window row.
 * The pure shaping is covered by the unit suite; this is the real worksheet-jsonb-over-Postgres proof.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m27-validation-context.live.test.ts
 * (SUPERUSER to a THROWAWAY db; for a local PG without pgvector set CHARTWARDEN_TEST_NO_PGVECTOR=1.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildM27ValidationContext } from "../src/modules/27-cost-report/jobs/validation-context-builder";
import type { CapAggregateSeam } from "../src/modules/27-cost-report/routes/cap-context";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const PROVIDER_ENTITY = "33333333-3333-3333-3333-333333333333";

// An unbound cap (the M26/M23 deny-stub posture) → aggregateForCostReport returns null → cap rules skip.
const unboundCap: CapAggregateSeam = {
  async aggregateForCostReport() {
    return null;
  },
};

// The M23/M25/M12 producers in their deny-stub posture: every method throws → M27 degrades each bind to
// null/false (the dependent rule SKIPS), exactly as the M1 deny-stub proxy behaves before a producer binds.
const denyProducers = {
  patientDays: () => ({
    async billedDaysForFiscalYear() {
      throw new Error("SEAM_NOT_BOUND");
    },
  }),
  settlement: () => ({
    async interimPaymentsForFiscalYear() {
      throw new Error("SEAM_NOT_BOUND");
    },
  }),
  drugCost: () => ({
    async drugCostForFiscalYear() {
      throw new Error("SEAM_NOT_BOUND");
    },
  }),
} as const;

describe.skipIf(!DB_URL)("M27 ValidationContextBuilder — LIVE Postgres (§11.B)", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let reportId: string;

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
    reportId = (
      await admin.query(
        `INSERT INTO cost_report (organization_id, provider_entity_id, fiscal_year_start_date,
           fiscal_year_end_date, state, bad_debt_claimed, wage_source)
         VALUES ($1,$2,'2025-10-01','2026-09-30','draft',false,'manual') RETURNING id`,
        [ORG, PROVIDER_ENTITY],
      )
    ).rows[0].id as string;
    // Worksheet A carries its grand-total cost; B fully allocates the same and ties to A.
    await admin.query(
      `INSERT INTO cost_report_worksheet (organization_id, cost_report_id, worksheet_code, data)
       VALUES ($1,$2,'A',$3)`,
      [ORG, reportId, JSON.stringify({ grandTotalCostsCents: 5_000_000 })],
    );
    await admin.query(
      `INSERT INTO cost_report_worksheet (organization_id, cost_report_id, worksheet_code, data)
       VALUES ($1,$2,'B',$3)`,
      [
        ORG,
        reportId,
        JSON.stringify({
          totalFullyAllocatedCostCents: 5_000_000,
          tiesToWorksheetAGrandTotal: true,
        }),
      ],
    );
    // The filing deadline timer: FYE 2026-09-30 + 5 months = 2027-02-28.
    await admin.query(
      `INSERT INTO cost_report_compliance_window (organization_id, cost_report_id, deadline_date,
         current_effective_deadline_date, last_alert_tier)
       VALUES ($1,$2,'2027-02-28','2027-02-28','none')`,
      [ORG, reportId],
    );
    handle = createDbClient({ connectionString: DB_URL! });
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (admin) await admin.end();
  });

  it("reads the worksheet totals from the jsonb + composes the typed ValidationContext", async () => {
    const builder = buildM27ValidationContext({
      capResolver: () => unboundCap,
      providerEntity: () => ({
        async resolveProviderEntity() {
          return { macJurisdiction: "ngs_j6" };
        },
      }),
      ...denyProducers,
      now: () => new Date("2026-12-01T00:00:00Z"),
    });
    const ctx = await withOrgContext(handle.db, { organizationId: ORG, userId: USER }, (tx) =>
      builder.build({ organizationId: ORG, costReportId: reportId, tx }),
    );

    expect(ctx.fiscalYearInt).toBe(2026);
    expect(ctx.macJurisdiction).toBe("NGS-J6");
    expect(ctx.worksheets.aGrandTotalCostsCents).toBe(5_000_000);
    expect(ctx.worksheets.bTotalAllocatedCents).toBe(5_000_000);
    expect(ctx.worksheets.bTiesToWorksheetA).toBe(true);
    expect(ctx.worksheets.presentCodes).toEqual(expect.arrayContaining(["A", "B"]));
    // Deadline computed from the window row + now (2026-12-01 → 2027-02-28).
    expect(ctx.deadline.windowOpen).toBe(true);
    expect(ctx.deadline.pastDeadline).toBe(false);
    expect(ctx.deadline.daysToDeadline).toBe(89);
    // M26 cap unbound + M23 seams unbound → the gated facts stay unavailable.
    expect(ctx.cap).toBeNull();
    expect(ctx.seams.capProviderBound).toBe(false);
    expect(ctx.statistics.billedCensusPatientDays).toBeNull();
    expect(ctx.seams.patientDaysProviderBound).toBe(false);
    expect(ctx.seams.claimSettlementProviderBound).toBe(false);
    expect(ctx.seams.drugCostBillingReaderBound).toBe(false);
  });

  it("fail-soft MAC: a provider-entity lookup error → `all` (only platform-default rules apply)", async () => {
    const builder = buildM27ValidationContext({
      capResolver: () => unboundCap,
      providerEntity: () => ({
        async resolveProviderEntity() {
          throw new Error("M40 down");
        },
      }),
      ...denyProducers,
      now: () => new Date("2026-12-01T00:00:00Z"),
    });
    const ctx = await withOrgContext(handle.db, { organizationId: ORG, userId: USER }, (tx) =>
      builder.build({ organizationId: ORG, costReportId: reportId, tx }),
    );
    expect(ctx.macJurisdiction).toBe("all");
  });

  it("binds M23 billed census + M25 interim payments → the gated flags flip and the rules go live", async () => {
    const builder = buildM27ValidationContext({
      capResolver: () => unboundCap,
      providerEntity: () => ({
        async resolveProviderEntity() {
          return { macJurisdiction: "ngs_j6" };
        },
      }),
      // M23 + M25 bound (stub producers returning fixed aggregates); M12 drug cost stays unbound (deny).
      patientDays: () => ({
        async billedDaysForFiscalYear() {
          return { totalPatientDays: 365 };
        },
      }),
      settlement: () => ({
        async interimPaymentsForFiscalYear() {
          return { interimPaymentsCents: 4_000_000 };
        },
      }),
      drugCost: denyProducers.drugCost,
      now: () => new Date("2026-12-01T00:00:00Z"),
    });
    const ctx = await withOrgContext(handle.db, { organizationId: ORG, userId: USER }, (tx) =>
      builder.build({ organizationId: ORG, costReportId: reportId, tx }),
    );
    expect(ctx.statistics.billedCensusPatientDays).toBe(365);
    expect(ctx.seams.patientDaysProviderBound).toBe(true);
    expect(ctx.seams.claimSettlementProviderBound).toBe(true);
    // M12 cost unmaterialized → still degraded (the drug-reconcile rule keeps SKIPPING).
    expect(ctx.seams.drugCostBillingReaderBound).toBe(false);
  });
});
