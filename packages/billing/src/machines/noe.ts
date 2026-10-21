// @chartwarden/billing — M23 `noe_record` (Notice of Election) fast-path lifecycle reducer (§2.2 lines
// 224–243, D3). The spec proposes XState; the ChartWarden repo convention is a PURE hand-rolled transition
// reducer (the `machines/claim.ts` exemplar + the M27 `cost-report/src/domain/lifecycle.ts` / M39 consent
// precedents) and ARCHITECTURE WINS over the module spec on this conflict. This file is shape-identical to
// `machines/claim.ts`: a transition-event union, a flat `NOE_TRANSITIONS` table, a pure guard predicate
// keyed on a small guard context, and a non-throwing `reduce(state, event, ctx?) => { state, error? }`.
//
// The NOE is the §2.2 5-day-window fast path: it does NOT wait on clinical data — the NOE submitter cron
// draws every READY row whose admission is past activation (the 5-day window watchdog cron + the §11.A
// NOE-timeliness CLAIM rule live OUTSIDE this machine, at the cron/service layer). Therefore `submit`
// carries NO domain guard here (unlike the claim submission gate). The ONE pure domain guard encoded is
// the pre-submission cancel: a DRAFT/READY NOE may be cancelled only when the upstream m6 election was
// reversed (a fact the Phase-3 service supplies), fail-closed when that fact is absent.
//
// NOTE on `cancel` vs the spec diagram: the §2.2 NOE diagram (lines 224–238) does not draw a CANCELLED
// edge, but the frozen `m23_noe_state` pgEnum carries `CANCELLED` (declared once, shared in lockstep with
// `m23_notr_state`), and the symmetric m6-outbox-reversal pattern is drawn EXPLICITLY for NOTR (§2.2
// lines 246–248). Modelling the pre-submission election-reversal cancel here is the fail-closed correct
// behaviour and keeps NOE/NOTR symmetric; it is reachable only with the guard fact set.
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@chartwarden/db`, no `getSeam`, no clock, no PHI/MBI
// (D13). The state union is the package-canonical lowercase `NoticeState` from `./contracts` (the seam
// DTOs speak it too); the machine operates over that alphabet rather than redeclaring it. The frozen DB
// `m23_noe_state` pgEnum is UPPERCASE — the Phase-3 repository maps case at the DB boundary, exactly as it
// does for `ClaimState` (see the kernel conventions report).
import type { NoticeState } from "../contracts";

/**
 * The server-authoritative `noe_record` lifecycle events (§2.2 transition table). The two acknowledgment
 * stages are split into deterministic per-outcome events (`ack_999_accepted` / `ack_999_rejected`;
 * `ack_277ca_accepted` / `ack_277ca_rejected`) so the reducer stays a pure function of (state, event) with
 * no hidden branch. `assemble` is the DRAFT→READY edge fired once the assembly service has derived
 * `effective_date` + `window_target_at` + content. `submit` is the READY→SUBMITTED edge fired by the NOE
 * submitter cron. `cancel` is the pre-submission election-reversal edge (guarded, see below).
 */
export type NoeTransitionEvent =
  | "assemble"
  | "cancel"
  | "submit"
  | "ack_999_accepted"
  | "ack_999_rejected"
  | "ack_277ca_accepted"
  | "ack_277ca_rejected";

/** One server-authoritative edge of the §2.2 `noe_record` state machine. */
export interface NoeTransition {
  readonly from: NoticeState;
  readonly event: NoeTransitionEvent;
  readonly to: NoticeState;
}

/**
 * The §2.2 `noe_record` transition table, server-authoritative and recorded into the NOE's append-only
 * state history. A flat list (rather than a `Record<event, ...>`) for parity with the claim machine and
 * because `cancel` is legal from more than one `from` state (DRAFT and READY — both pre-submission).
 * Self-loops are intentionally absent: every NOE event advances the record.
 */
export const NOE_TRANSITIONS: readonly NoeTransition[] = [
  // DRAFT → READY: assembly derived effective_date + window_target_at + content.
  { from: "draft", event: "assemble", to: "ready" },
  // DRAFT / READY → CANCELLED: the m6 election was reversed before the NOE was submitted (guarded).
  { from: "draft", event: "cancel", to: "cancelled" },
  { from: "ready", event: "cancel", to: "cancelled" },

  // READY → SUBMITTED: the NOE submitter cron picked up the READY row inside the activation window.
  { from: "ready", event: "submit", to: "submitted" },

  // SUBMITTED: 999 syntax accept → ACK_PENDING; 999 reject → ACK_REJECTED.
  { from: "submitted", event: "ack_999_accepted", to: "ack_pending" },
  { from: "submitted", event: "ack_999_rejected", to: "ack_rejected" },

  // ACK_PENDING: 277CA accept → ACK_ACCEPTED (terminal); 277CA reject → ACK_REJECTED.
  { from: "ack_pending", event: "ack_277ca_accepted", to: "ack_accepted" },
  { from: "ack_pending", event: "ack_277ca_rejected", to: "ack_rejected" },
] as const;

/**
 * Terminal states (§2.2): no outbound transition exists. `ack_accepted` is the success terminal;
 * `ack_rejected` is terminal for THIS row (a corrected NOE is its own row); `cancelled` is terminal.
 */
export const NOE_TERMINAL_STATES: readonly NoticeState[] = [
  "ack_accepted",
  "ack_rejected",
  "cancelled",
] as const;

/** True iff `state` has no outbound transition. */
export function isTerminal(state: NoticeState): boolean {
  return !NOE_TRANSITIONS.some((t) => t.from === state);
}

/**
 * Optional pure guard context. Only consulted for the events that carry one; everything else transitions
 * on (state, event) alone. The NOE has no validation-failure submission gate (the cron draws every READY
 * row, §2.2) — the only guarded edge is the pre-submission cancel.
 */
export interface NoeGuardContext {
  /**
   * For `cancel`: whether the upstream m6 election that triggered this NOE has been reversed (e.g. a
   * same-day election entry error corrected via the m6 outbox). The cancel is permitted only when this is
   * exactly `true`. Pass the already-resolved fact; this predicate makes no I/O.
   */
  readonly electionReversed?: boolean;
}

/** The events gated by a pure §2.2 domain guard. */
const GUARDED_EVENTS: ReadonlySet<NoeTransitionEvent> = new Set(["cancel"]);

/**
 * §2.2 pure guard: a NOE may be cancelled only when its triggering m6 election has been reversed. Pass the
 * already-resolved boolean; this predicate makes no I/O.
 */
export function isElectionReversed(electionReversed: boolean): boolean {
  return electionReversed === true;
}

/** Find the table edge for a (from, event) pair, or `undefined` if no such transition exists. */
function findTransition(from: NoticeState, event: NoeTransitionEvent): NoeTransition | undefined {
  return NOE_TRANSITIONS.find((t) => t.from === from && t.event === event);
}

/**
 * True iff `event` is a legal transition out of `from` AND every applicable pure §2.2 guard passes. If a
 * guarded event (`cancel`) is requested without `ctx.electionReversed`, the guard is treated as NOT
 * satisfied (fail-closed). Total and deterministic — never throws.
 */
export function canTransition(
  from: NoticeState,
  event: NoeTransitionEvent,
  ctx: NoeGuardContext = {},
): boolean {
  if (!findTransition(from, event)) return false;
  if (GUARDED_EVENTS.has(event)) {
    return ctx.electionReversed !== undefined && isElectionReversed(ctx.electionReversed);
  }
  return true;
}

/** The result of a `reduce` step: the next (or unchanged) state, plus an `error` code on a rejected step. */
export interface NoeReduceResult {
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
  event: NoeTransitionEvent,
  ctx: NoeGuardContext = {},
): NoeReduceResult {
  const transition = findTransition(state, event);
  if (!transition) {
    return { state, error: "INVALID_TRANSITION" };
  }
  if (GUARDED_EVENTS.has(event) && !canTransition(state, event, ctx)) {
    return { state, error: "GUARD_FAILED" };
  }
  return { state: transition.to };
}
