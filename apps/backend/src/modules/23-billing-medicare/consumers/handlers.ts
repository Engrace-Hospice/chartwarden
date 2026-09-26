// apps/backend/src/modules/23-billing-medicare/consumers/handlers.ts — the §4.4 / §4.10 UPSTREAM-event
// handlers (PURE, port-injected). Mirrors the M27 `27-cost-report/consumers/handlers.ts` precedent: one pure
// handler per subscribed topic family (`./subscription-map.ts`), each projecting the structurally-minimal
// upstream event into its M23 effect and fanning it out through the injected {@link M23ConsumerPorts}.
//
// PURITY / BOUNDARIES (RULE 1 & 2): NO DB, NO BullMQ, NO Fastify, NO direct M5/M6/M8/M18/M22/M40 import, NO
// `getSeam` at import — the upstream event STRING + its payload SHAPE is the entire contract. The effect
// ports are INJECTED; at the composition root the integrator binds them to the real Drizzle-backed services
// (the noe/notr-assembly services, the `revalidate.consumer` enqueue, the claim freeze writer, the M22 back-
// ref writer), and any unlanded port stays a LAZY fail-closed thunk so a throw happens only when a JOB RUNS,
// never at port-bundle construction (RULE 4 / the M34 eager-bind gotcha). These handlers are NOT boot-wired
// to a running subscriber (RULE 3(d)) — they ship pure + the subscription map; the live inbound dispatcher is
// a later platform phase.
//
// LIVE vs DENY-STUB: M5/M6/M8/M18/M25/M40 are LOCKED → their handlers run live (M25's four 835-posting
// topics joined at GAP-037; they had been deny-stubs since long after M25 merged and started emitting
// them). M26 has not landed → its handler is a FORWARD-SEAM DENY-STUB that fail-closes when invoked (the
// topic is declared for §4.10 completeness but never bound at boot; `registerM23Consumers` binds only
// LIVE topics).
//
// NO PHI / NO MBI in any payload (D13, §3.6) — every slice is IDs + dates + control numbers only.
import {
  type DocumentBackRefTarget,
  type M23DocumentRenderKind,
  resolveDocumentBackRefTarget,
} from "./document-render";
import {
  type M23SubscriptionEffect,
  type NotrTriggerKind,
  RE_VALIDATION_TRIGGER,
  effectsForTopic,
} from "./subscription-map";

// ── the structured per-topic consume report (for the §4.10 fan-out test) ─────────────────────────────────

/** What handling one upstream event did — the effects applied + the concrete ids touched. */
export interface UpstreamConsumeReport {
  readonly eventName: string;
  /** The effect kinds the topic projected to (in order). */
  readonly effects: readonly M23SubscriptionEffect["kind"][];
  /** The noe / notr / claim / revalidate-job ids the handler acted on (for the fan-out assertion). */
  readonly actedOnIds: readonly string[];
}

/** The §4.4 effect kinds present in the subscription map for a topic (the dispatcher's routing hint). */
export function effectKindsForTopic(topic: string): readonly M23SubscriptionEffect["kind"][] {
  return effectsForTopic(topic).map((effect) => effect.kind);
}

// ── injected effect ports (bound to the Drizzle-backed services + the outbox at the composition root) ────

/** The fact descriptor the §8 `revalidate.consumer` worker (task 54) uses to find affected claims. Carries
 *  only the changed-entity ids the worker needs to scope its VALIDATING/READY claim query (no PHI). */
export interface RevalidationFact {
  /** The upstream topic that triggered the re-validate (provenance for the worker's idempotency key). */
  readonly sourceTopic: string;
  /** The validation_run trigger to stamp (always `re_validation_after_correction` for the fan-out, D1). */
  readonly trigger: typeof RE_VALIDATION_TRIGGER;
  /** The changed-entity ids the worker scopes affected claims by (any subset present in the upstream event). */
  readonly patientId?: string;
  readonly admissionId?: string;
  readonly electionPeriodId?: string;
  readonly encounterId?: string;
  readonly visitId?: string;
  readonly providerEntityId?: string;
  readonly canonicalEntityId?: string;
}

/**
 * The effect ports the handlers fan out through (INJECTED at boot, RULE 2). Each is `async` so the binding
 * can wrap the write/enqueue in `withOrgContext` + the transactional outbox; the pure handlers never touch
 * the DB. An unlanded port binds to a LAZY fail-closed thunk (throws only when the handler runs), never a
 * no-op. The noe/notr-assembly + freeze + back-ref ports own their OWN `m23.*` outbox emit in their bound tx
 * (D2), so the handlers do not emit directly.
 */
export interface M23ConsumerPorts extends RemittanceTransitionPort {
  /**
   * Create a `noe_record` DRAFT from a signed election (task 47) + emit `m23.noe.draft_created` in-tx. Returns
   * the new id, or `null` when the binding decides the election is not NOE-eligible (idempotent / already
   * drafted — a deliberate no-op).
   */
  readonly createNoeDraft: (input: NoeDraftRequest) => Promise<{ readonly noeId: string } | null>;
  /**
   * Create a `notr_record` DRAFT from an M6 revocation / transfer-out / discharge (task 50) + emit
   * `m23.notr.draft_created` in-tx. Returns the new id, or `null` for an idempotent no-op (already drafted).
   */
  readonly createNotrDraft: (
    input: NotrDraftRequest,
  ) => Promise<{ readonly notrId: string } | null>;
  /**
   * Enqueue the §8 `revalidate.consumer` job (task 54) for a changed upstream fact. The worker finds every
   * affected claim in VALIDATING/READY and enqueues a `validation_run` (idempotent on `(eventId, claimId)`).
   */
  readonly enqueueRevalidation: (input: {
    readonly organizationId: string;
    readonly triggeringEventId: string;
    readonly fact: RevalidationFact;
  }) => Promise<{ readonly revalidationJobId: string }>;
  /**
   * Freeze new-claim creation for a patient (task 53) — `m5.patient.deceased` / an M40 canonical change that
   * invalidates the provider entity. Idempotent; only the discharge/bereavement claim path proceeds after.
   */
  readonly freezeNewClaims: (input: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly reason: string;
    readonly triggeringEventId: string;
  }) => Promise<void>;
  /**
   * Record an M22-returned `document_id` as the back-ref on the resolved `noe_record` / `notr_record` /
   * `claim` row + column (task 57). Idempotent on `(triggeringEventId, aggregateId)` per §2.6.
   */
  readonly recordDocumentBackReference: (input: {
    readonly target: DocumentBackRefTarget;
    readonly aggregateId: string;
    readonly documentId: string;
    readonly triggeringEventId: string;
  }) => Promise<void>;
}

/** The noe-assembly request the {@link M23ConsumerPorts.createNoeDraft} port persists (task 47). */
export interface NoeDraftRequest {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly electionPeriodId: string;
  readonly electionEffectiveDate: string;
  /** The originating `m6.election.signed` outbox-event id (→ §2.6 idempotency on the draft create). */
  readonly triggeringEventId: string;
}

/** The notr-assembly request the {@link M23ConsumerPorts.createNotrDraft} port persists (task 50). */
export interface NotrDraftRequest {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly trigger: NotrTriggerKind;
  readonly terminationEffectiveDate: string;
  /** The originating M6 outbox-event id (→ §2.6 idempotency on the draft create). */
  readonly triggeringEventId: string;
}

// ── per-topic event payload shapes (the structurally-minimal slice M23 reads) ────────────────────────────

/** `m6.election.signed` (M6) → NOE draft (task 47). */
export interface ElectionSignedEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly electionPeriodId: string;
  readonly electionEffectiveDate: string;
}

/** `m6.revocation.created` / `m6.discharge.created` (M6) → NOTR draft (task 50). */
export interface NotrTriggerEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly terminationEffectiveDate: string;
}

/** `m6.transfer.created` (M6) → NOTR draft ONLY when `direction === 'out'` (task 50). */
export interface TransferCreatedEvent extends NotrTriggerEvent {
  readonly direction: "in" | "out";
}

/** `m5.patient.deceased` (M5) → freeze new claims + re-validate in-flight (task 53). */
export interface PatientDeceasedEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly deceasedDate: string;
}

/**
 * The generic re-validate-trigger slice (task 53) shared by `m6.cti.signed` / `m6.f2f.attested` /
 * `m6.loc.changed` / `m8.encounter.signed` / `m8.encounter.cosigned` / `m18.evv.late_check_resolved` /
 * the M40 canonical-update topic. Every changed-entity id is OPTIONAL — the worker scopes affected claims by
 * whichever ids the upstream event carries.
 */
export interface RevalidateTriggerEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly patientId?: string;
  readonly admissionId?: string;
  readonly electionPeriodId?: string;
  readonly encounterId?: string;
  readonly visitId?: string;
  readonly providerEntityId?: string;
  readonly canonicalEntityId?: string;
}

/**
 * The minimal `m22.document.rendered` payload M23 reads (task 57). M22 fans this event out to every
 * requesting module; M23 acts ONLY when the rendered document back-references an M23 render request — keyed
 * by `sourceModule === 'm23'` AND a recognized M23 `kind` that maps to a back-ref column. Everything else is
 * a deliberate no-op (fail-closed: M23 never writes a back-ref for a document it did not request).
 */
export interface DocumentRenderedEvent {
  readonly eventId: string;
  /** The requesting module the M22 render handshake echoes back (`'m23'` for an M23 document). */
  readonly sourceModule: string;
  /** The render kind M23 requested (one of the four §4.10 kinds); other strings are not M23 documents. */
  readonly kind: string;
  /** The originating M23 aggregate row id (noe_record / notr_record / claim) M23 carried in the request. */
  readonly aggregateId: string;
  /** The MinIO-stored document id M22 minted and returned. */
  readonly documentId: string;
}

// ── pure helpers ─────────────────────────────────────────────────────────────────────────────────────────

/** Narrow an arbitrary `kind` string to the M23 render-kind union, or `null` if it is not one of ours. */
function asM23RenderKind(kind: string): M23DocumentRenderKind | null {
  return kind === "noe_confirmation_receipt" ||
    kind === "notr_confirmation_receipt" ||
    kind === "claim_acknowledgment_letter" ||
    kind === "denial_appeal_cover_letter"
    ? kind
    : null;
}

/** The fail-closed error a DENY-STUB consumer raises when an unlanded upstream module's event is delivered. */
export class ForwardSeamNotLandedError extends Error {
  readonly code = "FORWARD_SEAM_UNBOUND" as const;
  constructor(topic: string, ownerModule: string) {
    super(`m23 consumer for "${topic}" is a forward-seam deny-stub until ${ownerModule} lands`);
    this.name = "ForwardSeamNotLandedError";
  }
}

// ── LIVE handlers (M5/M6/M8/M18/M40) ─────────────────────────────────────────────────────────────────────

/**
 * `m6.election.signed` → create a `noe_record` DRAFT (task 47). The bound port computes the 5-day filing
 * window + emits `m23.noe.draft_created` in its own tx; an idempotent no-op (already drafted) returns `null`.
 */
export async function handleElectionSigned(
  event: ElectionSignedEvent,
  ports: M23ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  const created = await ports.createNoeDraft({
    organizationId: event.organizationId,
    providerEntityId: event.providerEntityId,
    admissionId: event.admissionId,
    patientId: event.patientId,
    electionPeriodId: event.electionPeriodId,
    electionEffectiveDate: event.electionEffectiveDate,
    triggeringEventId: event.eventId,
  });
  return {
    eventName: "m6.election.signed",
    effects: created ? ["create_noe_draft"] : [],
    actedOnIds: created ? [created.noeId] : [],
  };
}

/** `m6.revocation.created` → create a `notr_record` DRAFT (trigger `revocation`, task 50). */
export async function handleRevocationCreated(
  event: NotrTriggerEvent,
  ports: M23ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  return createNotrFrom("m6.revocation.created", "revocation", event, ports);
}

/** `m6.discharge.created` → create a `notr_record` DRAFT (trigger `discharge`, task 50). */
export async function handleDischargeCreated(
  event: NotrTriggerEvent,
  ports: M23ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  return createNotrFrom("m6.discharge.created", "discharge", event, ports);
}

/**
 * `m6.transfer.created` → create a `notr_record` DRAFT (trigger `transfer_out`) ONLY for a transfer-OUT
 * (task 50). A transfer-IN is a deliberate no-op (fail-closed — a transfer-in seeds an inherited-sequence
 * claim, not a NOTR).
 */
export async function handleTransferCreated(
  event: TransferCreatedEvent,
  ports: M23ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  if (event.direction !== "out") {
    return { eventName: "m6.transfer.created", effects: [], actedOnIds: [] };
  }
  return createNotrFrom("m6.transfer.created", "transfer_out", event, ports);
}

/** Shared NOTR-draft fan-out for the three M6 triggers (revocation / discharge / transfer-out). */
async function createNotrFrom(
  eventName: string,
  trigger: NotrTriggerKind,
  event: NotrTriggerEvent,
  ports: M23ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  const created = await ports.createNotrDraft({
    organizationId: event.organizationId,
    providerEntityId: event.providerEntityId,
    admissionId: event.admissionId,
    patientId: event.patientId,
    trigger,
    terminationEffectiveDate: event.terminationEffectiveDate,
    triggeringEventId: event.eventId,
  });
  return {
    eventName,
    effects: created ? ["create_notr_draft"] : [],
    actedOnIds: created ? [created.notrId] : [],
  };
}

/**
 * `m5.patient.deceased` → freeze new-claim creation for the decedent + re-validate every in-flight claim
 * (task 53). Two effects in order: the freeze (only the discharge/bereavement path proceeds after) then the
 * re-validate enqueue (date-of-death-dependent rules re-run on VALIDATING/READY claims).
 */
export async function handlePatientDeceased(
  event: PatientDeceasedEvent,
  ports: M23ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  await ports.freezeNewClaims({
    organizationId: event.organizationId,
    patientId: event.patientId,
    reason: "patient_deceased",
    triggeringEventId: event.eventId,
  });
  const { revalidationJobId } = await ports.enqueueRevalidation({
    organizationId: event.organizationId,
    triggeringEventId: event.eventId,
    fact: {
      sourceTopic: "m5.patient.deceased",
      trigger: RE_VALIDATION_TRIGGER,
      patientId: event.patientId,
    },
  });
  return {
    eventName: "m5.patient.deceased",
    effects: ["freeze_new_claims", "revalidate"],
    actedOnIds: [event.patientId, revalidationJobId],
  };
}

/**
 * The generic re-validate handler (task 53) for `m6.cti.signed` / `m6.f2f.attested` / `m6.loc.changed` /
 * `m8.encounter.signed` / `m8.encounter.cosigned` / `m18.evv.late_check_resolved` / the M40 canonical-update
 * topic. Enqueues the §8 `revalidate.consumer` job carrying the changed-fact descriptor; the worker (task 54)
 * resolves affected claims + stamps `trigger='re_validation_after_correction'` (idempotent on `(eventId,
 * claimId)`).
 */
export async function handleRevalidateTrigger(
  eventName: string,
  event: RevalidateTriggerEvent,
  ports: M23ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  const { revalidationJobId } = await ports.enqueueRevalidation({
    organizationId: event.organizationId,
    triggeringEventId: event.eventId,
    fact: {
      sourceTopic: eventName,
      trigger: RE_VALIDATION_TRIGGER,
      patientId: event.patientId,
      admissionId: event.admissionId,
      electionPeriodId: event.electionPeriodId,
      encounterId: event.encounterId,
      visitId: event.visitId,
      providerEntityId: event.providerEntityId,
      canonicalEntityId: event.canonicalEntityId,
    },
  });
  return { eventName, effects: ["revalidate"], actedOnIds: [revalidationJobId] };
}

/**
 * `m22.document.rendered` → record the M22-returned `document_id` as the back-ref on the resolved
 * `noe_record` / `notr_record` / `claim` row (task 57). FAIL-CLOSED on every off-path: a document another
 * module requested (`sourceModule !== 'm23'`), an unrecognized `kind`, or a kind with NO back-ref column
 * (`denial_appeal_cover_letter`) is a deliberate no-op — never a stray back-ref write.
 */
export async function handleDocumentRendered(
  event: DocumentRenderedEvent,
  ports: M23ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  const empty: UpstreamConsumeReport = {
    eventName: "m22.document.rendered",
    effects: [],
    actedOnIds: [],
  };
  if (event.sourceModule !== "m23") return empty;
  const kind = asM23RenderKind(event.kind);
  if (kind === null) return empty;
  const target = resolveDocumentBackRefTarget(kind);
  if (target === null) return empty; // denial_appeal_cover_letter — no back-ref column (deliberate).

  await ports.recordDocumentBackReference({
    target,
    aggregateId: event.aggregateId,
    documentId: event.documentId,
    triggeringEventId: event.eventId,
  });
  return {
    eventName: "m22.document.rendered",
    effects: ["record_document_back_reference"],
    actedOnIds: [event.aggregateId],
  };
}

// ── M25 remittance → claim adjudication (task 55 / GAP-037 — LIVE) ───────────────────────────────────────

/** The M25 835-posting slice M23 reads (§2.4 / architecture §11.A). No PHI — ids, codes and amounts. */
export interface RemittancePostedEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly claimId: string;
  /** The `remittance_advice` the line posted under — stamped on `claim_state_history` + every emitted event. */
  readonly remittanceAdviceId: string;
  readonly remittanceLineId?: string;
  /** ISO instant the 835 posted (M25's `advice.received_at`). */
  readonly postedAt?: string;
  /** Present on `claim_paid` / `claim_partial_paid` (decimal string, e.g. "1234.56"). */
  readonly paidAmount?: string;
  /** Present on `claim_denied` — the CARC codes that made it a denial. */
  readonly carcCodes?: readonly string[];
  /** Present on `claim_recouped` (decimal string). */
  readonly recoupedAmount?: string;
}

/**
 * The M25 topic → `ClaimTransitionEvent` map (GAP-037). The four keys are M25's ACTUAL emitted names:
 * M23's subscription map used to declare a fourth topic `m25.remittance.claim_adjusted`, which M25 has
 * never emitted — its reversal event is `claim_recouped` — so even a naively-wired binding would have
 * subscribed to a name no producer publishes while the real reversals went unconsumed.
 */
export const REMITTANCE_TRANSITION_BY_TOPIC = {
  "m25.remittance.claim_paid": "remittance_paid",
  "m25.remittance.claim_partial_paid": "remittance_partial_paid",
  "m25.remittance.claim_denied": "remittance_denied",
  "m25.remittance.claim_recouped": "remittance_recouped",
} as const;

/** The M25 topics this handler accepts. */
export type RemittanceTopic = keyof typeof REMITTANCE_TRANSITION_BY_TOPIC;

/** Is `topic` one of the four M25 posting topics? (Total over `string` — the dispatcher passes raw names.) */
export function isRemittanceTopic(topic: string): topic is RemittanceTopic {
  return topic in REMITTANCE_TRANSITION_BY_TOPIC;
}

/** Why a delivered remittance event changed nothing (a settled decision, not a delivery failure). */
export type RemittanceSkipReason =
  /** The claim id is not one of ours / no longer exists — M25 matched it to another tenant's row. */
  | "claim_not_found"
  /** The claim is already in the state this event would move it to (re-delivery, or a second 835 line). */
  | "already_applied"
  /** The transition is not legal from the claim's current state (an 835 for a claim that was never
   *  accepted, or one already replaced/voided). Needs a human, not a retry. */
  | "transition_not_legal";

/**
 * Convert an M25 posting event into the `ClaimTransitionEvent` + the history/event context M23 records.
 * PURE — the port applies it. Amounts arrive as X12 decimal strings and are converted to CENTS here,
 * because the §4.10 `m23.claim.paid` schema is `cents` and a silent unit mismatch here is a 100×
 * misstatement of what the MAC paid.
 */
export function planRemittanceTransition(
  topic: RemittanceTopic,
  event: RemittancePostedEvent,
): RemittanceTransitionPlan {
  return {
    claimId: event.claimId,
    transition: REMITTANCE_TRANSITION_BY_TOPIC[topic],
    remittanceAdviceId: event.remittanceAdviceId,
    paidAmountCents: decimalToCents(event.paidAmount),
    denialCodes: [...(event.carcCodes ?? [])],
    postedAt: event.postedAt,
  };
}

/** Parse an X12 decimal-string amount ("1234.56") to integer cents. `undefined` → 0. */
export function decimalToCents(amount: string | undefined): number {
  if (amount === undefined || amount.trim() === "") return 0;
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

/** The port-ready description of one remittance-driven claim transition. */
export interface RemittanceTransitionPlan {
  readonly claimId: string;
  readonly transition:
    | "remittance_paid"
    | "remittance_partial_paid"
    | "remittance_denied"
    | "remittance_recouped";
  readonly remittanceAdviceId: string;
  readonly paidAmountCents: number;
  readonly denialCodes: readonly string[];
  readonly postedAt?: string;
}

/** The single port the remittance handler fans out through (the Drizzle claim-state service at boot). */
export interface RemittanceTransitionPort {
  /**
   * Apply the planned transition in ONE org-scoped transaction (reducer → versioned state write →
   * `claim_state_history` append → §4.10 emit). Returns the skip reason when nothing was applied — a
   * settled decision the caller records rather than a throw that redelivers forever.
   */
  readonly applyRemittanceTransition: (input: {
    readonly organizationId: string;
    readonly triggeringEventId: string;
    readonly plan: RemittanceTransitionPlan;
  }) => Promise<{ readonly applied: boolean; readonly skipped?: RemittanceSkipReason }>;
}

/**
 * `m25.remittance.claim_*` → the claim's adjudication transition (task 55, LIVE since GAP-037).
 *
 * M25 has been merged and unconditionally emitting these four events at 835-posting time; M23 declared
 * them as deny-stubs and this handler threw `ForwardSeamNotLandedError` for every one, so the outbox rows
 * sat `pending` forever and no claim ever left ACK_ACCEPTED on payment.
 */
export async function handleRemittancePosted(
  eventName: string,
  event: RemittancePostedEvent,
  ports: RemittanceTransitionPort,
): Promise<UpstreamConsumeReport> {
  if (!isRemittanceTopic(eventName)) {
    throw new ForwardSeamNotLandedError(eventName, "M25 (Remittance)");
  }
  const plan = planRemittanceTransition(eventName, event);
  const result = await ports.applyRemittanceTransition({
    organizationId: event.organizationId,
    triggeringEventId: event.eventId,
    plan,
  });
  return {
    eventName,
    effects: result.applied ? ["claim_remittance_transition"] : [],
    actedOnIds: result.applied ? [event.claimId] : [],
  };
}

/** The minimal M26 cap-projection-change slice M23 will read once M26 lands (task 56). */
export interface CapProjectionChangedEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly patientId?: string;
}

/**
 * `m26.cap.projection_updated` → DENY-STUB (task 56). M26 has not landed; this handler fail-closes. When
 * M26 lands this re-validates claims in VALIDATING whose `aggregate cap projection not exceeded` rule depends
 * on the changed projection (it will route to {@link handleRevalidateTrigger}).
 */
export async function handleCapProjectionChanged(
  eventName: string,
  _event: CapProjectionChangedEvent,
  _ports: M23ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  throw new ForwardSeamNotLandedError(eventName, "M26 (Cap Management)");
}
