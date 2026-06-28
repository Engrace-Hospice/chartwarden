// @wardenx/quality — consumed-seam view of M27 (Cost Report). ABSENT producer (§4.4).
//
// M27 is not yet implemented → forward-seam DENY-STUB (M30 `dependsOn` 27). M30 consumes
// `CostReportProvider.filingStatusForOrg` for the CoP 418.310 compliance indicator (failure to file the
// cost report is grounds for termination); the wire is one-way M30←M27 read-only. M27 registers the real
// reader over this stub when it lands (P2C). Never fails open (D6 / D13).
import { FORWARD_SEAM_UNAVAILABLE, type ForwardSeamMetric } from "./forward-seam";

export interface QualityCostReportConsumer {
  /** M27 `CostReportProvider.filingStatusForOrg` — cost-report filing status (CoP 418.310, forward seam). */
  filingStatusForOrg(organizationId: string): Promise<ForwardSeamMetric>;
}

export const denyStubQualityCostReportConsumer: QualityCostReportConsumer = {
  async filingStatusForOrg(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
};
