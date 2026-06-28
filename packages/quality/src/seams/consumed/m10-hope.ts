// @wardenx/quality — consumed-seam view of M10 (HOPE Engine). PRESENT producer (§4.4).
//
// M30 consumes M10's `HopeSubmissionProvider`, `HopeTimepointProvider`, and `HopeJ2051Provider` for the
// HOPE-derived measures and the HOPE-compliance dimension of the survey-readiness dashboard (the
// quarterly-submission-rate < 90% APU-penalty signal); it owns NO HOPE data. Aggregate-only — no
// patient-linked HOPE content crosses (D6). Bound to the live M10 readers via `getSeam` at boot (P2C).
export interface QualityHopeConsumer {
  /** M10 `HopeTimepointProvider` — on-time vs late timepoint-completion counts over a window. */
  timepointCompletionRollup(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<Record<string, number>>;
  /** M10 `HopeSubmissionProvider` — per-PE quarterly submission-acceptance posture (the APU-penalty signal). */
  submissionPostureRollup(organizationId: string): Promise<Record<string, number>>;
  /** M10 `HopeJ2051Provider` (count-only) — count of open SFV obligations triggered by J2051. */
  openSfvObligationCount(organizationId: string): Promise<number>;
}
