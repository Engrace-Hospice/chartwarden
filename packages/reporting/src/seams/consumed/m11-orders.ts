// @chartwarden/reporting — consumed-seam view of M11 (Orders). PRESENT producer (§4.4).
//
// M33 reads order-volume + verbal-order-timeliness aggregates. Bound to the live M11 `OrderProvider`
// via `getSeam` at boot (P2C). Aggregate only — no patient-linked order content crosses (D6).
export interface ReportingOrderConsumer {
  /** M11 `OrderProvider` — order volume by status over a window. */
  orderVolumeByStatus(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<Record<string, number>>;
  /** M11 `OrderProvider` — count of verbal orders cosigned within the 48h timeliness window. */
  verbalOrderTimelinessCount(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<{ onTime: number; late: number }>;
}
