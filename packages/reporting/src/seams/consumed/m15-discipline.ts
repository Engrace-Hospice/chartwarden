// @wardenx/reporting — consumed-seam view of M15 (Discipline Care Plans / Volunteers). ABSENT (§4.4).
//
// M15 is not yet implemented, so M33 ships a forward-seam DENY-STUB: every read resolves to the typed
// `FORWARD_SEAM_UNAVAILABLE` marker (never throws, never fails open). When M15 lands it registers the
// real `DisciplineComplianceProvider` / `VolunteerCostSavingsProvider` over this stub (P2C).
import { FORWARD_SEAM_UNAVAILABLE, type ForwardSeamMetric } from "./forward-seam";

export interface ReportingDisciplineConsumer {
  /** M15 `DisciplineComplianceProvider` — discipline-plan compliance rollup (forward seam). */
  disciplineComplianceRollup(organizationId: string): Promise<ForwardSeamMetric>;
  /** M15 `VolunteerCostSavingsProvider` — volunteer cost-savings total (forward seam). */
  volunteerCostSavings(organizationId: string): Promise<ForwardSeamMetric>;
}

export const denyStubReportingDisciplineConsumer: ReportingDisciplineConsumer = {
  async disciplineComplianceRollup(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
  async volunteerCostSavings(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
};
