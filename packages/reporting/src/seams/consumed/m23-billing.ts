// @chartwarden/reporting — consumed-seam view of M23 (Billing — Medicare). ABSENT producer (§4.4).
//
// M23 is not yet implemented → forward-seam DENY-STUB. M23 registers the real `ClaimReader` /
// `ClaimMetricsProvider.windowAggregate` over this stub when it lands (P2C).
import type { ForwardSeamMetric } from "./forward-seam";

export interface ReportingBillingConsumer {
  /** M23 `ClaimReader` — claim volume + status rollup (forward seam). */
  claimRollup(organizationId: string): Promise<ForwardSeamMetric>;
  /** M23 `ClaimMetricsProvider.windowAggregate` — billed/paid amount aggregate over a window (forward seam). */
  claimWindowAggregate(organizationId: string): Promise<ForwardSeamMetric>;
}
