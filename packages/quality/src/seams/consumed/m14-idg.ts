// @chartwarden/quality — consumed-seam view of M14 (IDG). PRESENT producer (§4.4).
//
// M30 consumes M14's `IdgScheduleProvider.getCadenceAdherence` for the IDG-cadence-compliance measure
// and `IdgDecisionProvider.getDecisionsForCarePlan` for the decision-to-care-plan-update latency measure;
// it does NOT write to M14. (M30 emits `m30.infection_outbreak.idg_review_required` for M14 to consume —
// that is producer-side, not a read here.) Aggregate-by-default (D6). Bound via `getSeam` at boot (P2C).
export interface QualityIdgConsumer {
  /** M14 `IdgScheduleProvider.getCadenceAdherence` — IDG-meeting cadence-adherence rate over a window. */
  cadenceAdherenceRate(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<number>;
  /** M14 `IdgDecisionProvider.getDecisionsForCarePlan` — count of IDG decisions for a care plan (latency base). */
  decisionsForCarePlanCount(organizationId: string, carePlanId: string): Promise<number>;
}
