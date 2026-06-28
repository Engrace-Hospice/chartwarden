// @wardenx/quality — consumed-seam view of M18 (EVV). PRESENT producer (§4.4).
//
// M30 consumes M18's `EvvMetricsProvider.getComplianceRate`, `getLateCheckoutRate`, and
// `getGeofenceBreachRate` for the EVV quality measures (incl. the Cures Act §12006 self-reported
// state-aggregator compliance number); it does NOT write to M18. Aggregate-by-default (D6). Bound to
// the live M18 reader via `getSeam` at boot (P2C).
export interface QualityEvvConsumer {
  /** M18 `EvvMetricsProvider.getComplianceRate` — EVV-compliance rate over a window (Cures Act §12006). */
  complianceRate(organizationId: string, period: { from: string; to: string }): Promise<number>;
  /** M18 `EvvMetricsProvider.getLateCheckoutRate` — late-checkout rate over a window. */
  lateCheckoutRate(organizationId: string, period: { from: string; to: string }): Promise<number>;
  /** M18 `EvvMetricsProvider.getGeofenceBreachRate` — geofence-breach rate over a window. */
  geofenceBreachRate(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<number>;
}
