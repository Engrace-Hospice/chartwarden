/**
 * M27 AllocationInputBuilder — LIVE Postgres proof (Form CMS-1984-14 §4320/§4330 `cost-allocation-recompute`).
 *
 * Proves the worksheet → input shaper + the A → B/B-1 → C chain end-to-end against real Postgres under RLS:
 * seed an org + a cost report + the input worksheets (A general-service center, A-2 RHC direct cost, B-1
 * statistical basis) + the statistic_data census, build the inputs over a live org-scoped tx, run the
 * step-down + per-diem, write back Worksheets B + C, and assert Worksheet C ties Worksheet B.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m27-allocation-input.live.test.ts
 * (SUPERUSER to a THROWAWAY db; for a local PG without pgvector set WARDENX_TEST_NO_PGVECTOR=1.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  allocationResultsToWorksheets,
  buildPerDiemInput,
  calculatePerDiem,
  CostReportWorksheetRepository,
  stepDownAllocate,
} from "@wardenx/cost-report";
import { createDbClient, type DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildM27AllocationInputs } from "../src/modules/27-cost-report/jobs/allocation-input-builder";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const PROVIDER_ENTITY = "33333333-3333-3333-3333-333333333333";

describe.skipIf(!DB_URL)("M27 AllocationInputBuilder — LIVE Postgres (§4320/§4330)", () => {
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
    await admin.query("INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')", [ORG]);
    reportId = (
      await admin.query(
        `INSERT INTO cost_report (organization_id, provider_entity_id, fiscal_year_start_date,
           fiscal_year_end_date, state, bad_debt_claimed, wage_source)
         VALUES ($1,$2,'2025-10-01','2026-09-30','draft',false,'manual') RETURNING id`,
        [ORG, PROVIDER_ENTITY],
      )
    ).rows[0].id as string;
    // Worksheet A — one general-service (overhead) center.
    await admin.query(
      `INSERT INTO cost_report_worksheet (organization_id, cost_report_id, worksheet_code, data) VALUES ($1,$2,'A',$3)`,
      [ORG, reportId, JSON.stringify({ costCenters: [{ code: "AG", name: "A&G", totalCostsCents: 100_000 }] })],
    );
    // Worksheet A-2 — the RHC direct-care net cost.
    await admin.query(
      `INSERT INTO cost_report_worksheet (organization_id, cost_report_id, worksheet_code, data) VALUES ($1,$2,'A-2',$3)`,
      [ORG, reportId, JSON.stringify({ netDirectCostCents: 400_000 })],
    );
    // Worksheet B-1 — the statistical basis (AG allocates entirely onto RHC).
    await admin.query(
      `INSERT INTO cost_report_worksheet (organization_id, cost_report_id, worksheet_code, data) VALUES ($1,$2,'B-1',$3)`,
      [
        ORG,
        reportId,
        JSON.stringify({
          columns: [{ generalServiceCostCenterCode: "AG", allocationBasis: "square_feet", statisticalPortions: [{ receivingCenterCode: "RHC", statisticValue: 1 }] }],
        }),
      ],
    );
    // statistic_data — an RHC census (100 days: 60 Medicare, 40 Medicaid).
    await admin.query(
      `INSERT INTO statistic_data (organization_id, cost_report_id, monthly_breakdown,
         visit_counts_by_discipline, fte_calculations, bereavement_census)
       VALUES ($1,$2,$3,'{}','{}',$4)`,
      [
        ORG,
        reportId,
        JSON.stringify({ "2026-01": { rhc: { medicare: { patientDays: 60 }, medicaid: { patientDays: 40 } } } }),
        JSON.stringify({ contactsCount: 0, visitsCount: 0 }),
      ],
    );
    handle = createDbClient({ connectionString: DB_URL! });
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (admin) await admin.end();
  });

  it("shapes the inputs, runs A→B→C, and persists B + C with C tying B (over RLS)", async () => {
    const builder = buildM27AllocationInputs();
    await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, async (tx) => {
      const inputs = await builder.build({ organizationId: ORG, costReportId: reportId, tx });
      const step = stepDownAllocate(inputs.stepDown);
      const perDiem = calculatePerDiem(buildPerDiemInput(step, inputs.locDays));
      const payloads = allocationResultsToWorksheets({ stepDown: step, perDiem, stepDownColumns: inputs.stepDownColumns });
      const repo = new CostReportWorksheetRepository(tx);
      const computedAt = new Date("2026-12-01T00:00:00Z");
      for (const code of ["B", "C"] as const) {
        const existing = await repo.findByReportAndCode(reportId, code);
        if (existing) await repo.updateWithVersion(existing.id, existing.version, { data: payloads[code], computedAt });
        else await repo.create({ organizationId: ORG, costReportId: reportId, worksheetCode: code, data: payloads[code], computedAt });
      }
    });

    const rows = await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
      new CostReportWorksheetRepository(tx).listByReport(ORG, reportId),
    );
    const byCode = new Map(rows.map((r) => [r.worksheetCode, r]));
    // Worksheet B: AG's 100_000 folds entirely into RHC → 500_000 fully allocated.
    const b = byCode.get("B")!.data as { totalFullyAllocatedCostCents: number };
    expect(b.totalFullyAllocatedCostCents).toBe(500_000);
    // Worksheet C: per diem = 500_000 / 100 = 5000 → Medicare 60d = 300_000, Medicaid 40d = 200_000; ties B.
    const c = byCode.get("C")!.data as {
      routineHomeCare: { medicareCostCents: number; medicaidCostCents: number };
      totalHospiceCostCents: number;
      tiesToWorksheetBTotal: boolean;
    };
    expect(c.routineHomeCare.medicareCostCents).toBe(300_000);
    expect(c.routineHomeCare.medicaidCostCents).toBe(200_000);
    expect(c.totalHospiceCostCents).toBe(500_000);
    expect(c.tiesToWorksheetBTotal).toBe(true);
    expect(byCode.get("B")!.computedAt).not.toBeNull();
  });
});
