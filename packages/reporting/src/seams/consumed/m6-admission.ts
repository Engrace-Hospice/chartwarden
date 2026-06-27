// @wardenx/reporting — consumed-seam view of M6 (Admission, Election & Certification). PRESENT (§4.4).
//
// M33 reads admission census + LOC-day + election/F2F compliance aggregates. Bound to the live M6
// `AdmissionCensusReader` / `LevelOfCareReader` / `ElectionPeriodReader` / `FaceToFaceReader` via
// `getSeam` at boot (P2C). Consumer-defined interface — aggregate counts only, no schema import.
export interface ReportingAdmissionConsumer {
  /** M6 `AdmissionCensusReader` — active-admission census count for an org. */
  activeCensusCount(organizationId: string): Promise<number>;
  /** M6 `LevelOfCareReader` — LOC-day totals by level over a window. */
  locDaysByLevel(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<Record<string, number>>;
  /** M6 `ElectionPeriodReader` — count of active benefit-period elections. */
  activeElectionCount(organizationId: string): Promise<number>;
  /** M6 `FaceToFaceReader` — count of recert windows with an attested F2F over a window. */
  faceToFaceAttestedCount(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<number>;
}
