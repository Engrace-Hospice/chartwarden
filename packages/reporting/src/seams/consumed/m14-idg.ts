// @chartwarden/reporting — consumed-seam view of M14 (Interdisciplinary Group / IDG). PRESENT (§4.4).
//
// M33 reads IDG schedule-cadence + decision-latency + packet aggregates. Bound to the live M14
// `IdgScheduleProvider` / `IdgDecisionProvider` / `IdgPacketProvider` via `getSeam` at boot (P2C).
// Aggregate only — the SUD-redacted layer never crosses to reporting (D6).
export interface ReportingIdgConsumer {
  /** M14 `IdgScheduleProvider` — 15-day-cadence adherence counts (within / overdue) over a window. */
  cadenceAdherenceRollup(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<{ within: number; overdue: number }>;
  /** M14 `IdgDecisionProvider` — median decision-to-care-plan-update latency (hours) over a window. */
  decisionLatencyMedianHours(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<number | null>;
  /** M14 `IdgPacketProvider` — count of packets finalized over a window. */
  packetFinalizedCount(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<number>;
}
