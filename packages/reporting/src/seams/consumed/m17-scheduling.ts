// @wardenx/reporting — consumed-seam view of M17 (Scheduling & Route Optimization). PRESENT (§4.4).
//
// M33 reads visit productivity/quality + route-efficiency aggregates. Bound to the live M17
// `VisitMetricsProvider` / `RouteEfficiencyReader` / `VisitReader` via `getSeam` at boot (P2C).
// Aggregate only — visit metadata, never clinical free-text (D6).
export interface ReportingSchedulingConsumer {
  /** M17 `VisitMetricsProvider` — productivity + quality measures (on-time / no-show / reschedule) over a window. */
  visitMetricsRollup(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<Record<string, number>>;
  /** M17 `RouteEfficiencyReader` — mean miles-per-visit + route-efficiency index over a window. */
  routeEfficiency(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<{ milesPerVisit: number | null; efficiencyIndex: number | null }>;
  /** M17 `VisitReader` — completed-visit count over a window. */
  completedVisitCount(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<number>;
}
