// @chartwarden/reporting — consumed-seam view of M27 (Cost Report). ABSENT producer (§4.4).
//
// M27 is not yet implemented → forward-seam DENY-STUB. M27 registers the real
// `CostReportFilingStatusReader` / `CostReportProvider` / `CostReportValidationReader` over this stub
// when it lands (P2C).
import type { ForwardSeamMetric } from "./forward-seam";

export interface ReportingCostReportConsumer {
  /** M27 `CostReportFilingStatusReader` — filing-status rollup (forward seam). */
  filingStatus(organizationId: string): Promise<ForwardSeamMetric>;
  /** M27 `CostReportProvider` — cost-report worksheet aggregate (forward seam). */
  costReportAggregate(organizationId: string): Promise<ForwardSeamMetric>;
  /** M27 `CostReportValidationReader` — validation-finding rollup (forward seam). */
  validationFindings(organizationId: string): Promise<ForwardSeamMetric>;
}
