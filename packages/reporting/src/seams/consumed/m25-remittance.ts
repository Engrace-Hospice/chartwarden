// @chartwarden/reporting — consumed-seam view of M25 (Remittance / Denials). ABSENT producer (§4.4).
//
// M25 is not yet implemented → forward-seam DENY-STUB. M25 registers the real `DenialMetricsProvider` /
// `RemittanceReader` over this stub when it lands (P2C).
import { FORWARD_SEAM_UNAVAILABLE, type ForwardSeamMetric } from "./forward-seam";

export interface ReportingRemittanceConsumer {
  /** M25 `DenialMetricsProvider` — denial rate + reason rollup (forward seam). */
  denialMetrics(organizationId: string): Promise<ForwardSeamMetric>;
  /** M25 `RemittanceReader` — remittance posting + AR aggregate (forward seam). */
  remittanceRollup(organizationId: string): Promise<ForwardSeamMetric>;
}

export const denyStubReportingRemittanceConsumer: ReportingRemittanceConsumer = {
  async denialMetrics(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
  async remittanceRollup(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
};
