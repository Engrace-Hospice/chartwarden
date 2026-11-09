// @chartwarden/reporting — consumed-seam view of M16 (Bereavement). ABSENT producer (§4.4).
//
// M16 is not yet implemented → forward-seam DENY-STUB (resolves `FORWARD_SEAM_UNAVAILABLE`, never fails
// open). M16 registers the real `BereavementOutreachProvider` / `BereavementRiskTierProvider` /
// `BereavementPlanProvider` over this stub when it lands (P2C).
import type { ForwardSeamMetric } from "./forward-seam";

export interface ReportingBereavementConsumer {
  /** M16 `BereavementOutreachProvider` — outreach-contact volume (forward seam). */
  outreachVolume(organizationId: string): Promise<ForwardSeamMetric>;
  /** M16 `BereavementRiskTierProvider` — risk-tier distribution (forward seam). */
  riskTierDistribution(organizationId: string): Promise<ForwardSeamMetric>;
  /** M16 `BereavementPlanProvider` — active bereavement-plan count (forward seam). */
  activePlanCount(organizationId: string): Promise<ForwardSeamMetric>;
}
