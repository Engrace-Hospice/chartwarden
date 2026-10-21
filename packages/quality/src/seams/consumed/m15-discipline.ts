// @chartwarden/quality — consumed-seam view of M15 (Discipline Care Plans). ABSENT producer (§4.4).
//
// M15 is not yet implemented → forward-seam DENY-STUB. M30 consumes `DisciplineComplianceProvider` for
// the supervisory-on-time / MSW-assessment-on-time / chaplain-assessment-on-time / volunteer-compliance
// quality measures; M15 registers the real reader over this stub when it lands (P2C). Never fails open (D6).
import { FORWARD_SEAM_UNAVAILABLE, type ForwardSeamMetric } from "./forward-seam";

export interface QualityDisciplineConsumer {
  /** M15 `DisciplineComplianceProvider` — discipline on-time-compliance rollup (forward seam). */
  disciplineComplianceRollup(organizationId: string): Promise<ForwardSeamMetric>;
}

export const denyStubQualityDisciplineConsumer: QualityDisciplineConsumer = {
  async disciplineComplianceRollup(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
};
