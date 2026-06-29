// apps/backend/src/modules/27-cost-report/jobs/allocation-input-builder.ts — the LIVE M27
// AllocationInputBuilder (§3.1 / D8 / §4.8 `cost-allocation-recompute`). Reads M27's materialized worksheet
// state + the monthly statistics census through the @wardenx/cost-report repos on the worker's org-scoped
// `tx` (the worker wraps the run in withOrgContext), resolves the live M26 cap context (via resolveCapContext),
// and hands the raw facts to the PURE `assembleAllocationInputs`. The cap resolver is injected as a PORT so
// this unit-tests without the M1 registry; the composition root binds the live one (`m27CapSeamResolver`).
//
// Fail-soft on the cap lookup (a deny-stub throw → capContext null → the settlement cap lines SKIP, per D13).
import {
  type AllocationInputs,
  assembleAllocationInputs,
  CostReportRepository,
  CostReportWorksheetRepository,
  StatisticDataRepository,
} from "@wardenx/cost-report";
import type { DbClient } from "@wardenx/db";
import { NotFoundError } from "@wardenx/types";
import type { CapSeamResolver } from "../routes/cap-context";
import { resolveCapContext } from "../routes/cap-context";
import type { AllocationInputBuilder } from "./m27-jobs";

export interface M27AllocationInputDeps {
  /** Resolves M26's `CapAccrualReader` (production: `m27CapSeamResolver`). */
  readonly capResolver: CapSeamResolver;
}

/** Build the live AllocationInputBuilder. `build({ organizationId, costReportId, tx })` materializes the four
 *  allocation inputs from M27's DB state + the live M26 cap; cap-gated settlement lines SKIP when M26 is unbound. */
export function buildM27AllocationInputs(deps: M27AllocationInputDeps): AllocationInputBuilder {
  return {
    async build({ organizationId, costReportId, tx }): Promise<AllocationInputs> {
      const db = tx as DbClient;
      const report = await new CostReportRepository(db).findById(costReportId);
      if (!report) throw new NotFoundError("cost report not found");
      const fiscalYearInt = Number(String(report.fiscalYearEndDate).slice(0, 4));

      const [worksheets, statistic] = await Promise.all([
        new CostReportWorksheetRepository(db).listByReport(organizationId, costReportId),
        new StatisticDataRepository(db).findByReport(organizationId, costReportId),
      ]);

      // M26 cap (live): the cost-report cap year is the federal FY of the FYE year (the cap calc's window).
      const cap = await resolveCapContext(deps.capResolver, organizationId, `FY${fiscalYearInt}`);

      return assembleAllocationInputs({
        fiscalYearInt,
        worksheets: worksheets.map((w) => ({ worksheetCode: w.worksheetCode, data: w.data })),
        monthlyBreakdown: statistic ? statistic.monthlyBreakdown : null,
        cap: { capContext: cap.capContext },
      });
    },
  };
}
