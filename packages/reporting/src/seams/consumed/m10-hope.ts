// @wardenx/reporting — consumed-seam view of M10 (HOPE Engine). PRESENT producer (§4.4).
//
// M33 reads HOPE timepoint completion + per-PE submission posture + J2051 COUNTS only. Bound to the
// live M10 `HopeTimepointProvider` / `HopeSubmissionProvider` / `HopeJ2051Provider` (count-only) via
// `getSeam` at boot (P2C). Aggregate only — no patient-linked HOPE content crosses (D6).
export interface ReportingHopeConsumer {
  /** M10 `HopeTimepointProvider` — on-time vs late timepoint completion counts over a window. */
  timepointCompletionRollup(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<Record<string, number>>;
  /** M10 `HopeSubmissionProvider` — per-PE submission-batch acceptance posture counts. */
  submissionPostureRollup(organizationId: string): Promise<Record<string, number>>;
  /** M10 `HopeJ2051Provider` (count-only) — count of open SFV obligations triggered by J2051. */
  openSfvObligationCount(organizationId: string): Promise<number>;
}
