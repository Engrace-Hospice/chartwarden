// apps/backend/src/modules/24-billing-medicaid/routes/write-service.ts — the M24 WRITE service interface
// (the §4.1 POST/PATCH/DELETE surface) + the transactional-outbox port. Each command runs under
// withOrgContext (RLS), validates the §2.2 transition via the pure @chartwarden/medicaid-adapters reducers,
// stamps the acting membership, and emits the §4.11 outbox event on the caller's tx through the injected
// WriteOutboxPort (transactional outbox).
//
// DEFERRAL (the M25/M26 posture): commands that need an unbound consumed reader (assemble — M5/M6/M8/M40
// readers; eligibility — the state adapter + M5 MedicaidIdUnlockReader; submit/replace/void — the state
// adapter wire I/O; platform rate-schedule-load — M40) DEGRADE to a structured typed error / queued no-op
// rather than crashing. Noted per method.
import type { DbClient } from "@chartwarden/db";
import type { M24Actor } from "./actor";
import type { ClaimView, RbArrangementView } from "./read-service";

/** A §4.11 `m24.*` transactional-outbox emission. PHI-free payload by construction (D12/D13). */
export interface OutboxEmission {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly organizationId: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
}

/** The transactional-outbox port (the composition root binds the catalog-validating M1 publisher pinned to
 * callerModule `m24`); `publish` writes the outbox_event row on the CALLER'S tx (same unit of work). No-op default.
 * `organizationId`/`aggregateKind`/`aggregateId` are REQUIRED here (not previously — every call site omitted
 * them, which type-checked ONLY because interface method-shorthand parameters are checked bivariantly, a
 * long-standing TS soundness hole; the real bound publisher at boot, `bindCallerModule` in `index.ts`,
 * always required them and every write 500'd `null value in column "aggregate_kind"` at the actual insert). */
export interface WriteOutboxPort {
  publish(tx: unknown, emission: OutboxEmission): Promise<void>;
}

export interface AssembleClaimInput {
  patientId: string;
  admissionId: string;
  providerEntityId: string;
  serviceFrom: string;
  serviceTo: string;
  kind: "combined_hospice_rb" | "hospice_only" | "rb_only";
  rbArrangementId?: string;
  medicareClaimId?: string;
}
/** Inputs for a read-only, non-reserving claim assembly preview. */
export interface PreviewClaimAssemblyInput {
  patientId: string;
  admissionId: string;
  providerEntityId: string;
  serviceFrom: string;
  serviceTo: string;
}
export type AssemblyCoverageResolutionStatus =
  | "uniform"
  | "none"
  | "changes"
  | "ambiguous"
  | "unavailable";
export interface AssemblyPreviewCoverage {
  status: AssemblyCoverageResolutionStatus;
  coverageKind: string | null;
  rank: number | null;
}
export interface AssemblyPreviewClaimKind {
  kind: AssembleClaimInput["kind"];
  payerPolicy: "permitted" | "blocked" | "unresolved";
  reasonCode: string | null;
}
export interface AssemblyPreviewArrangement {
  id: string;
  facilityName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  billableDayCount: number;
  status: "candidate" | "blocked" | "unresolved";
  reasonCode: string | null;
}
export interface AssemblyPreviewView {
  primaryCoverage: AssemblyPreviewCoverage;
  medicaidCoverage: AssemblyPreviewCoverage;
  payerResponsibility:
    | "medicaid_primary"
    | "medicare_primary_medicaid_secondary"
    | "other_primary"
    | "unresolved";
  recordedEligibility: {
    status: "current" | "stale" | "not_recorded" | "unavailable";
    outcome: string | null;
    serviceState: string | null;
    asOfServiceDate: string | null;
    checkedAt: string | null;
    staleAt: string | null;
  };
  claimKinds: readonly AssemblyPreviewClaimKind[];
  rbArrangements: readonly AssemblyPreviewArrangement[];
  arrangementListStatus: "available" | "unavailable";
  medicareEvidence: {
    match: "not_applicable" | "unresolved" | "unavailable" | "none" | "ambiguous" | "single";
    evidenceStatus: string | null;
    rangeRelation: string | null;
    remittanceAdviceRecorded: boolean | null;
  };
  stateBillingPolicy: "not_applicable_to_primary_medicaid" | "unconfirmed" | "unresolved";
  programResponsibility: {
    status:
      | "verified"
      | "missing"
      | "pending"
      | "rejected"
      | "expired"
      | "revoked"
      | "ambiguous"
      | "changes"
      | "unsupported"
      | "unavailable";
    programKind:
      | "ffs_open_card"
      | "managed_care"
      | "other_managed_care"
      | "unsupported"
      | "unresolved"
      | "ambiguous"
      | null;
    canonicalPayerId: string | null;
    canonicalPayerName: string | null;
    reasonCode: string;
  };
  payerAuthorizationEvidence: {
    clinicalDocuments: "missing" | "unverified" | "available";
    notification: "missing" | "unverified" | "prepared" | "sent" | "acknowledged";
    authorization:
      | "missing"
      | "unverified"
      | "pending"
      | "approved"
      | "denied"
      | "expired"
      | "revoked"
      | "ambiguous";
    policyQualification: "unqualified";
    reasonCodes: readonly string[];
  };
  enrollmentReadiness: ReadonlyArray<{
    kind: string;
    status:
      | "not_applicable"
      | "missing"
      | "pending"
      | "verified"
      | "expired"
      | "revoked"
      | "ambiguous"
      | "unavailable";
    reasonCode: string;
    vendorPayerId?: string | null;
  }>;
  selectedClearinghouse: {
    status: "selected" | "missing" | "unavailable";
    vendor: string | null;
    configurationStatus: string | null;
  };
  tradingPartnerCredential: {
    status:
      | "configured"
      | "missing"
      | "expired"
      | "future"
      | "partial"
      | "ambiguous"
      | "unavailable";
    reasonCode: string;
  };
  electronicSubmissionAvailable: false;
  isAdvisorySnapshot: true;
}
export interface UpdateDraftClaimInput {
  expectedVersion: number | null;
}
export interface SubmitClaimInput {
  expectedVersion: number | null;
  channelHint?: string;
}
export interface ReplaceClaimInput {
  expectedVersion: number | null;
  reason: string;
}
export interface VoidClaimInput {
  expectedVersion: number | null;
  reason: string;
}
export interface ApplyOverrideInput {
  reason: string;
  overrideRoleClaimed: "billing_manager" | "compliance_officer" | "medical_director" | "org_admin";
}
export interface EditRuleConfigInput {
  expectedVersion: number | null;
  enabled?: boolean;
  parametersOverlay?: unknown;
}
export interface CreateCustomRuleInput {
  ruleKey: string;
  customPredicateDsl: unknown;
  customSeverity: string;
  customOverrideRole?: string;
}
export interface RefreshEligibilityInput {
  patientId: string;
  patientPayerId: string;
  asOfServiceDate: string;
  providerEntityId?: string;
}
export interface CreateRbArrangementInput {
  patientId: string;
  providerEntityId: string;
  nfFacilityMdmId: string;
  effectiveFrom: string;
  effectiveTo?: string;
  nfPerDiemRoutineCents: number;
  nfPerDiemRespCents: number;
  nfPerDiemGipCents: number;
  passThroughPct: number;
  retentionPct: number;
  contractDocumentId?: string;
}
export interface EditRbArrangementInput {
  expectedVersion: number | null;
  effectiveTo?: string;
  nfPerDiemRoutineCents?: number;
  nfPerDiemRespCents?: number;
  nfPerDiemGipCents?: number;
}
export interface TerminateRbArrangementInput {
  expectedVersion: number | null;
  reason: string;
}
export interface OverrideRbDayInput {
  expectedVersion: number | null;
  status: "pending" | "billable" | "excluded" | "voided";
  exclusionReason?: string;
}
export interface UpsertCredentialInput {
  providerEntityId: string;
  serviceState: string;
  channel: "direct_mmis" | "cco_clearinghouse" | "sftp" | "portal" | "state_proprietary";
  mcoId?: string;
  tradingPartnerId: string;
  clientId?: string;
  clientSecret?: string;
  sftpHost?: string;
  sftpUser?: string;
  sftpKey?: string;
  portalUrl?: string;
  activeFrom: string;
  activeTo?: string;
}
export interface RegisterPlatformRuleInput {
  ruleKey: string;
  title: string;
  category: string;
  severity: string;
}
export interface LoadRateScheduleInput {
  serviceState: string;
  effectiveYear: number;
}
export interface RecordProgramAssignmentInput {
  patientId: string;
  patientPayerId: string;
  admissionId: string;
  providerEntityId: string;
  serviceState: string;
  programKind:
    | "ffs_open_card"
    | "managed_care"
    | "other_managed_care"
    | "unsupported"
    | "unresolved";
  canonicalPayerId?: string;
  effectiveFrom: string;
  effectiveTo?: string;
  sourceKind: "manual_candidate" | "payer_document" | "state_response" | "imported";
  evidenceReference?: string;
}
export interface RecordEnrollmentEvidenceInput {
  providerEntityId: string;
  serviceState: string;
  programKind?: "ffs_open_card" | "managed_care" | "other_managed_care";
  canonicalPayerId?: string;
  clearinghouse?: "stedi" | "claimmd" | "other";
  vendorAccountRef?: string;
  vendorPayerId?: string;
  sourceEnvironment?: "test" | "production";
  transactionType?: "837I" | "835";
  evidenceKind:
    | "state_medicaid_provider_enrollment"
    | "mco_participation"
    | "837i_enrollment"
    | "835_era_enrollment"
    | "clearinghouse_payer_route"
    | "institutional_format_qualification"
    | "payer_transport_certification"
    | "production_activation_approval";
  effectiveFrom: string;
  effectiveTo?: string;
  evidenceFreshUntil?: string;
}
export interface VerifyPayerReadinessRecordInput {
  expectedVersion: number;
  verificationSource: string;
  evidenceReference: string;
  providerEntityId: string;
  patientId?: string;
}
export interface RevokePayerReadinessRecordInput {
  expectedVersion: number;
  reasonCode: "source_corrected" | "payer_withdrawal" | "coverage_changed" | "other";
  providerEntityId: string;
  patientId?: string;
}

export interface M24WriteService {
  /** Optional on legacy/test bindings; production Drizzle binding provides the read-only preview. */
  previewClaimAssembly?(
    actor: M24Actor,
    input: PreviewClaimAssemblyInput,
  ): Promise<AssemblyPreviewView>;
  assembleClaim(actor: M24Actor, input: AssembleClaimInput): Promise<ClaimView>;
  updateDraftClaim(
    actor: M24Actor,
    claimId: string,
    input: UpdateDraftClaimInput,
  ): Promise<ClaimView>;
  deleteDraftClaim(actor: M24Actor, claimId: string, expectedVersion: number | null): Promise<void>;
  validateClaim(actor: M24Actor, claimId: string): Promise<{ validationRunId: string }>;
  submitClaim(actor: M24Actor, claimId: string, input: SubmitClaimInput): Promise<ClaimView>;
  replaceClaim(actor: M24Actor, claimId: string, input: ReplaceClaimInput): Promise<ClaimView>;
  voidClaim(actor: M24Actor, claimId: string, input: VoidClaimInput): Promise<ClaimView>;
  abandonClaim(
    actor: M24Actor,
    claimId: string,
    expectedVersion: number | null,
  ): Promise<ClaimView>;
  applyOverride(
    actor: M24Actor,
    resultId: string,
    input: ApplyOverrideInput,
  ): Promise<{ overrideId: string }>;
  editRuleConfig(actor: M24Actor, ruleKey: string, input: EditRuleConfigInput): Promise<void>;
  createCustomRule(actor: M24Actor, input: CreateCustomRuleInput): Promise<{ ruleKey: string }>;
  deleteCustomRule(actor: M24Actor, ruleKey: string, expectedVersion: number | null): Promise<void>;
  refreshEligibility(
    actor: M24Actor,
    input: RefreshEligibilityInput,
  ): Promise<{ checkId: string; outcome: string }>;
  createRbArrangement(actor: M24Actor, input: CreateRbArrangementInput): Promise<RbArrangementView>;
  editRbArrangement(
    actor: M24Actor,
    arrangementId: string,
    input: EditRbArrangementInput,
  ): Promise<RbArrangementView>;
  activateRbArrangement(
    actor: M24Actor,
    arrangementId: string,
    expectedVersion: number | null,
  ): Promise<RbArrangementView>;
  terminateRbArrangement(
    actor: M24Actor,
    arrangementId: string,
    input: TerminateRbArrangementInput,
  ): Promise<RbArrangementView>;
  overrideRbDay(actor: M24Actor, rbDayId: string, input: OverrideRbDayInput): Promise<void>;
  upsertCredential(actor: M24Actor, input: UpsertCredentialInput): Promise<{ id: string }>;
  /**
   * The same upsert on the CALLER'S transaction (`tx` is already scoped to `actor.organizationId`). The platform
   * onboarding route (M34) uses it so the write, its tenant-status check and its audit row commit together.
   */
  upsertCredentialOnTx(
    tx: DbClient,
    actor: M24Actor,
    input: UpsertCredentialInput,
  ): Promise<{ id: string }>;
  testCredential(
    actor: M24Actor,
    credentialId: string,
  ): Promise<{ ok: boolean; errorMessage?: string }>;
  registerPlatformRule(actor: M24Actor, input: RegisterPlatformRuleInput): Promise<void>;
  loadRateSchedule(actor: M24Actor, input: LoadRateScheduleInput): Promise<{ queued: boolean }>;
  recordProgramAssignment(
    actor: M24Actor,
    input: RecordProgramAssignmentInput,
  ): Promise<{ id: string; status: "pending" }>;
  recordEnrollmentEvidence(
    actor: M24Actor,
    input: RecordEnrollmentEvidenceInput,
  ): Promise<{ id: string; status: "pending" }>;
  verifyProgramAssignment(
    actor: M24Actor,
    id: string,
    input: VerifyPayerReadinessRecordInput,
  ): Promise<{ status: "verified"; version: number }>;
  verifyEnrollmentEvidence(
    actor: M24Actor,
    id: string,
    input: VerifyPayerReadinessRecordInput,
  ): Promise<{ status: "verified"; version: number }>;
  revokeProgramAssignment(
    actor: M24Actor,
    id: string,
    input: RevokePayerReadinessRecordInput,
  ): Promise<{ status: "revoked"; version: number }>;
  revokeEnrollmentEvidence(
    actor: M24Actor,
    id: string,
    input: RevokePayerReadinessRecordInput,
  ): Promise<{ status: "revoked"; version: number }>;
}
