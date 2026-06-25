// @wardenx/reporting — the `MetricsProvider` PUBLISHED seam (M33 §4.3).
//
// The single-metric / bulk-metric read surface M33 publishes for embedded dashboard tiles.
// Consumed by M30 (HQRP measure-detail embedding), M34 (tenant ops console), M37 (IPU dashboard
// embedding). Every M33 read is aggregate-by-default (D6 — no row-level PHI crosses this seam) and
// scoped to `organizationId`. Registered into the M1 SeamRegistry at boot (P2C); `validateSeams()`
// fails closed (D13) if the real provider is never registered over the deny-stub.

/** Consumed by M30 (HQRP measure-detail embedding), M34 (tenant ops console), M37 (IPU dashboard embedding). */
export interface MetricsProvider {
  /**
   * Read a single metric value at a given as-of time, scoped to org_id.
   * Returns null if the metric is not yet materialized (e.g., a forward-seam MV).
   */
  getDashboardMetric(params: {
    metricKey: string;
    organizationId: string;
    asOf?: string; // ISO; defaults to now
    period?: { from: string; to: string }; // ISO range; required for windowed metrics
    dimensions?: Record<string, string>; // additional filter on a single dimension value
  }): Promise<{
    metricKey: string;
    value: number | null;
    unit: string;
    rowCount: number;
    asOf: string;
    dataFreshnessSeconds: number;
    isForwardSeamDenyStub: boolean;
  }>;

  /**
   * Bulk read for embedded surfaces. Limited to 50 metrics per call.
   */
  getDashboardMetricsBulk(params: {
    metricKeys: string[];
    organizationId: string;
    asOf?: string;
    period?: { from: string; to: string };
  }): Promise<{ metricKey: string; value: number | null; unit: string }[]>;
}
