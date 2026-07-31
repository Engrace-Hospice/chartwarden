// @wardenx/quality — consumed-seam view of M17 (Scheduling). PRESENT producer (§4.4).
//
// M30 consumes M17's `VisitMetricsProvider.getVisitOnTimeRate` and `getVisitCompletionRate` for the
// visit-quality measures; it does NOT write to M17. Aggregate-by-default (D6). Bound via `getSeam` (P2C).
export interface QualitySchedulingConsumer {
  /** M17 `VisitMetricsProvider.getVisitOnTimeRate` — visit-on-time rate over a window. */
  visitOnTimeRate(organizationId: string, period: { from: string; to: string }): Promise<number>;
  /**
   * M17 `VisitMetricsProvider.getOnTimeVisitCounts` — the on-time POPULATION, which is what the
   * `visit_on_time_rate` measure needs. The rate above cannot drive a CMS-reportable measure: the
   * denominator is what triggers small-N suppression, and a rate has thrown it away.
   */
  visitOnTimeCounts(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<{ numerator: number; denominator: number }>;
  /** M17 `VisitMetricsProvider.getVisitCompletionRate` — visit-completion rate over a window. */
  visitCompletionRate(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<number>;
}
