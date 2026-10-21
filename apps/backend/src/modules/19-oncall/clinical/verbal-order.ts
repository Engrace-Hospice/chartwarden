import { isStepUpRecent } from "@chartwarden/auth";
// apps/backend/src/modules/19-oncall/clinical/verbal-order.ts — M19-T05 (D9, §7.7, §2.4, §6).
//
// THE M11 BINDING. §7.7's scene: 2 a.m., the patient vomited her morning morphine, the RN takes a verbal
// order from the attending over the phone. D9 fixes the boundary — "M19 NEVER writes to M11 schema
// directly" — and fixes the gate: M2 SESSION_POLICY step-up (biometric or PIN) at the MOMENT of order
// entry, because a verbal order is a controlled clinical action and after-hours is precisely when
// impersonation risk is highest.
//
// WHAT M11 ACTUALLY PUBLISHED, and why the shape here follows it rather than D9's sketch:
//
//   • D9 writes `OrderSignatureProvider.recordVerbalOrder(...)` "with the triage context attached
//     (`triage_context: {triageCallId}`)". `RecordVerbalOrderInput` (@chartwarden/types) has no such field, and
//     M11's `order_record` has no triage column. The link therefore lives ONLY on M19's side, on
//     `triage_call.linked_verbal_order_ids` — which is exactly what §7.7 says and what M19's own published
//     `TriageCallProvider.triageContextForVerbalOrder(orgId, orderRecordId)` seam (§4.3) exists to serve:
//     M11's expiring-verbal-order worker asks M19 which call an order came from. That reverse lookup only
//     works if M19 stores the link, which settles the direction below.
//
//   • D9 also says the link is recorded "via M19's consumer of `m11.order.verbal_received` events filtered
//     to the triage context". That is UNIMPLEMENTABLE as written: M11 emits `{ orderId, deadlineAt }` — no
//     triage context, no patient, no org — so there is nothing to filter on, and every triage call in the
//     agency would have to guess whether an arriving order was its own. (It is also not in
//     `M19_SUBSCRIBED_EVENT_NAMES`; `m11.order.verbal_expired_unsigned` is, which is the notification path,
//     not the record path.) The link is therefore written SYNCHRONOUSLY from the id the seam returns —
//     §2.4's own wording ("Call to M11's `recordVerbalOrder`; `triage_call.linked_verbal_order_ids[]`
//     appended") and the only version that survives a redelivery or an M36 outage.
//
//   • `recordVerbalOrder` is a signature PRIMITIVE over an EXISTING `(targetKind, targetId)`, not an order
//     factory. §7.7's M11 modal is what creates the order row; M19 records the attestation against it. M19
//     mints no order — which is also why the disposition payload's `orderRecordId` is non-nullable: the id
//     exists before the disposition is written.
//
// THIS FILE FAILS LOUD, unlike `./encounter-link`. An M8 outage defers (the RN is free for the next call);
// a verbal order that did not reach M11 must NOT report success, because the panel would show an order the
// pharmacy will never see and the attending will never countersign. There is no degraded mode for a
// controlled clinical action.
import type {
  IsoInstant,
  MembershipId,
  OrderRecordId,
  OrderSignatureTargetKind,
  RecordVerbalOrderInput,
  SessionStepUpFields,
  StepUpPolicy,
  VerbalOrderId,
} from "@chartwarden/types";
import { STEP_UP_POLICY } from "@chartwarden/types";
import { permittedDispositions } from "../lifecycle/disposition";
import type { TriageSideEffect } from "../lifecycle/effects";
import { require_ } from "../lifecycle/errors";
import type { TriageActorDiscipline } from "../lifecycle/protocol";
import { getOrderSignatureProvider } from "../seams/consumed";

/** M11 §2.8 `RecordVerbalOrderInput` — "100-2000 chars; denylisted in audit". Restated as constants so the
 *  refusal happens in M19 (with a triage error code the panel can render) rather than as an opaque
 *  upstream failure after the seam call has already been attempted. */
export const VERBAL_ATTESTATION_MIN_CHARS = 100;
export const VERBAL_ATTESTATION_MAX_CHARS = 2000;

/**
 * D9 / §7.7 — the M2 step-up gate, applied at the seam call rather than only at the route.
 *
 * Deliberately duplicated from the T07 route guard (`requireStepUp`). The route guard protects the route;
 * this protects the ACTION, and the action is reachable from more than one place (the panel, and any later
 * worker or service path). §8.3.6's elevation-of-privilege row is explicit that the verbal-order path is a
 * step-up boundary — a boundary enforced in exactly one layer stops being a boundary the first time a
 * second caller appears.
 *
 * Fails CLOSED on every missing input: `isStepUpRecent` (M3's pure decision) denies a null state, a
 * non-qualifying factor (SMS is not step-up — no proof of possession, SIM-swappable), a future-dated stamp
 * and an expired window alike. The platform floor is the baseline; a tenant override may only TIGHTEN it,
 * so applying the floor when no override is supplied is the safe default.
 */
export function assertVerbalOrderStepUp(
  state: SessionStepUpFields | null,
  nowMs: number,
  policy: StepUpPolicy = STEP_UP_POLICY,
): void {
  require_(
    isStepUpRecent(state, policy, nowMs),
    "VERBAL_ORDER_STEP_UP_REQUIRED",
    `taking a verbal order requires a step-up authentication no older than ${policy.defaultMaxAgeSec}s using ${policy.qualifyingFactors.join(" or ")}`,
  );
}

/**
 * §6 / D6 — only an actor whose scope band may select `verbal_order_recorded` may take the order.
 *
 * Derived from `permittedDispositions` rather than restated, so the two can never drift: §7.3's whole point
 * is that the LPN's selector and the server refuse the same set, and a verbal-order entry point with its
 * own copy of the matrix would be the way around it. The vendor operator is excluded by the same matrix
 * (D13 / §6 grant Ext Triage Op no verbal-order row), which matters more than it looks — a vendor operator
 * has no WardenX membership to be `recordingMembershipId`.
 */
export function assertVerbalOrderScope(discipline: TriageActorDiscipline): void {
  require_(
    permittedDispositions(discipline).includes("verbal_order_recorded"),
    "VERBAL_ORDER_ACTOR_OUT_OF_SCOPE",
    `a ${discipline} actor may not take a verbal order; escalate to an RN or above (§6 / §7.3)`,
  );
}

/** What the triage panel supplies to take one verbal order during a call (§7.7's modal context). */
export interface TriageVerbalOrderRequest {
  readonly organizationId: string;
  /** The EXISTING M11 order / M12 medication order the attestation attaches to (see the header). */
  readonly targetKind: OrderSignatureTargetKind;
  readonly targetId: OrderRecordId;
  /** The RN who took the order — M11 records them as the attesting party, not the signer. */
  readonly recordingMembershipId: MembershipId;
  /** The M40 `ExternalPhysician` id whose 48-hour countersignature M11 will chase. */
  readonly orderingPhysicianMdmId: string;
  /** The RN's own account of what the physician said. Denylisted in M11's audit value capture. */
  readonly verbalAttestation: string;
  /** When the physician gave the order — the instant M11's 48-hour deadline is measured from. */
  readonly receivedAt: IsoInstant;
}

/**
 * D9 — build M11's `RecordVerbalOrderInput`, refusing everything M11's contract requires BEFORE the seam
 * call. PURE.
 *
 * The three refusals are not ceremony. An empty target means M19 would be asking M11 to attest against
 * nothing; a missing physician id means there is nobody for the 48-hour countersignature chase to reach,
 * so the order silently expires unsigned; and an attestation below M11's floor is what makes "verbal order
 * per Dr. X" — indistinguishable from no record at all when a surveyor asks what was actually said.
 */
export function buildVerbalOrderInput(request: TriageVerbalOrderRequest): RecordVerbalOrderInput {
  require_(
    request.targetId.trim().length > 0,
    "VERBAL_ORDER_TARGET_REQUIRED",
    "a verbal order attaches to an existing M11 order or M12 medication order; M19 mints neither",
  );
  require_(
    request.orderingPhysicianMdmId.trim().length > 0,
    "VERBAL_ORDER_PHYSICIAN_REQUIRED",
    "name the ordering physician (M40 ExternalPhysician); the 48-hour countersignature is theirs",
  );
  const attestation = request.verbalAttestation.trim();
  require_(
    attestation.length >= VERBAL_ATTESTATION_MIN_CHARS &&
      attestation.length <= VERBAL_ATTESTATION_MAX_CHARS,
    "VERBAL_ORDER_ATTESTATION_INVALID",
    `the attestation is ${attestation.length} chars; M11 requires ${VERBAL_ATTESTATION_MIN_CHARS}-${VERBAL_ATTESTATION_MAX_CHARS}`,
  );

  return {
    organizationId: request.organizationId,
    targetKind: request.targetKind,
    targetId: request.targetId,
    recordingMembershipId: request.recordingMembershipId,
    orderingPhysicianMdmId: request.orderingPhysicianMdmId,
    verbalAttestation: attestation,
    receivedAt: request.receivedAt,
  };
}

/** What M19 keeps from one verbal order taken during a call. */
export interface TriageVerbalOrderReceipt {
  /** The id that goes on `triage_call.linked_verbal_order_ids` and into the `verbal_order_recorded`
   *  disposition payload — the ORDER, not M11's `verbal_order` row. §4.3's
   *  `triageContextForVerbalOrder(orgId, verbalOrderId: OrderRecordId)` types the reverse lookup on the
   *  order id, so storing M11's attestation-row id instead would leave that seam permanently returning
   *  null and M11's expiring-order reminder going to the day shift instead of the RN who took it. */
  readonly orderRecordId: OrderRecordId;
  /** M11's own `verbal_order` row id — kept for the audit trail, not for the link. */
  readonly verbalOrderId: VerbalOrderId;
  /** M11's computed 48-hour countersignature deadline; the panel shows it to the RN. */
  readonly deadlineAt: IsoInstant;
}

/**
 * D9 / §7.7 — take a verbal order during a triage call.
 *
 * Order of operations is scope → step-up → payload → seam, and it is the order that leaks least: an actor
 * outside scope must not learn whether their step-up was fresh, and neither must learn whether the target
 * order exists. The seam call is last and its failure PROPAGATES (see the file header).
 *
 * Runs OUTSIDE M19's own transaction (M21-T05: a cross-module seam probe inside your own transaction
 * self-deadlocks the pool). The sequence at the route (T07) is: record the order through M11, then write
 * the `verbal_order_recorded` disposition carrying the id — so an M11 failure leaves the call in
 * `disposition_pending` with no false claim of an order, which is the recoverable state.
 */
export async function recordTriageVerbalOrder(input: {
  readonly request: TriageVerbalOrderRequest;
  readonly actorDiscipline: TriageActorDiscipline;
  readonly stepUp: SessionStepUpFields | null;
  readonly nowMs: number;
  readonly stepUpPolicy?: StepUpPolicy;
}): Promise<TriageVerbalOrderReceipt> {
  assertVerbalOrderScope(input.actorDiscipline);
  assertVerbalOrderStepUp(input.stepUp, input.nowMs, input.stepUpPolicy ?? STEP_UP_POLICY);
  const seamInput = buildVerbalOrderInput(input.request);

  const recorded = await getOrderSignatureProvider().recordVerbalOrder(seamInput);
  return {
    orderRecordId: seamInput.targetId,
    verbalOrderId: recorded.verbalOrderId,
    deadlineAt: recorded.deadlineAt,
  };
}

/** §2.4 — the declarative effect that appends the back-reference, built from a receipt. */
export function verbalOrderLinkEffect(
  receipt: TriageVerbalOrderReceipt,
): Extract<TriageSideEffect, { kind: "link_verbal_order" }> {
  return { kind: "link_verbal_order", orderRecordId: receipt.orderRecordId };
}

/**
 * GAP-134 (D9) — a `verbal_order_recorded` disposition may only name an order that EXISTS in M11 and belongs to the
 * call's own patient (the `OrderProvider.getOrder` read-back). A fabricated id, or an order of another patient, is a
 * 422 and is never stored on the call. Pure: the caller does the seam read, outside its own transaction.
 */
export function assertVerbalOrderBelongsToCall(
  order: { readonly patientId: string } | null,
  callPatientId: string | null,
): void {
  require_(
    order !== null && callPatientId !== null && order.patientId === callPatientId,
    "DISPOSITION_PAYLOAD_INVALID",
    "orderRecordId does not name an M11 order for this call's patient",
  );
}

/**
 * §3.3 — append an order id to `triage_call.linked_verbal_order_ids` (a jsonb ARRAY: a single call can take
 * more than one verbal order, §7.7's "ondansetron + IV morphine" being the obvious case).
 *
 * De-duplicating rather than blind-appending: the effect runner is retried by the same at-least-once
 * machinery as everything else in §4.8, and a duplicated id would make the survey record claim two verbal
 * orders where one was taken. Order is preserved — the sequence is the clinical narrative.
 */
export function appendLinkedVerbalOrderId(
  existing: readonly OrderRecordId[],
  orderRecordId: OrderRecordId,
): readonly OrderRecordId[] {
  return existing.includes(orderRecordId) ? existing : [...existing, orderRecordId];
}
