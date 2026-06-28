// @wardenx/quality — consumed-seam view of M33 (Reporting & Dashboards). PRESENT producer (§4.4).
//
// M30 embeds M33 dashboard metrics on the HQRP measure-detail surface via M33's PUBLISHED
// `MetricsProvider` seam — the single-metric read M33 exposes for embedded surfaces (aggregate-only,
// org-scoped, D6). Consumer-defined interface bound to the live `MetricsProvider` via `getSeam` at boot
// (P2C); a not-yet-materialized metric resolves M33's own forward-seam deny-stub (`value:null`), which
// M30 surfaces as "not available" rather than fabricating a number.
export interface QualityMetricsConsumer {
  /**
   * M33 `MetricsProvider.getDashboardMetric` — a single dashboard metric value for an org at an as-of
   * time. `value` is `null` when M33's metric is not yet materialized (its own forward-seam deny-stub).
   */
  getDashboardMetric(params: {
    metricKey: string;
    organizationId: string;
    asOf?: string;
    period?: { from: string; to: string };
  }): Promise<{ metricKey: string; value: number | null; unit: string }>;
}
