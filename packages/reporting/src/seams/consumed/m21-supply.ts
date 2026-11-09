// @chartwarden/reporting — consumed-seam view of M21 (Supply / DME / Pharmacy). ABSENT producer (§4.4).
//
// M21 is not yet implemented → forward-seam DENY-STUB. M21 registers the real `SupplyMetricsProvider` /
// `VendorVarianceReader` over this stub when it lands (P2C).
import type { ForwardSeamMetric } from "./forward-seam";

export interface ReportingSupplyConsumer {
  /** M21 `SupplyMetricsProvider` — supply/DME spend rollup (forward seam). */
  supplyMetrics(organizationId: string): Promise<ForwardSeamMetric>;
  /** M21 `VendorVarianceReader` — vendor cost-variance rollup (forward seam). */
  vendorVariance(organizationId: string): Promise<ForwardSeamMetric>;
}
