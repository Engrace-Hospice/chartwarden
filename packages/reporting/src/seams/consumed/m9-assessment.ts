// @wardenx/reporting — consumed-seam view of M9 (Clinical Assessments). PRESENT producer (§4.4).
//
// M33 reads AGGREGATE-only scale series + assessment-compliance counts (the M9 `ScaleSeriesProvider`
// is consumed aggregate-only — no per-patient scores cross, D6). Bound via `getSeam` at boot (P2C).
export interface ReportingAssessmentConsumer {
  /** M9 `ScaleSeriesProvider` (aggregate-only) — mean/median scale value across the org over a window. */
  scaleAggregate(
    organizationId: string,
    scaleKey: string,
    period: { from: string; to: string },
  ): Promise<{ mean: number | null; n: number }>;
  /** M9 `AssessmentComplianceReader` — count of on-time vs overdue scheduled assessments. */
  assessmentComplianceRollup(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<Record<string, number>>;
}
