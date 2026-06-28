// @wardenx/quality — consumed-seam view of M7 (Care Plan). PRESENT producer (§4.4).
//
// M30 consumes M7's `CarePlanComplianceProvider.fifteenDayAdherenceForPatient` and `CarePlanVersionReader`
// for the survey-readiness 15-day-adherence indicator; it does NOT write to M7. Aggregate-by-default (D6).
// Bound to the live M7 readers via `getSeam` at boot (P2C).
export interface QualityCarePlanConsumer {
  /** M7 `CarePlanComplianceProvider` — 15-day care-plan-adherence rate for an org over a window. */
  fifteenDayAdherenceRate(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<number>;
  /** M7 `CarePlanVersionReader` — count of care-plan versions for a patient (decision-latency context). */
  carePlanVersionCount(organizationId: string, patientId: string): Promise<number>;
}
