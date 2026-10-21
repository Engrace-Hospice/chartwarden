// @chartwarden/reporting — consumed-seam view of M19 (After-Hours Triage). ABSENT producer (§4.4).
//
// M19 is not yet implemented → forward-seam DENY-STUB. M19 registers the real `TriageCallMetricsProvider`
// over this stub when it lands (P2C).
import { FORWARD_SEAM_UNAVAILABLE, type ForwardSeamMetric } from "./forward-seam";

export interface ReportingTriageConsumer {
  /** M19 `TriageCallMetricsProvider` — triage-call volume + disposition rollup (forward seam). */
  triageCallMetrics(organizationId: string): Promise<ForwardSeamMetric>;
}

export const denyStubReportingTriageConsumer: ReportingTriageConsumer = {
  async triageCallMetrics(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
};
