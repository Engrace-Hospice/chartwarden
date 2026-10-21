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
import type { M24WriteActor } from "./actor";
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
export interface UpdateDraftClaimInput {
  expectedVersion: number | null;
  mcoId?: string | null;
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

export interface M24WriteService {
  assembleClaim(actor: M24WriteActor, input: AssembleClaimInput): Promise<ClaimView>;
  updateDraftClaim(
    actor: M24WriteActor,
    claimId: string,
    input: UpdateDraftClaimInput,
  ): Promise<ClaimView>;
  deleteDraftClaim(
    actor: M24WriteActor,
    claimId: string,
    expectedVersion: number | null,
  ): Promise<void>;
  validateClaim(actor: M24WriteActor, claimId: string): Promise<{ validationRunId: string }>;
  submitClaim(actor: M24WriteActor, claimId: string, input: SubmitClaimInput): Promise<ClaimView>;
  replaceClaim(actor: M24WriteActor, claimId: string, input: ReplaceClaimInput): Promise<ClaimView>;
  voidClaim(actor: M24WriteActor, claimId: string, input: VoidClaimInput): Promise<ClaimView>;
  abandonClaim(
    actor: M24WriteActor,
    claimId: string,
    expectedVersion: number | null,
  ): Promise<ClaimView>;
  applyOverride(
    actor: M24WriteActor,
    resultId: string,
    input: ApplyOverrideInput,
  ): Promise<{ overrideId: string }>;
  editRuleConfig(actor: M24WriteActor, ruleKey: string, input: EditRuleConfigInput): Promise<void>;
  createCustomRule(
    actor: M24WriteActor,
    input: CreateCustomRuleInput,
  ): Promise<{ ruleKey: string }>;
  deleteCustomRule(
    actor: M24WriteActor,
    ruleKey: string,
    expectedVersion: number | null,
  ): Promise<void>;
  refreshEligibility(
    actor: M24WriteActor,
    input: RefreshEligibilityInput,
  ): Promise<{ checkId: string; outcome: string }>;
  createRbArrangement(
    actor: M24WriteActor,
    input: CreateRbArrangementInput,
  ): Promise<RbArrangementView>;
  editRbArrangement(
    actor: M24WriteActor,
    arrangementId: string,
    input: EditRbArrangementInput,
  ): Promise<RbArrangementView>;
  activateRbArrangement(
    actor: M24WriteActor,
    arrangementId: string,
    expectedVersion: number | null,
  ): Promise<RbArrangementView>;
  terminateRbArrangement(
    actor: M24WriteActor,
    arrangementId: string,
    input: TerminateRbArrangementInput,
  ): Promise<RbArrangementView>;
  overrideRbDay(actor: M24WriteActor, rbDayId: string, input: OverrideRbDayInput): Promise<void>;
  upsertCredential(actor: M24WriteActor, input: UpsertCredentialInput): Promise<{ id: string }>;
  testCredential(
    actor: M24WriteActor,
    credentialId: string,
  ): Promise<{ ok: boolean; errorMessage?: string }>;
  registerPlatformRule(actor: M24WriteActor, input: RegisterPlatformRuleInput): Promise<void>;
  loadRateSchedule(
    actor: M24WriteActor,
    input: LoadRateScheduleInput,
  ): Promise<{ queued: boolean }>;
}
