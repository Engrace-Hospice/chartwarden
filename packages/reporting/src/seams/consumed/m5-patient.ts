// @chartwarden/reporting — consumed-seam view of M5 (Patient). PRESENT producer (§4.4).
//
// M33 reads aggregate census counts only (D6 — no row-level PHI). Bound to the live M5
// `CaseloadProvider` / `PatientReader.countActive` via `getSeam` at boot (P2C). Consumer-defined
// interface — no import of M5's package or schema (the dependency-cruiser schema rule enforces this).
export interface ReportingPatientConsumer {
  /** M5 `PatientReader.countActive` — active-patient count for an org (census KPI). */
  countActivePatients(organizationId: string): Promise<number>;
  /** M5 `CaseloadProvider` — caseload size for a membership (productivity denominator). */
  caseloadSizeForMembership(organizationId: string, membershipId: string): Promise<number>;
}
