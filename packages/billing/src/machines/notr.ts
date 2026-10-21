// @chartwarden/billing — M23 `notr_record` (Notice of Termination/Revocation) fast-path lifecycle reducer
// (§2.2 lines 243–260, D3). The spec proposes XState; the WardenX repo convention is a PURE hand-rolled
// transition reducer (the `machines/claim.ts` exemplar + the M27 `cost-report/src/domain/lifecycle.ts` /
// M39 consent precedents) and ARCHITECTURE WINS over the module spec on this conflict. This file is
// shape-identical to `machines/claim.ts` and `machines/noe.ts`: a transition-event union, a flat
// `NOTR_TRANSITIONS` table, a pure guard predicate keyed on a small guard context, and a non-throwing
// `reduce(state, event, ctx?) => { state, error? }`.
//
// The NOTR is created on an m6 terminating event (`m6.revocation.created`, `m6.transfer.created`
// [direction=out], `m6.discharge.created`) and shares the NOE 5-day-window fast-path shape: the §2.2 note
// states the window enforcement is "identical in shape to NOE". Like the NOE it does NOT wait on clinical
// data — the NOTR submitter cron draws every READY row in window (the window watchdog cron lives OUTSIDE
// this machine), so `submit` carries NO domain guard. The ONE pure domain guard is the §2.2 auto-cancel:
// a DRAFT/READY NOTR is cancelled when the terminating m6 event is reversed (a fact the Phase-3 service
// supplies), fail-closed when that fact is absent.
//
// NOTE on the 999-rejection edge: the §2.2 NOTR diagram abbreviates the SUBMITTED stage to a single
// "999 ack → ACK_PENDING" edge, but a 999 is an X12 syntax acknowledgment that can REJECT any submission;
// stranding a NOTR in SUBMITTED on a 999 reject would be the wrong (non-fail-closed) posture. The
// `ack_999_rejected` → ACK_REJECTED edge is therefore modelled here, matching the NOE machine and the
// §2.2 statement that NOTR window/ack handling is "identical in shape to NOE".
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@chartwarden/db`, no `getSeam`, no clock, no PHI/MBI
// (D13). The state union is the package-canonical lowercase `NoticeState` from `./contracts` (NOE and
// NOTR share the identical state shape — frozen `m23_notr_state = m23_noe_state.enumValues`). The DB enum
// is UPPERCASE; the Phase-3 repository maps case at the DB boundary, as for `ClaimState`.
import type { NoticeState } from "../contracts";

/**
 * The server-authoritative `notr_record` lifecycle events (§2.2 transition table). `assemble` is the
 * DRAFT→READY edge fired once the assembly service has derived `effective_date` + `window_target_at` +
 * content. `cancel` is the §2.2 auto-cancel edge fired when the terminating m6 event is reversed (guarded,
 * see below). `submit` is the READY→SUBMITTED edge fired by the NOTR submitter cron. The acknowledgment
 * stages are split into deterministic per-outcome events for the same reason as the NOE/claim machines.
 */
export type NotrTransitionEvent =
  | "assemble"
  | "cancel"
  | "submit"
  | "ack_999_accepted"
  | "ack_999_rejected"
  | "ack_277ca_accepted"
  | "ack_277ca_rejected";

/** One server-authoritative edge of the §2.2 `notr_record` state machine. */
export interface NotrTransition {
  readonly from: NoticeState;
  readonly event: NotrTransitionEvent;
  readonly to: NoticeState;
}

/**
 * The §2.2 `notr_record` transition table, server-authoritative and recorded into the NOTR's append-only
 * state history. A flat list for parity with the claim/NOE machines and because `cancel` is legal from
 * more than one `from` state (DRAFT and READY — both pre-submission; the §2.2 diagram draws the
 * auto-cancel under DRAFT, and the same reversal arriving while READY cancels identically).
 */
export const NOTR_TRANSITIONS: readonly NotrTransition[] = [
  // DRAFT → READY: assembly derived effective_date + window_target_at + content.
  { from: "draft", event: "assemble", to: "ready" },
  // DRAFT / READY → CANCELLED: the terminating m6 event (revocation/transfer-out/discharge) was reversed
  // via the m6 outbox before the NOTR was submitted (guarded).
  { from: "draft", event: "cancel", to: "cancelled" },
  { from: "ready", event: "cancel", to: "cancelled" },

  // READY → SUBMITTED: the NOTR submitter cron picked up the READY row inside the window.
  { from: "ready", event: "submit", to: "submitted" },

  // SUBMITTED: 999 syntax accept → ACK_PENDING; 999 reject → ACK_REJECTED (see file header note).
  { from: "submitted", event: "ack_999_accepted", to: "ack_pending" },
  { from: "submitted", event: "ack_999_rejected", to: "ack_rejected" },

  // ACK_PENDING: 277CA accept → ACK_ACCEPTED (terminal); 277CA reject → ACK_REJECTED.
  { from: "ack_pending", event: "ack_277ca_accepted", to: "ack_accepted" },
  { from: "ack_pending", event: "ack_277ca_rejected", to: "ack_rejected" },
] as const;

/**
 * Terminal states (§2.2): no outbound transition exists. `ack_accepted` is the success terminal;
 * `ack_rejected` is terminal for THIS row (a corrected NOTR is its own row); `cancelled` is terminal.
 */
export const NOTR_TERMINAL_STATES: readonly NoticeState[] = [
  "ack_accepted",
  "ack_rejected",
  "cancelled",
] as const;

/** True iff `state` has no outbound transition. */
export function isTerminal(state: NoticeState): boolean {
  return !NOTR_TRANSITIONS.some((t) => t.from === state);
}

/**
 * Optional pure guard context. Only consulted for the events that carry one; everything else transitions
 * on (state, event) alone. The NOTR has no validation-failure submission gate (the cron draws every READY
 * row, §2.2) — the only guarded edge is the auto-cancel.
 */
export interface NotrGuardContext {
  /**
   * For `cancel`: whether the terminating m6 event (revocation / transfer-out / discharge) that triggered
   * this NOTR has been reversed via the m6 outbox. The cancel is permitted only when this is exactly
   * `true`. Pass the already-resolved fact; this predicate makes no I/O.
   */
  readonly terminatingEventReversed?: boolean;
}

/** The events gated by a pure §2.2 domain guard. */
const GUARDED_EVENTS: ReadonlySet<NotrTransitionEvent> = new Set(["cancel"]);

/**
 * §2.2 pure guard: a NOTR is auto-cancelled only when its triggering terminating event has been reversed.
 * Pass the already-resolved boolean; this predicate makes no I/O.
 */
export function isTerminatingEventReversed(terminatingEventReversed: boolean): boolean {
  return terminatingEventReversed === true;
}

/** Find the table edge for a (from, event) pair, or `undefined` if no such transition exists. */
function findTransition(from: NoticeState, event: NotrTransitionEvent): NotrTransition | undefined {
  return NOTR_TRANSITIONS.find((t) => t.from === from && t.event === event);
}

/**
 * True iff `event` is a legal transition out of `from` AND every applicable pure §2.2 guard passes. If a
 * guarded event (`cancel`) is requested without `ctx.terminatingEventReversed`, the guard is treated as
 * NOT satisfied (fail-closed). Total and deterministic — never throws.
 */
export function canTransition(
  from: NoticeState,
  event: NotrTransitionEvent,
  ctx: NotrGuardContext = {},
): boolean {
  if (!findTransition(from, event)) return false;
  if (GUARDED_EVENTS.has(event)) {
    return (
      ctx.terminatingEventReversed !== undefined &&
      isTerminatingEventReversed(ctx.terminatingEventReversed)
    );
  }
  return true;
}

/** The result of a `reduce` step: the next (or unchanged) state, plus an `error` code on a rejected step. */
export interface NotrReduceResult {
  readonly state: NoticeState;
  /** `'INVALID_TRANSITION'` or `'GUARD_FAILED'` when the step was rejected; absent on success. */
  readonly error?: string;
}

/**
 * Apply a transition, returning the next state. NON-THROWING (the §2.2 reducer contract): on an illegal
 * (state, event) pair it returns the UNCHANGED state with `error: 'INVALID_TRANSITION'`; on a failed pure
 * guard it returns the unchanged state with `error: 'GUARD_FAILED'`. The Phase-3 service maps the error
 * code to the structured response envelope. Pure + deterministic.
 */
export function reduce(
  state: NoticeState,
  event: NotrTransitionEvent,
  ctx: NotrGuardContext = {},
): NotrReduceResult {
  const transition = findTransition(state, event);
  if (!transition) {
    return { state, error: "INVALID_TRANSITION" };
  }
  if (GUARDED_EVENTS.has(event) && !canTransition(state, event, ctx)) {
    return { state, error: "GUARD_FAILED" };
  }
  return { state: transition.to };
}
