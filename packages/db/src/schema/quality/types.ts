// @chartwarden/db — M30 HQRP & Quality: helper TS types for the module's jsonb columns (§3.3).
// These back the Drizzle `.$type<...>()` generics so the column payloads are typed (no `any`).
// Filename intentionally avoids the substring "schema" (table-ownership/tenancy heuristic gotcha).

// quality_measure_value.computation_snapshot — the opaque seam-input state captured at compute time
// (the hashed-over object behind snapshot_content_hash). Shape is calculator-version specific.
export interface MeasureComputationSnapshot {
  [key: string]: unknown;
}

// cahps_result_summary.top_box_percentages — per-question top-box percentage, keyed by question code.
export interface CahpsTopBoxPercentages {
  [questionCode: string]: number;
}

// cahps_result_summary.composite_scores — the six CMS CAHPS composites, keyed by composite code.
export interface CahpsCompositeScores {
  [compositeCode: string]: number;
}

// qapi_program.governing_body_roster — [{membershipId, role}].
export interface GoverningBodyMember {
  membershipId: string;
  role: string;
}
export type GoverningBodyRoster = GoverningBodyMember[];

// qapi_program.year_end_attestation — {at, byMembershipId, summary}.
export interface YearEndAttestation {
  at: string;
  byMembershipId: string;
  summary: string;
}

// qapi_governance_minutes.attendee_roster — [{membershipId, role?, present?}].
export interface MeetingAttendee {
  membershipId: string;
  role?: string;
  present?: boolean;
}
export type AttendeeRoster = MeetingAttendee[];

// qapi_governance_minutes.amendment_log — append-only amendment trail.
export interface MinutesAmendmentEntry {
  at: string;
  byMembershipId: string;
  reason: string;
}
export type MinutesAmendmentLog = MinutesAmendmentEntry[];

// incident_report.kind_data — per-kind TypeBox payload. The free-text PHI/SUD-sensitive members
// (narrativeText / witnessNames / patientQuote / staffQuote) are audit-denylisted in §3.6.
export interface IncidentKindData {
  narrativeText?: string;
  witnessNames?: string[];
  patientQuote?: string;
  staffQuote?: string;
  summary?: string;
  [key: string]: unknown;
}

// mortality_review.clinical_dimension_data — freeTextNotes is audit-denylisted (§3.6).
export interface ClinicalDimensionData {
  freeTextNotes?: string;
  [key: string]: unknown;
}

// mortality_review.satisfaction_dimension_data — caregiverQualitativeSummary is audit-denylisted (§3.6).
export interface SatisfactionDimensionData {
  caregiverQualitativeSummary?: string;
  [key: string]: unknown;
}

// mortality_review.compliance_dimension_data — notes is audit-denylisted (§3.6).
export interface ComplianceDimensionData {
  notes?: string;
  [key: string]: unknown;
}
