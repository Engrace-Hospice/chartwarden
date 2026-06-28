// @wardenx/quality — consumed-seam view of M23 (Billing — Medicare). ABSENT producer (§4.4).
//
// M23 is not yet implemented → forward-seam DENY-STUB (M30 `dependsOn` 23). M30 consumes `ClaimLineReader`
// and `PatientDaysProvider` for the HCI claims-derived indicators; M23 registers the real readers over this
// stub when it lands (P2C). The HCI never fabricates a claims number — an absent M23 leaves the
// claims-derived indicators suppressed, never fails open (D6 / D13).
import { FORWARD_SEAM_UNAVAILABLE, type ForwardSeamMetric } from "./forward-seam";

export interface QualityBillingConsumer {
  /** M23 `ClaimLineReader` — claim-line rollup for the HCI claims-derived indicators (forward seam). */
  claimLineRollup(organizationId: string): Promise<ForwardSeamMetric>;
  /** M23 `PatientDaysProvider` — Medicare patient-days aggregate (the HCI denominator base, forward seam). */
  patientDays(organizationId: string): Promise<ForwardSeamMetric>;
}

export const denyStubQualityBillingConsumer: QualityBillingConsumer = {
  async claimLineRollup(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
  async patientDays(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
};
