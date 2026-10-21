// @chartwarden/reporting — consumed-seam view of M18 (EVV). PRESENT producer (§4.4).
//
// M33 reads EVV productivity/quality measures. Bound to the live M18 `EvvMetricsProvider` via
// `getSeam` at boot (P2C). Aggregate only — never coordinate-bearing data (D6/D10).
export interface ReportingEvvConsumer {
  /** M18 `EvvMetricsProvider` — compliance / late-checkout / geofence / spoof / aggregator coverage rollup. */
  evvMetricsRollup(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<Record<string, number>>;
}
