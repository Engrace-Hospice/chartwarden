// @chartwarden/reporting — consumed-seam view of M12 (DoseSpot Integration). PRESENT producer (§4.4).
//
// M33 reads medication-order volume + refill-inbox SLA aggregates. Bound to the live M12
// `MedicationOrderProvider` / `RefillInboxProvider` via `getSeam` at boot (P2C). Aggregate only (D6).
export interface ReportingMedicationOrderConsumer {
  /** M12 `MedicationOrderProvider` — medication-order volume (controlled vs non-controlled) over a window. */
  medicationOrderVolume(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<{ controlled: number; nonControlled: number }>;
  /** M12 `RefillInboxProvider` — pending refill-request count + median age (SLA dashboard). */
  refillInboxBacklog(
    organizationId: string,
  ): Promise<{ pending: number; medianAgeHours: number | null }>;
}
