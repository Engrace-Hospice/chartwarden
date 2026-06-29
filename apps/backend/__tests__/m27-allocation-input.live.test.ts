/**
 * M27 AllocationInputBuilder — LIVE Postgres proof (§3.1 / D8 `cost-allocation-recompute`).
 *
 * Proves the DB→input shaper end-to-end against real Postgres under RLS: seed an org + a cost report + the
 * input-bearing worksheets (A cost centers, C ancillary, E-1 settlement Medicare line) + the statistic_data
 * monthly census, then build the four allocation inputs over a live org-scoped Drizzle tx. With a STUB cap
 * resolver bound (a live aggregate) the settlement cap inputs materialize; the unit suite covers the unbound
 * (cap-skip) path and the pure shaping. Assert the inputs read straight from the worksheet jsonb / census and
 * that the deterministic chain (step-down → ancillary → program → settlement) runs over them and ties out.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m27-allocation-input.live.test.ts
 * (SUPERUSER to a THROWAWAY db; for a local PG without pgvector set WARDENX_TEST_NO_PGVECTOR=1.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  allocationResultsToWorksheets,
  apportionAncillary,
  apportionToPrograms,
  computeSettlement,
  CostReportWorksheetRepository,
  stepDownAllocate,
} from "@wardenx/cost-report";
import { createDbClient, type DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CapAggregateSeam } from "../src/modules/27-cost-report/routes/cap-context";
import { buildM27AllocationInputs } from "../src/modules/27-cost-report/jobs/allocation-input-builder";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const PROVIDER_ENTITY = "33333333-3333-3333-3333-333333333333";

// A live M26 cap aggregate (cap year FY2026): cents-as-string, the M26 CapAccrualReader shape.
const boundCap: CapAggregateSeam = {
  async aggregateForCostReport() {
    return {
      aggregateCapCents: "5000000",
      aggregatePaymentsCents: "5750000",
      inpatientDays: 120,
      totalMedicareDays: 1000,
    };
  },
};

describe.skipIf(!DB_URL)("M27 AllocationInputBuilder — LIVE Postgres (§3.1 / D8)", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let reportId: string;

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
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
    // Worksheet A — two direct cost centers (the step-down pool).
    await admin.query(
      `INSERT INTO cost_report_worksheet (organization_id, cost_report_id, worksheet_code, data)
       VALUES ($1,$2,'A',$3)`,
      [
        ORG,
        reportId,
        JSON.stringify({
          costCenters: [
            { code: "D1", name: "Nursing", totalCostsCents: 200_000 },
            { code: "D2", name: "Pharmacy", totalCostsCents: 300_000 },
          ],
        }),
      ],
    );
    // Worksheet C — one ancillary center (RCC apportionment input).
    await admin.query(
      `INSERT INTO cost_report_worksheet (organization_id, cost_report_id, worksheet_code, data)
       VALUES ($1,$2,'C',$3)`,
      [
        ORG,
        reportId,
        JSON.stringify({
          ancillaryCostCenters: [
            { code: "ANC1", name: "PT", fullyAllocatedCostCents: 80_000, totalChargesCents: 100_000, medicareChargesCents: 60_000 },
          ],
        }),
      ],
    );
    // Worksheet E-1 — the settlement Medicare line (allowable + interim payments).
    await admin.query(
      `INSERT INTO cost_report_worksheet (organization_id, cost_report_id, worksheet_code, data)
       VALUES ($1,$2,'E-1',$3)`,
      [ORG, reportId, JSON.stringify({ medicare: { allowablePaymentCents: 4_000_000, interimPaymentsReceivedCents: 3_500_000 } })],
    );
    // statistic_data — a one-month RHC/GIP census driving Worksheet D.
    await admin.query(
      `INSERT INTO statistic_data (organization_id, cost_report_id, monthly_breakdown,
         visit_counts_by_discipline, fte_calculations, bereavement_census)
       VALUES ($1,$2,$3,'{}','{}',$4)`,
      [
        ORG,
        reportId,
        JSON.stringify({
          "2026-01": {
            rhc: { medicare: { patientDays: 30 }, medicaid: { patientDays: 5 } },
            gip: { medicare: { patientDays: 4 } },
          },
        }),
        JSON.stringify({ contactsCount: 0, visitsCount: 0 }),
      ],
    );
    handle = createDbClient({ connectionString: DB_URL! });
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (admin) await admin.end();
  });

  it("shapes the four inputs from the worksheet jsonb + census and the chain ties out", async () => {
    const builder = buildM27AllocationInputs({ capResolver: () => boundCap });
    const inputs = await withOrgContext(handle.db, { organizationId: ORG, userId: USER }, (tx) =>
      builder.build({ organizationId: ORG, costReportId: reportId, tx }),
    );

    // Step-down: A's two centers (direct), pool conserved.
    expect(inputs.stepDown.costCenters.map((c) => c.code)).toEqual(["D1", "D2"]);
    const b = stepDownAllocate(inputs.stepDown);
    expect(b.tiesOut).toBe(true);
    expect(b.totalAllocatedToDirectCents).toBe(500_000);

    // Ancillary: C's RCC = 0.8 → Medicare cost 48_000.
    const c = apportionAncillary(inputs.ancillary);
    expect(c.centers[0]!.programLines[0]!.apportionedCostCents).toBe(48_000);

    // Program: 3 cells (rhc/medicare, rhc/medicaid, gip/medicare) from the census.
    expect(inputs.program.patientDays).toHaveLength(3);
    expect(apportionToPrograms(inputs.program).cells).toHaveLength(3);

    // Settlement: E-1 allowable/interim + the live M26 cap → cap lines present, balance computed.
    expect(inputs.settlement.medicareAllowableCostCents).toBe(4_000_000);
    expect(inputs.settlement.interimPaymentsCents).toBe(3_500_000);
    const s = computeSettlement(inputs.settlement);
    expect(s.capPositionPending).toBe(false);
    expect(s.aggregateCap!.overageCents).toBe(750_000);
    expect(s.balanceDueToProviderCents).toBe(4_000_000 - 750_000 - 3_500_000); // -250_000 owed back
  });

  it("write-back: the recompute persists the four derived worksheets (B/C/D/E-1) with computed_at", async () => {
    const builder = buildM27AllocationInputs({ capResolver: () => boundCap });
    const computedAt = new Date("2026-12-01T00:00:00Z");

    // Replicate the worker's write-back path through the public API (build → pure chain → mapper → repo upsert).
    // The worker carries the empty-string SYSTEM user (the M4 write-audit trigger NULLIFs it → NULL actor).
    await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, async (tx) => {
      const inputs = await builder.build({ organizationId: ORG, costReportId: reportId, tx });
      const payloads = allocationResultsToWorksheets({
        stepDown: stepDownAllocate(inputs.stepDown),
        ancillary: apportionAncillary(inputs.ancillary),
        program: apportionToPrograms(inputs.program),
        settlement: computeSettlement(inputs.settlement),
        settlementInput: inputs.settlement,
      });
      const repo = new CostReportWorksheetRepository(tx);
      for (const code of ["B", "C", "D", "E-1"] as const) {
        // Upsert exactly as the worker does: lazy-create B/D, replace the seeded C/E-1 input rows in place.
        const existing = await repo.findByReportAndCode(reportId, code);
        if (existing) {
          const res = await repo.updateWithVersion(existing.id, existing.version, { data: payloads[code], computedAt });
          expect(res.ok).toBe(true);
        } else {
          await repo.create({ organizationId: ORG, costReportId: reportId, worksheetCode: code, data: payloads[code], computedAt });
        }
      }
    });

    // Read the persisted derived worksheets back over RLS.
    const rows = await withOrgContext(handle.db, { organizationId: ORG, userId: USER }, (tx) =>
      new CostReportWorksheetRepository(tx).listByReport(ORG, reportId),
    );
    const byCode = new Map(rows.map((r) => [r.worksheetCode, r]));
    for (const code of ["B", "C", "D", "E-1"] as const) {
      const row = byCode.get(code);
      expect(row, `worksheet ${code} persisted`).toBeDefined();
      expect(row!.computedAt).not.toBeNull();
    }
    // B totals + E-1 cap overage landed in the jsonb verbatim.
    const b = byCode.get("B")!.data as { totalFullyAllocatedCostCents: number };
    expect(b.totalFullyAllocatedCostCents).toBe(500_000);
    const e1 = byCode.get("E-1")!.data as { medicare: { capOverpaymentCents: number } };
    expect(e1.medicare.capOverpaymentCents).toBe(750_000);
  });
});
