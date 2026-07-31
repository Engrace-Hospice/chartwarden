// @wardenx/quality — consumed-seam view of M27 (Cost Report). §4.4.
//
// M27 is BUILT, so the composition root binds this over M27's live `CostReportFilingStatusReader` (P2C).
// M30 reads it for the CoP 418.310 compliance indicator — 42 CFR 418.310 makes failure to file a cost
// report grounds for TERMINATION, so the quality module needs the filing POSTURE, never the worksheet
// content. One-way M30←M27 read-only. Unbound degrades to suppressed, never fails open (D6 / D13).
import { FORWARD_SEAM_UNAVAILABLE, type ForwardSeamMetric } from "./forward-seam";

/**
 * The org's cost-report filing posture, already reduced to the pair the compliance indicator needs:
 * how many of the org's provider entities are past their filing deadline and still unfiled, out of how
 * many were assessed. `providerEntitiesAssessed` is the DENOMINATOR — an org with no cost report on file
 * at all yields 0/0 and the measure suppresses rather than reporting a spurious 0% non-compliance.
 */
export interface QualityFilingPosture {
  readonly pastDeadlineUnfiled: number;
  readonly providerEntitiesAssessed: number;
  readonly isForwardSeamDenyStub: false;
}

export interface QualityCostReportConsumer {
  /** M27 `CostReportFilingStatusReader.filingStatusForOrg` — filing posture (CoP 418.310). */
  filingStatusForOrg(
    organizationId: string,
  ): Promise<QualityFilingPosture | ForwardSeamMetric>;
}

export const denyStubQualityCostReportConsumer: QualityCostReportConsumer = {
  async filingStatusForOrg(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
};
