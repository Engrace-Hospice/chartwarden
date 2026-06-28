// @wardenx/cost-report — M27 cost-report lifecycle reducer (§2.2). The spec proposes an XState v5
// machine (D4); the WardenX repo convention is a PURE hand-rolled transition reducer (see the M39
// consent status-machine precedent), and ARCHITECTURE WINS over the module spec on this conflict. The
// nine live states + terminal `closed` and their server-authoritative transitions are encoded as a flat
// transition table; `canTransition`/`applyTransition` are total, deterministic, side-effect-free
// functions over (state, event). The §2.3 domain guard that is PURE — `approve_for_submit` requires the
// latest validation to have zero unresolved blocking failures (`failed_count − overridden_count = 0`) —
// is encoded as a predicate taking the count as an argument; guards that need I/O (step-up auth,
// elevated-approval, Valkey single-flight) live in the Phase-2 service layer, not here.
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`. No PHI (D18).
import type { CostReportState } from "../contracts";

/**
 * The server-authoritative lifecycle events (§2.2 transition table). `validation_complete` is split
 * into two deterministic events by outcome — `validation_complete_pass` (no unresolved blocking
 * failures → `ready_for_review`) and `validation_complete_fail` (blocking failures → back to
 * `populating`) — so the reducer stays a pure function of (state, event) with no hidden branch. `reopen`
 * moves an immutable submitted/accepted/rejected report into the transient `reopened` state; the
 * subsequent `reset_to_draft` resets it to `draft` for editing (the §2.2 "reopened → draft" hop, kept
 * explicit so every state in the union is reachable through a named transition). `offboard` is the
 * `provider_entity_offboarded` (M40) transition to terminal `closed`.
 */
export type CostReportTransitionEvent =
  | "refresh_inputs"
  | "validate"
  | "validation_complete_pass"
  | "validation_complete_fail"
  | "approve_for_submit"
  | "return_to_draft"
  | "submit"
  | "record_acknowledgment"
  | "record_rejection"
  | "reopen"
  | "reset_to_draft"
  | "offboard";

/** One server-authoritative edge of the §2.2 state machine. */
export interface CostReportTransition {
  readonly from: CostReportState;
  readonly event: CostReportTransitionEvent;
  readonly to: CostReportState;
}

/**
 * The §2.2 transition table, server-authoritative and audit-logged at the service layer. A flat list
 * (rather than a `Record<event, ...>`) because several events are legal from multiple `from` states
 * (`reopen` from both `accepted` and `rejected`; `offboard` from `draft`/`populating`/
 * `ready_for_review`). Order is documentary; lookups scan for the matching (from, event) pair.
 */
export const COST_REPORT_TRANSITIONS: readonly CostReportTransition[] = [
  { from: "draft", event: "refresh_inputs", to: "populating" },
  { from: "populating", event: "validate", to: "validating" },
  { from: "validating", event: "validation_complete_pass", to: "ready_for_review" },
  { from: "validating", event: "validation_complete_fail", to: "populating" },
  { from: "ready_for_review", event: "approve_for_submit", to: "approved_for_submit" },
  { from: "ready_for_review", event: "return_to_draft", to: "populating" },
  { from: "approved_for_submit", event: "submit", to: "submitted" },
  { from: "submitted", event: "record_acknowledgment", to: "accepted" },
  { from: "submitted", event: "record_rejection", to: "rejected" },
  { from: "accepted", event: "reopen", to: "reopened" },
  { from: "rejected", event: "reopen", to: "reopened" },
  { from: "reopened", event: "reset_to_draft", to: "draft" },
  { from: "draft", event: "offboard", to: "closed" },
  { from: "populating", event: "offboard", to: "closed" },
  { from: "ready_for_review", event: "offboard", to: "closed" },
] as const;

/**
 * Optional guard context for the pure §2.3 domain guards. Only consulted for events that carry one;
 * everything else transitions on (state, event) alone.
 */
export interface CostReportGuardContext {
  /**
   * For `approve_for_submit`: the count of blocking validation failures that have NOT been explicitly
   * overridden, i.e. `failed_count − overridden_count` from the latest completed validation run. The
   * transition is permitted only when this is exactly 0 (§2.3).
   */
  readonly unresolvedBlockingFailures?: number;
}

/**
 * §2.3 pure guard: `approve_for_submit` requires the latest validation run to be complete with zero
 * unresolved blocking failures (`failed_count − overridden_count = 0`). Pass the already-computed
 * difference; this predicate makes no I/O.
 */
export function canApproveForSubmit(unresolvedBlockingFailures: number): boolean {
  return unresolvedBlockingFailures === 0;
}

/** Find the table edge for a (from, event) pair, or `undefined` if no such transition exists. */
function findTransition(
  from: CostReportState,
  event: CostReportTransitionEvent,
): CostReportTransition | undefined {
  return COST_REPORT_TRANSITIONS.find((t) => t.from === from && t.event === event);
}

/**
 * True iff `event` is a legal transition out of `from` AND every applicable pure §2.3 guard passes.
 * Currently the only guarded event is `approve_for_submit` (needs `ctx.unresolvedBlockingFailures`); if
 * the guarded event is requested without its context value, the guard is treated as NOT satisfied
 * (fail-closed). Total and deterministic — never throws.
 */
export function canTransition(
  from: CostReportState,
  event: CostReportTransitionEvent,
  ctx: CostReportGuardContext = {},
): boolean {
  if (!findTransition(from, event)) return false;
  if (event === "approve_for_submit") {
    return (
      ctx.unresolvedBlockingFailures !== undefined &&
      canApproveForSubmit(ctx.unresolvedBlockingFailures)
    );
  }
  return true;
}

/**
 * Apply a transition, returning the resulting `CostReportState`. Throws on an illegal (state, event)
 * pair or a failed pure guard — the caller (Phase-2 service) catches and maps to the structured
 * `INVALID_TRANSITION` / guard-specific error envelope. Pure and deterministic.
 */
export function applyTransition(
  from: CostReportState,
  event: CostReportTransitionEvent,
  ctx: CostReportGuardContext = {},
): CostReportState {
  const transition = findTransition(from, event);
  if (!transition) {
    throw new Error(`INVALID_TRANSITION: cannot '${event}' a cost report in state '${from}'`);
  }
  if (event === "approve_for_submit" && !canTransition(from, event, ctx)) {
    throw new Error(
      "GUARD_FAILED: approve_for_submit requires zero unresolved blocking validation failures " +
        "(failed_count − overridden_count = 0)",
    );
  }
  return transition.to;
}
