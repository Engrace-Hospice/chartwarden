// @chartwarden/reporting — consumed-seam view of M20 (Field Safety). ABSENT producer (§4.4).
//
// M20 is not yet implemented → forward-seam DENY-STUB. M20 registers the real `FieldSafetyMetricsProvider`
// over this stub when it lands (P2C).
import { FORWARD_SEAM_UNAVAILABLE, type ForwardSeamMetric } from "./forward-seam";

export interface ReportingFieldSafetyConsumer {
  /** M20 `FieldSafetyMetricsProvider` — field-safety incident + check-in rollup (forward seam). */
  fieldSafetyMetrics(organizationId: string): Promise<ForwardSeamMetric>;
}

export const denyStubReportingFieldSafetyConsumer: ReportingFieldSafetyConsumer = {
  async fieldSafetyMetrics(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
};
