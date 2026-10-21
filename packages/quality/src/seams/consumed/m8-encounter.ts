// @chartwarden/quality — consumed-seam view of M8 (Encounters). PRESENT producer (§4.4).
//
// M30 consumes M8's `EncounterStatisticsProvider` and `SignedEncountersReader` for the HCI
// visits-near-death indicator, the HVLDL last-three-days-of-life predicate, and the late-entry-rate
// survey-readiness check; it does NOT read encounter narratives. Aggregate-by-default (D6 — no
// narrative content crosses). Bound to the live M8 readers via `getSeam` at boot (P2C).
export interface QualityEncounterConsumer {
  /** M8 `EncounterStatisticsProvider` — visit counts in the last N days of life (HCI visits-near-death). */
  visitsNearDeathRollup(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<Record<string, number>>;
  /** M8 `SignedEncountersReader` — count of signed encounters in the last three days of life (HVLDL). */
  hvldlSignedEncounterCount(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<number>;
  /** M8 `EncounterStatisticsProvider` — late-entry encounter rate over a window (survey-readiness check). */
  lateEntryRate(organizationId: string, period: { from: string; to: string }): Promise<number>;
}
