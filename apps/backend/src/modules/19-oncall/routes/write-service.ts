// apps/backend/src/modules/19-oncall/routes/write-service.ts — M19-T07, the §4.1 WRITE port + its command
// inputs. The Drizzle implementation is ./write-service-drizzle.ts.
//
// SHAPE OF EVERY COMMAND, without exception: open `withOrgContext` (RLS pins app.org_id) → load the
// aggregate row → run the PURE §2.2-§2.7 decision (`../lifecycle`, `../roster`) over already-resolved
// cross-module facts → execute the transition's DECLARED side effects (`./effects-runner`) and apply the
// row change under the §2.5 optimistic-concurrency guard → emit the §4.10 outbox event on the SAME tx.
// No business rule lives in SQL, and no event can outlive a rolled-back write (§2.4).
//
// THE ACTING MEMBERSHIP IS NEVER AN INPUT. Every command takes an `M19WriteActor` the route extracted from
// `request.context`, and every attribution column is stamped from it — `answered_by_membership_id`,
// `actor_membership_id`, `resolved_by_membership_id`. §8.3.3's repudiation controls ARE those columns.
// The ONE membership id a caller may supply is `escalatedToMembershipId` (an escalation is by definition
// addressed to a SECOND person), and §3.3's recipient CHECK plus the `escalation_recipient` predicate are
// what keep that honest.
//
// THE M4 WRITE-AUDIT TRIGGERS (migration 0108) record every mutation with the per-table §3.6 denylist, so
// this layer never hand-writes an audit row — the denylisted columns (`caller_phone_e164`,
// `caller_quote_cipher`, `transcript_cipher`, `chief_complaint_text`, `answer_value_text`,
// `trigger_detail`, `resolution`, `cancellation_reason`, `compensation_metadata`) are scrubbed at the
// trigger, which is why they may be written here in full.
import type {
  IsoInstant,
  M19EventName,
  MembershipId,
  OncallShiftDiscipline,
  TriageCallCallerKind,
  TriageCallInboundChannel,
  TriageDispositionData,
  TriageEscalationTier,
  TriageRedFlagMatch,
} from "@wardenx/types";
import type { TriageAnswerValue } from "../lifecycle/protocol";
import type { M19WriteActor } from "./actor";
import type {
  EscalationInboxItem,
  OnCallShiftView,
  OncallPolicyView,
  TriageCallDetail,
  TriageProtocolView,
  VendorBindingView,
  VendorTriageCallView,
} from "./read-service";

/**
 * The transactional-outbox emission the write service publishes on the mutation's own tx (§4.10).
 *
 * `organizationId` is on the envelope AND repeated inside every payload (`M19TriageCallEventBase.orgId`),
 * and both are deliberate: `outbox_event.organization_id` is NOT NULL and is what the dispatcher's RLS
 * scopes delivery by, while the payload copy is what M14's packet reader, M16's bereavement intake and
 * M36's alert router read when they have the payload alone.
 */
export interface OutboxEmission {
  readonly eventName: M19EventName;
  readonly payload: Record<string, unknown>;
  readonly organizationId: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
}

/** The catalog-validating publisher the composition root binds (`callerModule` pinned to `m19`). */
export interface WriteOutboxPort {
  publish(tx: unknown, emission: OutboxEmission): Promise<void>;
}

/**
 * The §4.9 typed M36 alert port. BEST-EFFORT and outside the transaction's failure path: M36 owns
 * delivery, retry and DLQ, and a triage call must not roll back because an SMS gateway is down. §2.7's
 * class D-D is the designed answer to that outage — the org-admin status surface shows the tenant's own
 * after-hours number — not a failed write.
 */
export interface AlertPort {
  emit(input: {
    organizationId: string;
    kind: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

/** Every state-transition command echoes the `If-Match` version it read (§2.5). */
interface Versioned {
  /** The row `version` the caller read, from `If-Match`. A mismatch is 412 `STALE_VERSION`. */
  readonly expectedVersion?: number;
}

export interface OpenTriageCallInput {
  readonly providerEntityId: string;
  readonly inboundChannel: TriageCallInboundChannel;
  readonly callerKind: TriageCallCallerKind;
  readonly callerDisplayName?: string;
  readonly callerPhoneE164?: string;
  readonly callerRelationshipLabel?: string;
  readonly patientId?: string;
  readonly admissionId?: string;
  readonly callerCaregiverId?: string;
  readonly chiefComplaintText?: string;
  readonly chiefComplaintSnomed?: string;
  /** Encrypted under the per-tenant DEK envelope before persist (D14); never stored plaintext. */
  readonly callerQuote?: string;
}

export interface IdentifyPatientInput extends Versioned {
  readonly patientId: string;
  readonly admissionId: string;
  readonly locationId?: string;
  readonly callerCaregiverId?: string;
}

export interface ApplyProtocolInput extends Versioned {
  readonly triageProtocolId: string;
  /** D12 / §8.6 — required (≥10 chars) only when the overridden suggestion was at/above the 0.75 floor. */
  readonly aiOverrideReason?: string;
}

export interface RecordAnswerInput extends Versioned {
  readonly triageProtocolQuestionId: string;
  readonly value: TriageAnswerValue;
}

export interface CorrectAnswerInput extends RecordAnswerInput {
  readonly correctionReason?: string;
}

export interface AwaitingCallbackInput extends Versioned {
  readonly reason: string;
  readonly callbackTargetAt?: IsoInstant;
}

export interface SelectDispositionInput extends Versioned {
  readonly dispositionData: TriageDispositionData;
}

export interface DocumentCallInput extends Versioned {
  readonly narrativeSummary?: string;
}

export interface AbandonCallInput extends Versioned {
  readonly reason: string;
  readonly callbackAttempts: number;
}

/** F-217 — who the summary is for (the wire `recipientKind`). */
export type TriageSummaryRecipientKind = "caregiver" | "attending";

export interface RequestSummaryInput {
  readonly recipientKind: TriageSummaryRecipientKind;
}

export interface RequestSummaryResult {
  readonly requested: true;
  readonly triageCallId: string;
  readonly recipientKind: TriageSummaryRecipientKind;
  readonly requestedAt: string;
}

export interface EscalateInput extends Versioned {
  readonly tier: TriageEscalationTier;
  readonly reason: string;
  readonly escalatedToMembershipId?: MembershipId;
  readonly escalatedToExternalActorId?: string;
  /** §2.2.1 — also move the CALL to `escalated_unresolved` (the hand-off), not merely record a rung. */
  readonly handOffCall?: boolean;
}

export interface ResolveEscalationInput extends Versioned {
  readonly resolution: string;
}

export interface CreateShiftInput {
  readonly providerEntityId: string;
  readonly shiftStartsAt: IsoInstant;
  readonly shiftEndsAt: IsoInstant;
  readonly discipline: OncallShiftDiscipline;
  readonly primaryOnCallMembershipId?: MembershipId;
  readonly backupMembershipId?: MembershipId;
  readonly externalActorId?: string;
  readonly externalActorLabel?: string;
}

export interface CancelShiftInput extends Versioned {
  readonly reason: string;
}

export type ShiftTransitionInput = Versioned;

export interface PatchPolicyInput extends Versioned {
  readonly providerEntityId: string;
  readonly model?: "direct" | "hybrid" | "centralized";
  readonly escalationTiers?: Record<string, unknown>;
  readonly callbackSlaPerSeverity?: Record<string, unknown>;
  readonly stateOverrides?: Record<string, unknown>;
  readonly externalTriageVendorId?: string | null;
  readonly emergencyContactE164?: string | null;
  readonly aiProtocolSuggestionEnabled?: boolean;
  readonly aiHospitalizationRiskEnabled?: boolean;
}

export interface ProtocolQuestionInput {
  readonly questionOrder: number;
  readonly prompt: string;
  readonly answerType: "boolean" | "integer" | "scale_0_10" | "free_text" | "enum";
  readonly answerEnumValues?: readonly string[] | null;
  readonly required?: boolean;
  readonly isRedFlagQuestion?: boolean;
  readonly redFlagMatch?: TriageRedFlagMatch | null;
}

export interface CreateProtocolInput {
  readonly key: string;
  readonly chiefComplaintLabel: string;
  readonly snomedCode: string;
  readonly disciplineRequired: string;
  readonly requiresMandatoryEscalation?: boolean;
  readonly mandatoryEscalationTier?: TriageEscalationTier | null;
  readonly version?: string;
  readonly effectiveFrom?: IsoInstant;
  readonly effectiveTo?: IsoInstant | null;
  readonly sortOrder?: number;
  readonly questions?: readonly ProtocolQuestionInput[];
}

export interface PatchProtocolInput {
  readonly chiefComplaintLabel?: string;
  readonly snomedCode?: string;
  readonly disciplineRequired?: string;
  readonly requiresMandatoryEscalation?: boolean;
  readonly mandatoryEscalationTier?: TriageEscalationTier | null;
  readonly version?: string;
  readonly effectiveTo?: IsoInstant | null;
  readonly sortOrder?: number;
}

export interface CreateVendorBindingInput {
  readonly mdmVendorId: string;
  readonly name: string;
  readonly adapterKey: string;
  readonly rnCoverageAttested: boolean;
  readonly baaInEffect: boolean;
  readonly baaExpiresOn?: string | null;
  readonly defaultMinimizationPolicy: { readonly profile: string } & Record<string, unknown>;
}

export interface PatchVendorBindingInput {
  readonly rnCoverageAttested?: boolean;
  readonly baaInEffect?: boolean;
  readonly baaExpiresOn?: string | null;
}

/** §2.7 step 3 — the BCP paper-origin re-entry (permission `triage.paper_reentry`, step-up). */
export interface PaperReentryInput {
  readonly worklistId: string;
  readonly providerEntityId: string;
  readonly paperOriginalOpenedAt: IsoInstant;
  readonly inboundChannel: TriageCallInboundChannel;
  readonly callerKind: TriageCallCallerKind;
  readonly patientId?: string;
  readonly admissionId?: string;
  readonly chiefComplaintText?: string;
  readonly callerDisplayName?: string;
}

/** §4.2's open response — the created call plus what the D11/D12 advisories had to say about it. */
export interface OpenTriageCallResult {
  readonly triageCallId: string;
  readonly state: "open";
  readonly onCallShiftId: string;
  readonly version: number;
  /** D12 — the M32 suggestion, when the tenant enabled it and the seam answered. `null` otherwise. */
  readonly suggestedProtocolId: string | null;
  readonly suggestedProtocolConfidence: string | null;
  /** D11 — the advisory band. Gates nothing; excluded from the portal projection. */
  readonly hospitalizationRiskBand: string | null;
  /** §8.6 — true when the AI block must render VISIBLY DISABLED (deny-stubbed M32, or tenant opted out). */
  readonly aiBlockDisabled: boolean;
}

/**
 * §7.1 / §7.2's answer response — the D5 verdict the panel's sticky banner keys off.
 *
 * Named `AnswerWriteResult`, not `RecordAnswerResult`: `../lifecycle/protocol` already exports the latter
 * for the PURE decision's `{ redFlagHit, effects }` shape, and the module barrel re-exports both. Two
 * different records of "what happened when an answer was recorded" sharing one name is exactly the drift a
 * later reader resolves by picking whichever import their editor offered.
 */
export interface AnswerWriteResult {
  readonly answerId: string;
  readonly redFlagHit: boolean;
  readonly mandatoryEscalationTriggered: boolean;
  readonly escalationId: string | null;
  readonly tier: TriageEscalationTier | null;
  readonly nextQuestionId: string | null;
  readonly version: number;
}

/** The §4.1 WRITE surface. */
export interface M19WriteService {
  // §4.1 rows 1, 4-13 — the triage-call lifecycle
  openTriageCall(actor: M19WriteActor, input: OpenTriageCallInput): Promise<OpenTriageCallResult>;
  identifyPatient(
    actor: M19WriteActor,
    triageCallId: string,
    input: IdentifyPatientInput,
  ): Promise<TriageCallDetail | VendorTriageCallView>;
  applyProtocol(
    actor: M19WriteActor,
    triageCallId: string,
    input: ApplyProtocolInput,
  ): Promise<TriageCallDetail | VendorTriageCallView>;
  recordAnswer(
    actor: M19WriteActor,
    triageCallId: string,
    input: RecordAnswerInput,
  ): Promise<AnswerWriteResult>;
  correctAnswer(
    actor: M19WriteActor,
    triageCallId: string,
    answerId: string,
    input: CorrectAnswerInput,
  ): Promise<AnswerWriteResult>;
  completeProtocol(
    actor: M19WriteActor,
    triageCallId: string,
    input: Versioned,
  ): Promise<TriageCallDetail | VendorTriageCallView>;
  markAwaitingCallback(
    actor: M19WriteActor,
    triageCallId: string,
    input: AwaitingCallbackInput,
  ): Promise<TriageCallDetail | VendorTriageCallView>;
  resumeAfterCallback(
    actor: M19WriteActor,
    triageCallId: string,
    input: Versioned,
  ): Promise<TriageCallDetail | VendorTriageCallView>;
  selectDisposition(
    actor: M19WriteActor,
    triageCallId: string,
    input: SelectDispositionInput,
  ): Promise<TriageCallDetail | VendorTriageCallView>;
  documentCall(
    actor: M19WriteActor,
    triageCallId: string,
    input: DocumentCallInput,
  ): Promise<TriageCallDetail | VendorTriageCallView>;
  abandonCall(
    actor: M19WriteActor,
    triageCallId: string,
    input: AbandonCallInput,
  ): Promise<TriageCallDetail | VendorTriageCallView>;

  /** F-217 — emit `m19.triage.summary_requested` for a documented/closed call (M22 renders it). */
  requestSummary(
    actor: M19WriteActor,
    triageCallId: string,
    input: RequestSummaryInput,
  ): Promise<RequestSummaryResult>;

  // §4.1 rows 15, 17-18 — escalations
  escalate(
    actor: M19WriteActor,
    triageCallId: string,
    input: EscalateInput,
  ): Promise<EscalationInboxItem>;
  acknowledgeEscalation(
    actor: M19WriteActor,
    escalationId: string,
    input: Versioned,
  ): Promise<EscalationInboxItem>;
  resolveEscalation(
    actor: M19WriteActor,
    escalationId: string,
    input: ResolveEscalationInput,
  ): Promise<EscalationInboxItem>;

  // §4.1 rows 20-23 — shifts
  createShift(actor: M19WriteActor, input: CreateShiftInput): Promise<OnCallShiftView>;
  cancelShift(
    actor: M19WriteActor,
    shiftId: string,
    input: CancelShiftInput,
  ): Promise<OnCallShiftView>;
  openShift(
    actor: M19WriteActor,
    shiftId: string,
    input: ShiftTransitionInput,
  ): Promise<OnCallShiftView>;
  closeShift(
    actor: M19WriteActor,
    shiftId: string,
    input: ShiftTransitionInput,
  ): Promise<OnCallShiftView>;

  // §4.1 row 26 — policy
  patchPolicy(actor: M19WriteActor, input: PatchPolicyInput): Promise<OncallPolicyView>;

  // §4.1 rows 29-32 — the protocol catalog (tenant rows only)
  createProtocol(actor: M19WriteActor, input: CreateProtocolInput): Promise<TriageProtocolView>;
  patchProtocol(
    actor: M19WriteActor,
    protocolId: string,
    input: PatchProtocolInput,
  ): Promise<TriageProtocolView>;
  addProtocolQuestion(
    actor: M19WriteActor,
    protocolId: string,
    input: ProtocolQuestionInput,
  ): Promise<TriageProtocolView>;
  patchProtocolQuestion(
    actor: M19WriteActor,
    questionId: string,
    input: Partial<ProtocolQuestionInput>,
  ): Promise<TriageProtocolView>;

  // §4.1 rows 34-35 — vendor bindings
  createVendorBinding(
    actor: M19WriteActor,
    input: CreateVendorBindingInput,
  ): Promise<VendorBindingView>;
  patchVendorBinding(
    actor: M19WriteActor,
    vendorId: string,
    input: PatchVendorBindingInput,
  ): Promise<VendorBindingView>;

  // §2.7 — the BCP paper-origin re-entry
  reenterPaperCall(actor: M19WriteActor, input: PaperReentryInput): Promise<OpenTriageCallResult>;
}
