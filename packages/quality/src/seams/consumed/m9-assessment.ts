// @chartwarden/quality — consumed-seam view of M9 (Clinical Assessments). PRESENT producer (§4.4).
//
// M30 consumes M9's `LatestAssessmentProvider` and `ScaleSeriesProvider` for the symptom-management
// dimension of mortality reviews and the HOPE-derived symptom-trajectory context; it does NOT write to
// M9. Aggregate-by-default for rollups; the per-patient latest read is PHI-minimal (scalar scale value
// only). Bound to the live M9 readers via `getSeam` at boot (P2C).
export interface QualityAssessmentConsumer {
  /** M9 `LatestAssessmentProvider` — the latest scalar value of a scale for a patient (mortality dimension). */
  latestScaleValue(
    organizationId: string,
    patientId: string,
    scale: string,
  ): Promise<number | null>;
  /** M9 `ScaleSeriesProvider` — the trajectory of a scale for a patient (symptom-trajectory context). */
  scaleSeries(
    organizationId: string,
    patientId: string,
    scale: string,
  ): Promise<readonly { at: string; value: number }[]>;
}
