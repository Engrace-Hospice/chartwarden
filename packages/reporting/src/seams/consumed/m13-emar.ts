// @chartwarden/reporting — consumed-seam view of M13 (eMAR & Med Administration). PRESENT producer (§4.4).
//
// M33 reads administration + reconciliation aggregates. Bound to the live M13
// `MedicationAdministrationProvider` / `ReconciliationProvider` via `getSeam` at boot (P2C). Aggregate
// only — no patient-linked administration content crosses (D6). Also subscribes to M13 admin events.
export interface ReportingEmarConsumer {
  /** M13 `MedicationAdministrationProvider` — administration outcome counts (given/refused/missed) over a window. */
  administrationOutcomeRollup(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<Record<string, number>>;
  /** M13 `ReconciliationProvider` — count of reconciliation worksheets completed within the timeliness window. */
  reconciliationTimelinessCount(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<{ onTime: number; late: number }>;
}
