// @chartwarden/reporting — consumed-seam view of M40 (Master Data Management). PRESENT producer (§4.4).
//
// M33 resolves dimension LABELS only — physician / facility / payer / state / MAC display names for the
// dimension axes of a report (never PHI). Bound to the live M40 `ProviderEntityReader` / `LocationReader`
// + lookup helpers via `getSeam` at boot (P2C). Merge-aware (a merged entity redirects to its survivor).
export interface ReportingMdmConsumer {
  /** M40 `ProviderEntityReader` — display label for a physician/provider entity id (dimension axis). */
  providerLabel(organizationId: string, entityId: string): Promise<string | null>;
  /** M40 `LocationReader` — display label for a facility/location id (dimension axis). */
  locationLabel(organizationId: string, locationId: string): Promise<string | null>;
  /** M40 lookup helper — display label for a state / MAC / payer dimension key. */
  dimensionLabel(
    organizationId: string,
    dimensionKey: string,
    value: string,
  ): Promise<string | null>;
}
