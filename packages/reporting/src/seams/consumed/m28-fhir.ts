// @chartwarden/reporting — consumed-seam view of M28 (FHIR Gateway). ABSENT producer (§4.4).
//
// M28 is not yet implemented → forward-seam DENY-STUB. M28 registers the real `FhirGatewayMetricsProvider`
// over this stub when it lands (P2C).
import { FORWARD_SEAM_UNAVAILABLE, type ForwardSeamMetric } from "./forward-seam";

export interface ReportingFhirConsumer {
  /** M28 `FhirGatewayMetricsProvider` — FHIR gateway request + error-rate rollup (forward seam). */
  fhirGatewayMetrics(organizationId: string): Promise<ForwardSeamMetric>;
}

export const denyStubReportingFhirConsumer: ReportingFhirConsumer = {
  async fhirGatewayMetrics(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
};
