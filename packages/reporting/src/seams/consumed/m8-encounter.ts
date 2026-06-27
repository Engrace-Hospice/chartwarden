// @wardenx/reporting — consumed-seam view of M8 (Encounters & Visit Notes). PRESENT producer (§4.4).
//
// M33 reads encounter-statistics + billable-encounter aggregates. Bound to the live M8
// `EncounterStatisticsProvider` / `BillableEncounterReader` via `getSeam` at boot (P2C). Aggregate only.
export interface ReportingEncounterConsumer {
  /** M8 `EncounterStatisticsProvider` — encounter volume by discipline over a window. */
  encounterVolumeByDiscipline(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<Record<string, number>>;
  /** M8 `BillableEncounterReader` — count of billable encounters over a window. */
  billableEncounterCount(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<number>;
}
