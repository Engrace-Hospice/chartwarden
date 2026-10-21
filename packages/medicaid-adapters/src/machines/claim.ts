// @chartwarden/medicaid-adapters — M24 `medicaid_claim` lifecycle reducer (§2.2, D13). The spec proposes an
// XState v5 machine; the ChartWarden repo convention (the M23 `billing/machines/claim.ts` exemplar) is a PURE
// hand-rolled transition reducer — ARCHITECTURE WINS over the module spec. The 18 states + their
// server-authoritative edges are a flat transition table; `canTransition` / `reduce` are total,
// deterministic, side-effect-free functions over (state, event). Guards needing I/O (M2 step-up freshness
// at dispatch, the M23 ack cross-entity gate, the clock) live in the Phase-3 service layer, noted per edge.
//
// PURE DOMAIN: no Fastify, Drizzle, BullMQ, getSeam, clock. No PHI / no Recipient ID (D12 / §3.6).
import type { MedicaidClaimState } from "../contracts";

/** The server-authoritative `medicaid_claim` lifecycle events (§2.2 transition table). */
export type MedicaidClaimEvent =
  | "begin_validation"
  | "validation_failed"
  | "validation_passed"
  | "overrides_applied"
  | "revalidate"
  | "await_medicare_primary"
  | "medicare_primary_acknowledged"
  | "medicare_primary_rejected"
  | "submit"
  | "submission_failed"
  | "accepted_sync"
  | "pending_async"
  | "rejected_sync"
  | "poll_accepted"
  | "poll_rejected"
  | "poll_timeout"
  | "poll_still_pending"
  | "ack_accepted"
  | "ack_rejected"
  | "ack_partial"
  | "ack_timeout_resolved_accepted"
  | "ack_timeout_resolved_rejected"
  | "remittance_paid"
  | "remittance_denied"
  | "appeal_succeeded"
  | "replacement_accepted"
  | "void_accepted"
  | "abandon";

export interface MedicaidClaimTransition {
  readonly from: MedicaidClaimState;
  readonly event: MedicaidClaimEvent;
  readonly to: MedicaidClaimState;
}

/** The §2.2 transition table, server-authoritative; each step is recorded into medicaid_claim_state_history. */
export const MEDICAID_CLAIM_TRANSITIONS: readonly MedicaidClaimTransition[] = [
  { from: "DRAFT", event: "begin_validation", to: "VALIDATING" },

  { from: "VALIDATING", event: "validation_failed", to: "FAILED_VALIDATION" },
  { from: "VALIDATING", event: "validation_passed", to: "READY" },
  { from: "VALIDATING", event: "overrides_applied", to: "READY" },

  { from: "FAILED_VALIDATION", event: "revalidate", to: "VALIDATING" },

  { from: "READY", event: "await_medicare_primary", to: "AWAITING_MEDICARE_PRIMARY" },
  { from: "READY", event: "submit", to: "SUBMITTED" },
  { from: "READY", event: "revalidate", to: "VALIDATING" },

  { from: "AWAITING_MEDICARE_PRIMARY", event: "medicare_primary_acknowledged", to: "READY" },
  {
    from: "AWAITING_MEDICARE_PRIMARY",
    event: "medicare_primary_rejected",
    to: "FAILED_MEDICARE_PRIMARY",
  },
  { from: "FAILED_MEDICARE_PRIMARY", event: "medicare_primary_acknowledged", to: "READY" },

  { from: "SUBMITTED", event: "accepted_sync", to: "ACK_PENDING" },
  { from: "SUBMITTED", event: "pending_async", to: "POLLING" },
  { from: "SUBMITTED", event: "rejected_sync", to: "ACK_REJECTED" },
  { from: "SUBMITTED", event: "submission_failed", to: "SUBMITTED" }, // transport retry (worker)

  { from: "POLLING", event: "poll_accepted", to: "ACK_ACCEPTED" },
  { from: "POLLING", event: "poll_rejected", to: "ACK_REJECTED" },
  { from: "POLLING", event: "poll_timeout", to: "ACK_TIMEOUT" },
  { from: "POLLING", event: "poll_still_pending", to: "POLLING" },

  { from: "ACK_PENDING", event: "ack_accepted", to: "ACK_ACCEPTED" },
  { from: "ACK_PENDING", event: "ack_rejected", to: "ACK_REJECTED" },
  { from: "ACK_PENDING", event: "ack_partial", to: "ACK_PARTIAL" },

  { from: "ACK_TIMEOUT", event: "ack_timeout_resolved_accepted", to: "ACK_ACCEPTED" },
  { from: "ACK_TIMEOUT", event: "ack_timeout_resolved_rejected", to: "ACK_REJECTED" },

  { from: "ACK_ACCEPTED", event: "remittance_paid", to: "PAID" },
  { from: "ACK_ACCEPTED", event: "remittance_denied", to: "DENIED" },
  { from: "ACK_ACCEPTED", event: "replacement_accepted", to: "REPLACED" },
  { from: "ACK_ACCEPTED", event: "void_accepted", to: "VOIDED" },

  { from: "ACK_REJECTED", event: "revalidate", to: "VALIDATING" },
  { from: "ACK_REJECTED", event: "abandon", to: "ABANDONED" },

  { from: "ACK_PARTIAL", event: "replacement_accepted", to: "REPLACED" },

  { from: "PAID", event: "replacement_accepted", to: "REPLACED" },
  { from: "PAID", event: "void_accepted", to: "VOIDED" },

  { from: "DENIED", event: "appeal_succeeded", to: "PAID" },
] as const;

/** Terminal states (§2.2): no outbound edge. (PAID/DENIED carry post-pay/appeal edges, so are not here.) */
export const MEDICAID_CLAIM_TERMINAL_STATES: readonly MedicaidClaimState[] = [
  "REPLACED",
  "VOIDED",
  "ABANDONED",
] as const;

export function isTerminal(state: MedicaidClaimState): boolean {
  return !MEDICAID_CLAIM_TRANSITIONS.some((t) => t.from === state);
}

/** Optional pure guard context (only the blocking-guarded events consult it). */
export interface MedicaidClaimGuardContext {
  /** `failed_count − overridden_count` over the regulatory floor from the latest completed validation run. */
  readonly unresolvedBlockingFailures?: number;
}

const BLOCKING_GUARDED_EVENTS: ReadonlySet<MedicaidClaimEvent> = new Set([
  "validation_passed",
  "overrides_applied",
  "submit",
]);

/** §2.3 pure guard: advance to/out of READY only with zero unresolved blocking failures. */
export function hasNoBlockingFailures(unresolvedBlockingFailures: number): boolean {
  return unresolvedBlockingFailures === 0;
}

function findTransition(
  from: MedicaidClaimState,
  event: MedicaidClaimEvent,
): MedicaidClaimTransition | undefined {
  return MEDICAID_CLAIM_TRANSITIONS.find((t) => t.from === from && t.event === event);
}

/** True iff legal AND every applicable pure guard passes. Fail-closed if a guarded event lacks ctx. */
export function canTransition(
  from: MedicaidClaimState,
  event: MedicaidClaimEvent,
  ctx: MedicaidClaimGuardContext = {},
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

export interface MedicaidClaimReduceResult {
  readonly state: MedicaidClaimState;
  readonly error?: string; // 'INVALID_TRANSITION' | 'GUARD_FAILED'
}

/** Apply a transition. NON-THROWING: illegal pair → unchanged + error; failed guard → unchanged + error. */
export function reduce(
  state: MedicaidClaimState,
  event: MedicaidClaimEvent,
  ctx: MedicaidClaimGuardContext = {},
): MedicaidClaimReduceResult {
  const transition = findTransition(state, event);
  if (!transition) return { state, error: "INVALID_TRANSITION" };
  if (BLOCKING_GUARDED_EVENTS.has(event) && !canTransition(state, event, ctx)) {
    return { state, error: "GUARD_FAILED" };
  }
  return { state: transition.to };
}
