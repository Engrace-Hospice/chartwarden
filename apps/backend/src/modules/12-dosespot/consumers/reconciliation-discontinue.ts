// apps/backend/src/modules/12-dosespot/consumers/reconciliation-discontinue.ts — the M13 eMAR §2.8 D17
// reconciliation "discontinue" handshake consumer (F-155/F-161, #248). PHASE-1 PURE DECISION CORE.
//
// M13's medication-reconciliation worksheet decides, per line, what M12 should do about the medication —
// `planReconciliationDecision` (`@chartwarden/emar`) maps a `discontinue` decision on an `m12_active` line to
// the `m13.reconciliation.discontinue_requested` outbox event, and the real M13 write path
// (`emar-route-service-db.ts`'s `recordDecision`) emits it carrying the exact fields this decider reads —
// `medicationOrderId: args.sourceId, reason: "reconciled_discontinue"`. `events-by-m13.ts` already declares
// `m12` as a consumer of this event; nothing had ever bound it (`scripts/outbox-deferred-consumers.ts`,
// the `m12`/`handlers-unbound` group).
//
// WHY `cascadeDiscontinue`, NOT the human `discontinue` event (the M12 discharge-cascade binding's own
// reasoning, `bindings.ts`, applied a second time):
//   • `discontinue` writes `actorMembershipId: userId` on a route call — the CALLER. This IS a system
//     cascade (an M13 clinical decision already recorded on `medication_reconciliation_decision`, applied
//     here by the consumer, not by a human clicking "discontinue"), so attributing it to whichever
//     membership happens to process the outbox tick would put a name on an act they did not perform.
//   • `discontinue`'s own TS signature requires a `reason: MedicationOrderDiscontinuationReason` — a
//     closed union (`packages/types/src/dosespot.ts`) that does NOT carry `"reconciled_discontinue"` (the
//     literal M13's own catalog schema requires, `Type.Literal("reconciled_discontinue")`). Widening that
//     union (plus its DB-enum mirror, `medication_order_discontinuation_reason` — created in migration
//     0038 but backing NO column anywhere in the schema today) is a genuinely separate, shared-file change
//     this pass deliberately does not make (isolated-file discipline; see the coordinator handoff).
//     `cascadeDiscontinue` needs no `reason` parameter at all (`isSystemActor: boolean` only) — exactly the
//     shape a system-cascade guard should have — and is legal from a WIDER state set
//     (`pending_signature, epcs_identity_pending, verbal_pending, queued_for_transmission, active`) than
//     `discontinue` (`nack_received, active` only), which matters here: a reconciliation decision can
//     target a medication order that has not yet reached `active` (e.g. still `pending_signature` at the
//     moment IDG or a covering clinician reconciles the list).
//   • Same as the discharge cascade: `discontinueOrder`'s route path drops the `write_discontinuation`
//     effect too (M12 owns no `medication_order_discontinuation` ledger table — the ledger is M11's
//     `order_discontinuation`, reached only through the §2.8 D14 seam for M11-owned orders). That gap is
//     real, pre-existing on every M12 discontinuation path, and is left alone here on purpose — writing a
//     ledger row for THIS path only would fabricate provenance the human path does not carry either.
//
// The reason string on the WIRE (the `m12.medication_order.discontinued` payload this consumer emits) is
// `"reconciled_discontinue"` regardless — `events-by-m12.ts`'s own catalog types that field as a plain
// non-empty string (`const id = Type.String({minLength: 1})`, a generic helper despite the name), not the
// closed TS union, so the wire is honest about WHY even though the machine's own typed guard call is not
// (and does not need to be, since its return value is discarded exactly as `discontinueOrder`'s already is).
import type { MedicationOrderStatus } from "@chartwarden/types";

/** The `m13.reconciliation.discontinue_requested` payload subset M12 reads (M13 owns the wire shape). */
export interface ReconciliationDiscontinuePayload {
  readonly worksheetId: string;
  readonly decisionId: string;
  readonly medicationOrderId: string;
  /** M13's catalog pins this to the literal `"reconciled_discontinue"`; read as a plain string so a future
   *  M13 reason literal needs no change here. */
  readonly reason: string;
}

/** The M12 row's current status the worker reads before deciding — `null` when no row exists for this org
 *  (wrong tenant, or the id names no row at all; the two are indistinguishable from here and both no-op). */
export interface ReconciliationDiscontinueFacts {
  readonly status: MedicationOrderStatus;
}

export type ReconciliationDiscontinueAction =
  | { readonly kind: "not_found" }
  | { readonly kind: "skip"; readonly reason: "already_discontinued" }
  | { readonly kind: "discontinue"; readonly orderId: string; readonly reason: string };

/**
 * Decide the M12 reaction to an `m13.reconciliation.discontinue_requested` delivery (pure). `facts: null`
 * (no row under this org) and an already-`discontinued` row are both idempotent no-ops — the first because
 * there is nothing to act on, the second because a redelivery (or a human beating the consumer to it via
 * `discontinueOrder`) must not re-emit. Any other status hands `orderId`/`reason` to the caller, which
 * applies `cascadeDiscontinue` as the legality guard — a status `cascadeDiscontinue` refuses (`draft`,
 * `signed`, `transmitted`, `ack_received`, `nack_received`, `completed`, `transmission_failed`) throws the
 * machine's own typed error and dead-letters rather than being guessed at (the M16 §D6 consent-revocation
 * cascade precedent, F-151: refuse rather than silently reinterpret a state the decision never anticipated).
 */
export function decideReconciliationDiscontinue(
  payload: ReconciliationDiscontinuePayload,
  facts: ReconciliationDiscontinueFacts | null,
): ReconciliationDiscontinueAction {
  if (facts === null) return { kind: "not_found" };
  if (facts.status === "discontinued") return { kind: "skip", reason: "already_discontinued" };
  return { kind: "discontinue", orderId: payload.medicationOrderId, reason: payload.reason };
}
