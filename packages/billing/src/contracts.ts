// @wardenx/billing — M23 canonical shared DOMAIN VALUE TYPES (§2.1 / §4.3). The id aliases, the
// pgEnum-mirroring string unions, and the published-seam DTO shapes the seams + every subtree reference.
// Kept local to the package (the M27 `contracts.ts` precedent) so M23 takes no `@wardenx/domain` edge for
// ids that the shared leaves do not yet declare. NO PHI / NO MBI on any of these surfaces (D13 / §3.6 /
// §8.7) — every reader projection is aggregate or id-keyed; the MBI digit is NEVER a field on any DTO.
//
// P1 scope: contracts only. The CANONICAL pgEnums live in `packages/db/src/schema/billing` (the schema
// agent owns them); the unions here MIRROR those frozen enums and are kept in lock-step. TODO(P2): the
// DTO field sets below are SKELETON shapes — the live projection columns land with the §3.3 repositories.

// ── branded-ish id aliases (string at runtime; documentary at the type layer) ────────────────────────
export type OrgId = string;
export type ProviderEntityId = string;
export type PatientId = string;
export type AdmissionId = string;
export type MembershipId = string;
export type ClaimId = string;
export type ClaimLineId = string;
export type ClaimSubmissionId = string;
export type ClaimAcknowledgmentId = string;
export type NoeId = string;
export type NotrId = string;
export type ValidationRunId = string;
export type ValidationResultId = string;
export type ValidationOverrideId = string;
export type EligibilityCheckId = string;
export type MacCredentialId = string;
export type RemittanceAdviceId = string;
export type AbnId = string;

/** ISO-8601 calendar date (`YYYY-MM-DD`). */
export type IsoDate = string;
/** ISO-8601 instant (`YYYY-MM-DDTHH:mm:ss.sssZ`). */
export type IsoDateTime = string;
/** A hospice aggregate-cap year (Oct 1 – Sep 30 (ADR-0002)), keyed by its starting calendar year. */
export type CapYear = number;
/** A cost-report fiscal year, keyed by its ending calendar year. */
export type FiscalYear = number;

// ── lifecycle / enum string unions (MIRROR the frozen `packages/db/src/schema/billing` pgEnums) ───────
/** The §3.4 claim state machine (D2 / D4 / D14). */
export type ClaimState =
  | "draft"
  | "validating"
  | "ready"
  | "submitted"
  | "ack_pending"
  | "ack_accepted"
  | "ack_partial"
  | "ack_rejected"
  | "paid"
  | "partial_paid"
  | "denied"
  | "replaced"
  | "voided";

/** NOE / NOTR fast-path state machine (D3). */
export type NoticeState =
  | "draft"
  | "ready"
  | "submitted"
  | "ack_pending"
  | "ack_accepted"
  | "ack_rejected"
  | "cancelled";

/** UB-04 Type of Bill semantics relevant to hospice (D4 / D14). */
export type TypeOfBill = "811" | "812" | "813" | "814" | "817" | "818";

/** CMS hospice level-of-care segments (HIPPS / per-diem inputs, D7). */
export type LevelOfCare =
  | "routine_home_care"
  | "continuous_home_care"
  | "inpatient_respite_care"
  | "general_inpatient_care";

export type ValidationOutcome = "pass" | "fail" | "warn" | "info";
export type ValidationSeverity = "error" | "warn" | "info";
export type EligibilityOutcome = "active_part_a" | "inactive_part_a" | "indeterminate" | "error";
export type SubmissionStatus =
  | "queued"
  | "uploaded"
  | "accepted"
  | "partial"
  | "rejected"
  | "failed";
export type AdjudicationOutcome = "paid" | "partial_paid" | "denied";

/** The override-role gate per rule (§4.5 / §4.7 `override_role_eligible`). */
export type OverrideRole =
  | "billing_manager"
  | "compliance_officer"
  | "medical_director"
  | "org_admin";

// ── published-seam DTO shapes (§4.3) — SKELETON projections (no PHI / no MBI) ──────────────────────────
// TODO(P2): widen each DTO to the live projection column set as the §3.3 read services land. The shapes
// below intentionally carry ids + aggregate facts only; they are the contract downstream modules import.

/** §4.3 ClaimReader.claimById — single-claim summary projection. */
export interface ClaimSummaryDto {
  readonly claimId: ClaimId;
  readonly providerEntityId: ProviderEntityId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly tob: TypeOfBill;
  readonly state: ClaimState;
  readonly serviceFrom: IsoDate;
  readonly serviceTo: IsoDate;
  readonly claimControlNumber: string;
  readonly totalChargeCents: number;
}

/** §4.3 ClaimReader.fhirProjection — the M28 FHIR R4 Claim/ClaimResponse/EOB projection (US Core 6.0). */
export interface ClaimFhirProjectionDto {
  readonly claimId: ClaimId;
  /** TODO(P2/M28-lock): the typed FHIR resource bundle. Opaque at P1. */
  readonly resourceBundle: unknown;
}

/** §4.3 ClaimReader.measureFeatureSetForPatient — M30 HQRP / HCI feature inputs (aggregate). */
export interface HciFeatureSetDto {
  readonly patientId: PatientId;
  readonly measurementPeriod: { readonly from: IsoDate; readonly to: IsoDate };
  /** TODO(P2): the per-indicator feature fields M30's HCI measures consume. */
  readonly features: Record<string, number>;
}

/** §4.3 ClaimReader.medicareSecondaryContext — M24 coordination-of-benefits context. */
export interface MedicareSecondaryContextDto {
  readonly claimId: ClaimId;
  readonly serviceFrom: IsoDate;
  readonly serviceTo: IsoDate;
  readonly medicarePrimary: boolean;
}

/** §4.3 ClaimDayProjectionProvider — per-LOC day rollup (M26 cap / M27 statistics). */
export interface DaysByLevelOfCareDto {
  readonly routineHomeCareDays: number;
  readonly continuousHomeCareDays: number;
  readonly inpatientRespiteCareDays: number;
  readonly generalInpatientCareDays: number;
  readonly totalDays: number;
}

/** §4.3 ClaimDayProjectionProvider.aggregateForOrgInCapYear — org-wide cap-year accrual. */
export interface OrgCapAccrualDto {
  readonly providerEntityId: ProviderEntityId;
  readonly capYear: CapYear;
  readonly totalDays: number;
  readonly inpatientDays: number;
}

/** §4.3 ClaimDayProjectionProvider.aggregateForOrgInFiscalYear — M27 worksheet S-3 statistics. */
export interface OrgFyDaysDto {
  readonly providerEntityId: ProviderEntityId;
  readonly fyEnd: IsoDate;
  readonly totalDays: number;
  readonly unduplicatedPatientCount: number;
}

/** §4.3 ClaimSubmissionReader.acceptedSubmissionsInWindow — M25 835-to-claim matching. */
export interface AcceptedSubmissionDto {
  readonly submissionId: ClaimSubmissionId;
  readonly claimId: ClaimId;
  readonly claimControlNumber: string;
  readonly acceptedAt: IsoDateTime;
  readonly payerClaimControlNumber: string | null;
}

/** §4.3 ClaimSubmissionReader.submissionByControlNumber. */
export interface SubmissionDto {
  readonly submissionId: ClaimSubmissionId;
  readonly claimId: ClaimId;
  readonly controlNumber: string;
  readonly status: SubmissionStatus;
  readonly submittedAt: IsoDateTime | null;
}

/** §4.3 ClaimMetricsProvider.windowAggregate — one dimension bucket for M33 dashboards. */
export interface MetricsBucket {
  readonly key: string;
  readonly count: number;
  readonly amountCents: number;
}

/** §4.3 ClaimMetricsProvider.arAgingBuckets — AR aging rollup for M33. */
export interface ArAgingDto {
  readonly bucket0to30Cents: number;
  readonly bucket31to60Cents: number;
  readonly bucket61to90Cents: number;
  readonly bucket90PlusCents: number;
}

/** §4.3 ClaimMetricsProvider.macPortalAvailabilityRolling. */
export interface MacPortalAvailabilityDto {
  readonly macJurisdiction: string;
  readonly rollingAvailabilityPct: number;
  readonly lastSeenUpAt: IsoDateTime | null;
}

/** §4.3 MacCredentialAdmin.listForOrg — per-PE MAC credential summary (secrets masked, §3.6). */
export interface MacCredentialSummaryDto {
  readonly credentialId: MacCredentialId;
  readonly providerEntityId: ProviderEntityId;
  readonly macJurisdiction: string;
  readonly clientId: string;
  /** The secret is NEVER projected — only its presence + last-test status. */
  readonly hasSecret: boolean;
  readonly lastSandboxTestAt: IsoDateTime | null;
  readonly version: number;
}

/** §4.3 MacCredentialAdmin.upsertCredentials — the write payload (secret carried inbound only). */
export interface UpsertMacCredentialsDto {
  readonly macJurisdiction: string;
  readonly clientId: string;
  /** Write-only: encrypted at rest, redacted from audit value-capture (§3.6). */
  readonly clientSecret: string;
}
