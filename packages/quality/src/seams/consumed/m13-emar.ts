// @wardenx/quality — consumed-seam view of M13 (eMAR). PRESENT producer (§4.4).
//
// M30 consumes M13's `MedicationAdministrationProvider.getMissedDoseRate`, `getPrnEffectivenessRate`,
// and `getComfortKitAdministrationTimeline` for the administration-side quality measures; it does NOT
// write to M13. Aggregate-by-default (D6). Bound to the live M13 reader via `getSeam` at boot (P2C).
export interface QualityMedicationAdministrationConsumer {
  /** M13 `MedicationAdministrationProvider.getMissedDoseRate` — missed-dose rate over a window. */
  missedDoseRate(organizationId: string, period: { from: string; to: string }): Promise<number>;
  /** M13 `getPrnEffectivenessRate` — PRN-effectiveness (follow-up assessment) rate over a window. */
  prnEffectivenessRate(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<number>;
  /** M13 `getComfortKitAdministrationTimeline` — deployment-to-first-administration interval (median min). */
  comfortKitAdministrationIntervalMinutes(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<number | null>;
}
