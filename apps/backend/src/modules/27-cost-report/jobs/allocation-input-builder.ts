// apps/backend/src/modules/27-cost-report/jobs/allocation-input-builder.ts — the LIVE M27
// AllocationInputBuilder (Form CMS-1984-14 §4320/§4330, D8 `cost-allocation-recompute`). Reads M27's
// materialized worksheet state + the monthly statistics census through the @wardenx/cost-report repos on the
// worker's org-scoped `tx` (the worker wraps the run in withOrgContext), and hands the raw facts to the PURE
// `assembleAllocationInputs`. The hospice chain is A (+ A-1…A-4) → B step-down (on the B-1 statistical basis)
// → C per-diem cost; there is no cap/settlement worksheet (that is M26's domain), so this builder takes no
// cap resolver.
import {
  type AllocationInputs,
  CostReportWorksheetRepository,
  StatisticDataRepository,
  assembleAllocationInputs,
} from "@wardenx/cost-report";
import type { DbClient } from "@wardenx/db";
import type { AllocationInputBuilder } from "./m27-jobs";

/** Build the live AllocationInputBuilder. `build({ organizationId, costReportId, tx })` materializes the
 *  step-down + per-diem inputs from M27's worksheet/statistics state. */
export function buildM27AllocationInputs(): AllocationInputBuilder {
  return {
    async build({ organizationId, costReportId, tx }): Promise<AllocationInputs> {
      const db = tx as DbClient;
      const [worksheets, statistic] = await Promise.all([
        new CostReportWorksheetRepository(db).listByReport(organizationId, costReportId),
        new StatisticDataRepository(db).findByReport(organizationId, costReportId),
      ]);

      return assembleAllocationInputs({
        worksheets: worksheets.map((w) => ({ worksheetCode: w.worksheetCode, data: w.data })),
        monthlyBreakdown: statistic ? statistic.monthlyBreakdown : null,
      });
    },
  };
}
