// @chartwarden/reporting — consumed-seam view of M24 (Medicaid / Room & Board). ABSENT producer (§4.4).
//
// M24 is not yet implemented → forward-seam DENY-STUB. M24 registers the real `MedicaidClaimReader` /
// `MedicaidClaimMetricsProvider` / `StateChannelHealthReader` over this stub when it lands (P2C).
import type { ForwardSeamMetric } from "./forward-seam";

export interface ReportingMedicaidConsumer {
  /** M24 `MedicaidClaimReader` — Medicaid claim volume + status rollup (forward seam). */
  medicaidClaimRollup(organizationId: string): Promise<ForwardSeamMetric>;
  /** M24 `MedicaidClaimMetricsProvider` — billed/paid aggregate over a window (forward seam). */
  medicaidClaimMetrics(organizationId: string): Promise<ForwardSeamMetric>;
  /** M24 `StateChannelHealthReader` — per-state channel health rollup (forward seam). */
  stateChannelHealth(organizationId: string): Promise<ForwardSeamMetric>;
}
