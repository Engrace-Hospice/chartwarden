// @wardenx/quality — consumed-seam view of M23 (Billing — Medicare). §4.4.
//
// M23 is BUILT, so this is no longer a pure forward seam: the composition root binds these methods over
// M23's live `ClaimLineReader` / `PatientDaysProvider` (P2C). Each method still returns a UNION with the
// forward-seam marker, because the two are independently bindable — a boot with no db, or a producer that
// has not registered, degrades THAT method to suppressed without dragging the other down with it. The HCI
// never fabricates a claims number (D6 / D13).
import { FORWARD_SEAM_UNAVAILABLE, type ForwardSeamMetric } from "./forward-seam";

/** A period the claims-derived reads are scoped to (inclusive ISO dates). */
export interface QualityPeriod {
  readonly from: string;
  readonly to: string;
}

/**
 * The per-LOC billed-day rollup the HCI claims-derived indicators read. Carries `claimLineCount` — the
 * per-diem LINE population — because M30's measure kernel suppresses a rate whose DENOMINATOR is below the
 * CMS reportable floor, and a day TOTAL is not a population.
 */
export interface QualityClaimLineRollup {
  readonly totalPatientDays: number;
  readonly rhcDays: number;
  readonly chcDays: number;
  readonly ircDays: number;
  readonly gipDays: number;
  readonly claimLineCount: number;
  readonly isForwardSeamDenyStub: false;
}

/** The Medicare patient-day aggregate (the HCI denominator base). */
export interface QualityPatientDays {
  readonly totalPatientDays: number;
  readonly isForwardSeamDenyStub: false;
}

export interface QualityBillingConsumer {
  /** M23 `ClaimLineReader.claimLineRollupForPeriod` — per-LOC billed days + line population. */
  claimLineRollup(
    organizationId: string,
    period: QualityPeriod,
  ): Promise<QualityClaimLineRollup | ForwardSeamMetric>;
  /** M23 `PatientDaysProvider.billedDaysForFiscalYear` — Medicare patient-days over the period. */
  patientDays(
    organizationId: string,
    period: QualityPeriod,
  ): Promise<QualityPatientDays | ForwardSeamMetric>;
}

export const denyStubQualityBillingConsumer: QualityBillingConsumer = {
  async claimLineRollup(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
  async patientDays(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
};
