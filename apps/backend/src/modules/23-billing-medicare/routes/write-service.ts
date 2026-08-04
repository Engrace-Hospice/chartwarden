// apps/backend/src/modules/23-billing-medicare/routes/write-service.ts — the M23 WRITE route-service
// CONTRACT (§4.1 mutating surface) + the per-command arg shapes + the cross-boundary PORTS the composition
// root binds at boot.
//
// Mirrors the M27 write-service.ts precedent: one interface the route handlers compose over, the command
// arg shapes, and the injected ports (the §4.10 transactional-outbox emitter, the §4.8 BullMQ producer, the
// M40 provider-CCN resolver, the M1 secret-cipher). The Drizzle backend (./write-service-drizzle)
// implements this. M23 carries NO PHI and NEVER the MBI digit (D13 / §3.6 / §8.7); money is INTEGER CENTS
// (D8). Every mutation emits its matching `m23.*` outbox event (events-by-m23.ts) in the SAME transaction
// (D2 outbox-only); the MAC-portal dispatch + the X12 generation are deferred to the §4.8 workers (the
// service emits the `*_requested` outbox row + records the submission attempt; the worker uploads and emits
// the terminal `submitted`/`accepted`/`rejected`).
import type { M23WriteActor } from "./actor";
import type {
  ClaimDetailView,
  ClaimSubmissionKind,
  MacCredentialView,
  NoeView,
  NotrView,
  OverrideRole,
  RuleConfigView,
  SequestrationPolicyView,
  ValidationOverrideView,
  ValidationSeverity,
} from "./read-service";

// ── injected ports (bound by the composition root at boot) ──────────────────────────────────────────────

/**
 * The §4.10 `m23.*` transactional-outbox emitter. `publish` writes the `outbox_event` row on the CALLER'S
 * tx so it commits in the same unit of work as the mutation; the dispatcher Value.Check's the payload
 * against the registered catalog schema (refuse-on-failure). Optional — best-effort until the dispatcher
 * binds (the M27 WriteOutboxPort precedent; the composition root passes `bindCallerModule("m23")`).
 */
export interface WriteOutboxPort {
  publish(
    tx: unknown,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/**
 * The §4.8 BullMQ producer for the M23 worker queues (`claim.submit`, `noe.submit`, `notr.submit`,
 * `validation-run`, `eligibility.refresh`). `enqueue` is idempotency-keyed by `dedupeKey`. The default
 * deny-stub mints a synthetic job id so a dev boot without a queue still returns a well-formed accepted view
 * (the M27 RecomputeEnqueuePort precedent).
 */
export interface JobEnqueuePort {
  enqueue(
    queueName: string,
    dedupeKey: string,
    payload: Record<string, unknown>,
  ): Promise<{ readonly jobId: string }>;
}

/**
 * Resolves the 6-char CMS Certification Number for a ProviderEntity (M40 directory) — needed to derive the
 * D4 deterministic `claim_control_number`. M23 may not import M40's package, so this is a typed PORT the
 * composition root binds; the default deny-stub fails CLOSED (the M27 ProviderEntityPort precedent).
 */
export interface ProviderCcnPort {
  ccnForProviderEntity(
    tx: unknown,
    organizationId: string,
    providerEntityId: string,
  ): Promise<string>;
}

/**
 * Encrypts a MAC-portal client secret under the per-tenant DEK (the M1 envelope-encryption helper) before it
 * is persisted to `mac_submitter_credential.client_secret_cipher`. The PLAINTEXT secret never enters the
 * repo; the service calls this port at the boundary. Fail-closed deny-stub default.
 */
export interface SecretCipherPort {
  encrypt(
    organizationId: string,
    plaintext: string,
  ): Promise<{ readonly cipher: string; readonly dekVersion: number }>;
}

/**
 * Records the §4.5 prominent M4 audit event for a validation override on the CALLER'S tx and returns its
 * `audit_event` id (persisted onto the NOT-NULL `validation_override.m4_audit_event_id`). M23 may not write
 * `audit_event` directly — it is a HELPER_ONLY_TABLE only `@wardenx/audit` may insert into — so the
 * composition root binds this port over the `@wardenx/audit` helper. Fail-closed deny-stub default (the
 * override route 503s until bound, never silently un-audited).
 */
export interface AuditEventPort {
  recordOverrideAudit(
    tx: unknown,
    input: {
      readonly organizationId: string;
      readonly actorMembershipId: string;
      readonly claimId: string;
      readonly validationRunId: string;
      readonly resultId: string;
      readonly ruleKey: string;
      readonly overrideRole: string;
      readonly reason: string;
    },
  ): Promise<{ readonly auditEventId: string }>;
}

/** Deps the production M23 write service binds at boot (P3) — every cross-boundary edge is a port. */
export interface M23WriteServicePorts {
  /** The §4.10 `m23.*` transactional-outbox emitter (best-effort until the dispatcher binds). */
  readonly outbox?: WriteOutboxPort;
  /** The §4.8 BullMQ producer for the M23 worker queues (fail-closed synthetic id default). */
  readonly jobs?: JobEnqueuePort;
  /** Resolves a ProviderEntity's CCN for control-number derivation (fail-closed default). */
  readonly providerCcn?: ProviderCcnPort;
  /** Encrypts the MAC-credential secret at the persistence boundary (fail-closed default). */
  readonly secretCipher?: SecretCipherPort;
  /** Records the prominent M4 override audit event + returns its id (fail-closed default). */
  readonly audit?: AuditEventPort;
  /** Injected clock (deterministic timestamps in tests). */
  readonly now?: () => Date;
}

// ── accepted-view return shapes (async enqueue endpoints) ───────────────────────────────────────────────

export interface ValidationJobAcceptedView {
  readonly claimId: string;
  readonly validationRunId: string;
  readonly jobId: string;
}
export interface ClaimSubmissionAcceptedView {
  readonly submissionId: string;
  readonly jobId: string;
  readonly attemptIndex: number;
  readonly claimControlNumber: string;
}
export interface NoticeSubmissionAcceptedView {
  readonly submissionId: string;
  readonly jobId: string;
  readonly kind: Extract<ClaimSubmissionKind, "noe" | "notr">;
}
export interface EligibilityCheckAcceptedView {
  readonly jobId: string;
  readonly patientId: string;
  readonly asOfServiceDate: string;
}

// ── command args ───────────────────────────────────────────────────────────────────────────────────────

/** One assembled claim line (the assembly orchestration derives these from clinical artifacts + HIPPS/SIA). */
export interface AssembledClaimLineInput {
  readonly lineNumber: number;
  /** UB-04 revenue code (the §3.3 `m23_claim_line_revenue_code` alphabet, e.g. `0651`). */
  readonly revenueCode: string;
  /** Q-code site-of-service (the `m23_claim_line_q_code` alphabet, e.g. `Q5001`). */
  readonly qCode: string;
  readonly levelOfCare:
    | "routine_home_care"
    | "continuous_home_care"
    | "inpatient_respite_care"
    | "general_inpatient_care";
  readonly hcpcsCode?: string;
  readonly serviceDateFrom: string;
  readonly serviceDateTo: string;
  readonly unitCount: number;
  readonly unitRateCents: number;
  readonly lineChargeCents: number;
  readonly levelOfCarePeriodId: string;
  readonly modifiers?: readonly string[];
  readonly icdPointerPositions?: readonly number[];
  readonly backingEncounterIds?: readonly string[];
}

export interface AssembleClaimArgs {
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly electionPeriodIdFrom: string;
  readonly electionPeriodIdTo: string;
  readonly patientPayerId: string;
  readonly tob: "811" | "812" | "813" | "814";
  readonly serviceFrom: string;
  readonly serviceTo: string;
  /** The MAC jurisdiction (the `m23_mac_jurisdiction` alphabet, e.g. `ngs_j6`). */
  readonly macJurisdiction: string;
  readonly lines: readonly AssembledClaimLineInput[];
  /** Defaults to the sum of the lines' `lineChargeCents` when omitted. */
  readonly totalChargeCents?: number;
  /** Defaults to `totalChargeCents` when omitted (real HIPPS/SIA pricing is a follow-up). */
  readonly totalExpectedPaymentCents?: number;
}

export interface UpdateDraftClaimArgs {
  readonly expectedVersion: number;
  readonly lines: readonly AssembledClaimLineInput[];
  readonly totalChargeCents?: number;
  readonly totalExpectedPaymentCents?: number;
}

export interface ReplaceClaimArgs {
  /** The §3.3 ≥40-char replacement reason (CHECK-enforced; the service refuses a shorter reason). */
  readonly reason: string;
  readonly lines: readonly AssembledClaimLineInput[];
  readonly totalChargeCents?: number;
  readonly totalExpectedPaymentCents?: number;
}

export interface VoidClaimArgs {
  readonly reason: string;
  /** A void (TOB 818) usually carries no service lines; default empty. */
  readonly lines?: readonly AssembledClaimLineInput[];
}

export interface OverrideValidationResultArgs {
  readonly validationResultId: string;
  /** ≥40 chars (CHECK-enforced). */
  readonly reason: string;
  readonly overrideRole: OverrideRole;
}

export interface CreateRuleConfigArgs {
  readonly ruleKey: string;
  readonly isCustom?: boolean;
  readonly enabled?: boolean;
  readonly severity: ValidationSeverity;
  readonly overrideRoleRequired?: OverrideRole;
  readonly parameters?: Record<string, unknown>;
  readonly predicateDsl?: unknown;
  readonly setReason?: string;
  readonly ruleVersion?: number;
}

export interface UpdateRuleConfigArgs {
  readonly expectedVersion: number;
  readonly enabled?: boolean;
  readonly severity?: ValidationSeverity;
  readonly overrideRoleRequired?: OverrideRole;
  readonly parameters?: Record<string, unknown>;
  readonly predicateDsl?: unknown;
  readonly setReason?: string;
}

export interface DeleteRuleConfigArgs {
  readonly expectedVersion: number;
}

export interface CancelNoeArgs {
  /** The §2.2 guard fact: the upstream m6 election was reversed (else the cancel is refused, GUARD_FAILED). */
  readonly electionReversed: boolean;
}
export interface CancelNotrArgs {
  /** The §2.2 guard fact: the terminating m6 event was reversed (else the cancel is refused). */
  readonly terminatingEventReversed: boolean;
}

export interface CheckEligibilityArgs {
  readonly patientId: string;
  readonly providerEntityId: string;
  readonly asOfServiceDate: string;
}

export interface ForwardDateSequestrationArgs {
  readonly providerEntityId: string;
  /** Decimal as text, e.g. `"2.00"`. */
  readonly percentage: string;
  /** YYYY-MM-DD — MUST be future-dated; `forwardDateSequestrationPolicy` rejects a non-future date at
   *  write time (DB-005 — this is no longer a DB CHECK, see write-service-drizzle.ts). */
  readonly effectiveFrom: string;
  readonly setReason?: string;
}

export interface UpsertMacCredentialArgs {
  readonly providerEntityId: string;
  readonly macJurisdiction: string;
  readonly submitterId: string;
  readonly tradingPartnerId: string;
  readonly clientId: string;
  /** Write-only plaintext; encrypted via {@link SecretCipherPort} before it reaches the repo (§3.6). */
  readonly clientSecret: string;
  readonly baaRecordRef?: string;
  readonly credentialExpiresAt?: string;
  /** Required on an update of an existing credential (§2.5 If-Match); absent on first create. */
  readonly expectedVersion?: number;
}

// ── the write service ─────────────────────────────────────────────────────────────────────────────────

/**
 * The M23 WRITE route-service contract — every mutating route in §4.1. Each method takes the server-
 * assembled {@link M23WriteActor}; the Drizzle backend opens one `withOrgContext` tx per call (RLS-scoped to
 * `app.org_id`), drives the pure @wardenx/billing machines for the state transitions, enforces §2.5 version
 * checks (VERSION_CONFLICT → 412), and emits the matching `m23.*` outbox event in the same tx. The §6/§D14
 * step-up gate (claim submit/replace/void, validation override, MAC-credential admin) is re-checked here at
 * dispatch in addition to the route guard. `claim_line` is INTERNAL-WRITE-ONLY — only `assembleClaim` /
 * `updateDraftClaim` (re-assembly) / `replaceClaim` / `voidClaim` write lines; there is no line route.
 */
export interface M23WriteRouteService {
  // ── claim assembly + lifecycle ──
  assembleClaim(actor: M23WriteActor, args: AssembleClaimArgs): Promise<ClaimDetailView>;
  updateDraftClaim(
    actor: M23WriteActor,
    claimId: string,
    args: UpdateDraftClaimArgs,
  ): Promise<ClaimDetailView>;
  deleteDraftClaim(actor: M23WriteActor, claimId: string): Promise<void>;
  validateClaim(actor: M23WriteActor, claimId: string): Promise<ValidationJobAcceptedView>;
  submitClaim(actor: M23WriteActor, claimId: string): Promise<ClaimSubmissionAcceptedView>;
  replaceClaim(
    actor: M23WriteActor,
    claimId: string,
    args: ReplaceClaimArgs,
  ): Promise<ClaimDetailView>;
  voidClaim(actor: M23WriteActor, claimId: string, args: VoidClaimArgs): Promise<ClaimDetailView>;

  // ── validation override ──
  overrideValidationResult(
    actor: M23WriteActor,
    claimId: string,
    args: OverrideValidationResultArgs,
  ): Promise<ValidationOverrideView>;

  // ── rule-config CRUD (tenant overlay; D5 platform-floor protected) ──
  createRuleConfig(actor: M23WriteActor, args: CreateRuleConfigArgs): Promise<RuleConfigView>;
  updateRuleConfig(
    actor: M23WriteActor,
    ruleConfigId: string,
    args: UpdateRuleConfigArgs,
  ): Promise<RuleConfigView>;
  deleteRuleConfig(
    actor: M23WriteActor,
    ruleConfigId: string,
    args: DeleteRuleConfigArgs,
  ): Promise<void>;

  // ── NOE / NOTR fast path ──
  submitNoe(actor: M23WriteActor, noeId: string): Promise<NoticeSubmissionAcceptedView>;
  cancelNoe(actor: M23WriteActor, noeId: string, args: CancelNoeArgs): Promise<NoeView>;
  submitNotr(actor: M23WriteActor, notrId: string): Promise<NoticeSubmissionAcceptedView>;
  cancelNotr(actor: M23WriteActor, notrId: string, args: CancelNotrArgs): Promise<NotrView>;

  // ── eligibility ──
  checkEligibility(
    actor: M23WriteActor,
    args: CheckEligibilityArgs,
  ): Promise<EligibilityCheckAcceptedView>;

  // ── sequestration policy (forward-only) ──
  forwardDateSequestrationPolicy(
    actor: M23WriteActor,
    args: ForwardDateSequestrationArgs,
  ): Promise<SequestrationPolicyView>;

  // ── MAC credentials (step-up; secret encrypted at the boundary) ──
  upsertMacCredential(
    actor: M23WriteActor,
    args: UpsertMacCredentialArgs,
  ): Promise<MacCredentialView>;
}
