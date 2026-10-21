// @chartwarden/reporting — consumed-seam view of M26 (Cap Management). ABSENT producer (§4.4).
//
// M26 is not yet implemented → forward-seam DENY-STUB. M26 registers the real `CapAccrualReader` /
// `CapProjectionProvider` / `InpatientCapProvider` / `CapSettlementProvider` / `CapMetricsProvider` over
// this stub when it lands (P2C).
import { FORWARD_SEAM_UNAVAILABLE, type ForwardSeamMetric } from "./forward-seam";

export interface ReportingCapConsumer {
  /** M26 `CapAccrualReader` — aggregate cap accrual to date (forward seam). */
  capAccrual(organizationId: string): Promise<ForwardSeamMetric>;
  /** M26 `CapProjectionProvider` — projected year-end cap position (forward seam). */
  capProjection(organizationId: string): Promise<ForwardSeamMetric>;
  /** M26 `InpatientCapProvider` — inpatient-cap utilization (forward seam). */
  inpatientCap(organizationId: string): Promise<ForwardSeamMetric>;
  /** M26 `CapSettlementProvider` — settlement-status rollup (forward seam). */
  capSettlement(organizationId: string): Promise<ForwardSeamMetric>;
  /** M26 `CapMetricsProvider` — cap KPI rollup (forward seam). */
  capMetrics(organizationId: string): Promise<ForwardSeamMetric>;
}

export const denyStubReportingCapConsumer: ReportingCapConsumer = {
  async capAccrual(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
  async capProjection(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
  async inpatientCap(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
  async capSettlement(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
  async capMetrics(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
};
