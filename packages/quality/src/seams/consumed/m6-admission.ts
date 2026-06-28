// @wardenx/quality — consumed-seam view of M6 (Admission / Census). PRESENT producer (§4.4).
//
// M30 consumes M6's `LevelOfCarePeriodReader`, `AdmissionCensusReader`, `DischargeReader`, and
// `ComplianceWindowReader` for the HVLDL last-three-days-of-life denominator, the HCI patient-days
// base, and the survey-readiness compliance windows; it subscribes to `m6.discharge.death` for the
// mortality-review + CAHPS-sample triggers (that subscription is outbox-side, not a read here). M30
// does NOT write to M6. Aggregate-by-default (D6). Bound to the live M6 readers via `getSeam` (P2C).
export interface QualityAdmissionConsumer {
  /** M6 `AdmissionCensusReader` — active census count for an org over an as-of date (HCI denominator base). */
  activeCensusCount(organizationId: string, asOf: string): Promise<number>;
  /** M6 `DischargeReader` — discharge-by-disposition rollup over a window (HVLDL / mortality cohorts). */
  dischargeRollup(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<Record<string, number>>;
  /** M6 `LevelOfCarePeriodReader` — patient-days by level-of-care over a window (HCI claims-derived base). */
  patientDaysByLevelOfCare(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<Record<string, number>>;
}
