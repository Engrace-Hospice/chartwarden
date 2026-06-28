// @wardenx/billing — M23 `claim` lifecycle reducer (§2.2, D2 / D4 / D14). The spec proposes an XState v5
// machine; the WardenX repo convention is a PURE hand-rolled transition reducer (the M27
// `cost-report/src/domain/lifecycle.ts` + M39 consent precedents), and ARCHITECTURE WINS over the module
// spec on this conflict. The twelve `claim` states and their server-authoritative transitions are encoded
// as a flat transition table; `canTransition` / `reduce` are total, deterministic, side-effect-free
// functions over (state, event). This is the EXEMPLAR the `noe` / `notr` machines mirror — same file
// shape: a transition-event union, a flat `*_TRANSITIONS` table, a pure guard predicate keyed on a small
// guard context, and a non-throwing `reduce(state, event, ctx?) => { state, error? }`.
//
// The pure §2.3 domain guard encoded here is the submission gate: the transitions INTO a state from which
// the claim can be submitted (`validating → ready`) and the SUBMIT transition itself require zero
// unresolved blocking validation failures (`failed_count − overridden_count = 0`). Guards that need I/O
// (M2 step-up freshness at dispatch, the `service_to <= today` clock check, the NOE-accepted cross-entity
// gate) live in the Phase-3 service layer, NOT here — they are noted at each transition.
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`, no clock. No PHI (D13).
// The `claim` state union is the package-canonical `ClaimState` from `./contracts` (the seam DTOs speak
// it too); the machine operates over that alphabet rather than redeclaring it (mirrors how M27's
// lifecycle reducer reuses `CostReportState`). Consumers import `ClaimState` from the package root.
import type { ClaimState } from "../contracts";

/**
 * The server-authoritative `claim` lifecycle events (§2.2 transition table). The two acknowledgment
 * outcomes are split into deterministic per-outcome events (`ack_999_accepted` / `ack_999_rejected`;
 * `ack_277ca_accepted` / `ack_277ca_rejected` / `ack_277ca_partial`) so the reducer stays a pure function
 * of (state, event) with no hidden branch. `submission_failed` is the §7.11 MAC-portal-outage path:
 * the claim regresses SUBMITTED → READY (re-queueable; the worker increments `attempt_index`).
 * `revalidate` is the §2.2 self-loop / READY→VALIDATING re-run when an upstream correction arrives.
 * `replacement_accepted` (TOB 817) and `void_accepted` (TOB 818) are the D14 replacement-chain
 * transitions on the ORIGINAL claim, fired when the 277CA accepts the replacement/void in its place.
 */
export type ClaimTransitionEvent =
  | "begin_validation"
  | "validation_failed"
  | "validation_passed"
  | "overrides_applied"
  | "revalidate"
  | "submit"
  | "submission_failed"
  | "ack_999_accepted"
  | "ack_999_rejected"
  | "ack_277ca_accepted"
  | "ack_277ca_rejected"
  | "ack_277ca_partial"
  | "remittance_paid"
  | "remittance_partial_paid"
  | "remittance_denied"
  | "appeal_succeeded"
  | "replacement_accepted"
  | "void_accepted";

/** One server-authoritative edge of the §2.2 `claim` state machine. */
export interface ClaimTransition {
  readonly from: ClaimState;
  readonly event: ClaimTransitionEvent;
  readonly to: ClaimState;
}

/**
 * The §2.2 `claim` transition table, server-authoritative and recorded into `claim_state_history`
 * (append-only). A flat list (rather than a `Record<event, ...>`) because several events are legal from
 * multiple `from` states (`replacement_accepted` / `void_accepted` from `ack_accepted`, `ack_partial`,
 * and `paid`). Order is documentary; lookups scan for the matching (from, event) pair.
 *
 * Self-loops are explicit edges so the reducer never silently no-ops: `validation_failed` keeps the claim
 * in `validating` (the worklist surfaces failures), and `revalidate` re-enters `validating` from either
 * `validating` or `ready` (a new `validation_run` is created at the service layer on each).
 */
export const CLAIM_TRANSITIONS: readonly ClaimTransition[] = [
  // DRAFT → VALIDATING: assembly produced lines + the initial validation_run begins.
  { from: "draft", event: "begin_validation", to: "validating" },

  // VALIDATING: stays on failure; advances to READY on clean pass OR when all failures are overridden.
  { from: "validating", event: "validation_failed", to: "validating" },
  { from: "validating", event: "validation_passed", to: "ready" },
  { from: "validating", event: "overrides_applied", to: "ready" },
  { from: "validating", event: "revalidate", to: "validating" },

  // READY: Submit (step-up at service layer) → SUBMITTED; an upstream correction re-validates.
  { from: "ready", event: "submit", to: "submitted" },
  { from: "ready", event: "revalidate", to: "validating" },

  // SUBMITTED: 999 syntax accept → ACK_PENDING; 999 reject → ACK_REJECTED; portal failure → READY.
  { from: "submitted", event: "ack_999_accepted", to: "ack_pending" },
  { from: "submitted", event: "ack_999_rejected", to: "ack_rejected" },
  { from: "submitted", event: "submission_failed", to: "ready" },

  // ACK_PENDING: 277CA outcomes.
  { from: "ack_pending", event: "ack_277ca_accepted", to: "ack_accepted" },
  { from: "ack_pending", event: "ack_277ca_rejected", to: "ack_rejected" },
  { from: "ack_pending", event: "ack_277ca_partial", to: "ack_partial" },

  // ACK_ACCEPTED: 835 remittance posts payment (full/partial)/denial; or a replacement/void supersedes
  // it (D14). The partial-pay edge is driven by `m25.remittance.claim_partial_paid` (M25 deny-stubbed
  // today — the m25-remit-posted consumer un-stubs at M25 lock; the edge is present so the machine is
  // complete and the consumer is a drop-in).
  { from: "ack_accepted", event: "remittance_paid", to: "paid" },
  { from: "ack_accepted", event: "remittance_partial_paid", to: "partial_paid" },
  { from: "ack_accepted", event: "remittance_denied", to: "denied" },
  { from: "ack_accepted", event: "replacement_accepted", to: "replaced" },
  { from: "ack_accepted", event: "void_accepted", to: "voided" },

  // ACK_PARTIAL: a TOB 817 replacement corrects the rejected lines.
  { from: "ack_partial", event: "replacement_accepted", to: "replaced" },

  // PAID: post-payment correction (817) or post-payment void (818).
  { from: "paid", event: "replacement_accepted", to: "replaced" },
  { from: "paid", event: "void_accepted", to: "voided" },

  // PARTIAL_PAID: same post-payment paths as PAID (a TOB 817 corrects, a TOB 818 voids); an M25 appeal
  // on the underpaid portion can re-post full payment.
  { from: "partial_paid", event: "replacement_accepted", to: "replaced" },
  { from: "partial_paid", event: "void_accepted", to: "voided" },
  { from: "partial_paid", event: "appeal_succeeded", to: "paid" },

  // DENIED: an M25 appeal succeeds + 835 re-posts with payment.
  { from: "denied", event: "appeal_succeeded", to: "paid" },
] as const;

/**
 * Terminal states (§2.2): no outbound transition exists. `ack_rejected` is terminal for THIS row (the
 * corrected claim is its own row); `replaced` / `voided` are preserved indefinitely (D14). `paid` and
 * `denied` are NOT in this set — they have the post-payment / appeal edges above; a claim is terminal at
 * `paid`/`denied` only when no further action is taken (a business state, not a machine dead-end).
 */
export const CLAIM_TERMINAL_STATES: readonly ClaimState[] = ["ack_rejected", "replaced", "voided"] as const;

/** True iff `state` has no outbound transition. */
export function isTerminal(state: ClaimState): boolean {
  return !CLAIM_TRANSITIONS.some((t) => t.from === state);
}

/**
 * Optional pure guard context. Only consulted for the events that carry one; everything else transitions
 * on (state, event) alone.
 */
export interface ClaimGuardContext {
  /**
   * For `validation_passed` / `overrides_applied` / `submit`: the count of blocking validation failures
   * that have NOT been overridden, i.e. `failed_count − overridden_count` over the regulatory floor from
   * the latest completed validation run. The guarded transition is permitted only when this is exactly 0.
   */
  readonly unresolvedBlockingFailures?: number;
}

/** The events gated by the §2.3 zero-unresolved-blocking-failures domain guard. */
const BLOCKING_GUARDED_EVENTS: ReadonlySet<ClaimTransitionEvent> = new Set([
  "validation_passed",
  "overrides_applied",
  "submit",
]);

/**
 * §2.3 pure guard: a claim may advance to / out of READY only when the latest validation run has zero
 * unresolved blocking failures (`failed_count − overridden_count = 0`). Pass the already-computed
 * difference; this predicate makes no I/O.
 */
export function hasNoBlockingFailures(unresolvedBlockingFailures: number): boolean {
  return unresolvedBlockingFailures === 0;
}

/** Find the table edge for a (from, event) pair, or `undefined` if no such transition exists. */
function findTransition(
  from: ClaimState,
  event: ClaimTransitionEvent,
): ClaimTransition | undefined {
  return CLAIM_TRANSITIONS.find((t) => t.from === from && t.event === event);
}

/**
 * True iff `event` is a legal transition out of `from` AND every applicable pure §2.3 guard passes. If a
 * blocking-guarded event is requested without `ctx.unresolvedBlockingFailures`, the guard is treated as
 * NOT satisfied (fail-closed). Total and deterministic — never throws.
 */
export function canTransition(
  from: ClaimState,
  event: ClaimTransitionEvent,
  ctx: ClaimGuardContext = {},
): boolean {
  if (!findTransition(from, event)) return false;
  if (BLOCKING_GUARDED_EVENTS.has(event)) {
    return (
      ctx.unresolvedBlockingFailures !== undefined &&
      hasNoBlockingFailures(ctx.unresolvedBlockingFailures)
    );
  }
  return true;
}

/** The result of a `reduce` step: the next (or unchanged) state, plus an `error` code on a rejected step. */
export interface ClaimReduceResult {
  readonly state: ClaimState;
  /** `'INVALID_TRANSITION'` or `'GUARD_FAILED'` when the step was rejected; absent on success. */
  readonly error?: string;
}

/**
 * Apply a transition, returning the next state. NON-THROWING (the §2.2 reducer contract): on an illegal
 * (state, event) pair it returns the UNCHANGED state with `error: 'INVALID_TRANSITION'`; on a failed
 * pure §2.3 guard it returns the unchanged state with `error: 'GUARD_FAILED'`. The Phase-3 service maps
 * the error code to the structured response envelope and records the (rejected) attempt where relevant.
 * Pure + deterministic.
 */
export function reduce(
  state: ClaimState,
  event: ClaimTransitionEvent,
  ctx: ClaimGuardContext = {},
): ClaimReduceResult {
  const transition = findTransition(state, event);
  if (!transition) {
    return { state, error: "INVALID_TRANSITION" };
  }
  if (BLOCKING_GUARDED_EVENTS.has(event) && !canTransition(state, event, ctx)) {
    return { state, error: "GUARD_FAILED" };
  }
  return { state: transition.to };
}
