// @wardenx/quality — consumed-seam view of M16 (Bereavement). ABSENT producer (§4.4).
//
// M16 is not yet implemented → forward-seam DENY-STUB. M30 consumes `BereavementComplianceProvider` for
// the CoP 418.64(d) bereavement-services-coverage measure; M16 registers the real reader over this stub
// when it lands (P2C). CAHPS sampling is M30-owned via the death outbox event — NOT gated on M16. Never
// fails open (D6).
import { FORWARD_SEAM_UNAVAILABLE, type ForwardSeamMetric } from "./forward-seam";

export interface QualityBereavementConsumer {
  /** M16 `BereavementComplianceProvider` — bereavement-services-coverage rate (forward seam). */
  bereavementCoverageRate(organizationId: string): Promise<ForwardSeamMetric>;
}

export const denyStubQualityBereavementConsumer: QualityBereavementConsumer = {
  async bereavementCoverageRate(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
};
