// @chartwarden/subscription-billing — §2.2 / D16 refund four-stage workflow (pure kernel, M35-T01).
//
// The D16 lifecycle: `requested → approved → executed_success | executed_failed`, with `denied` as the
// early terminal reject. Approval requires a fresh (≤5min) step-up token AND a different actor than the
// requester (4-eyes; the M3 `refund_requires_step_up_approval` ABAC predicate). Execution is performed by
// the outbox dispatcher. This adjacency is the pure guard the T05 service + the routes check against.

import type { RefundStatus } from "@chartwarden/types";

/** The allowed §2.2 refund transitions. `denied`, `executed_success`, `executed_failed` are terminal. */
export const REFUND_TRANSITIONS = {
  requested: ["approved", "denied"],
  approved: ["executed_success", "executed_failed"],
  denied: [],
  executed_success: [],
  executed_failed: [],
} as const satisfies Record<RefundStatus, readonly RefundStatus[]>;

/** The terminal refund states (§2.2). */
export const REFUND_TERMINAL_STATUSES: readonly RefundStatus[] = [
  "denied",
  "executed_success",
  "executed_failed",
];

/** True iff `from → to` is a legal §2.2 refund transition. */
export function canTransitionRefund(from: RefundStatus, to: RefundStatus): boolean {
  return (REFUND_TRANSITIONS[from] as readonly RefundStatus[]).includes(to);
}

/** True iff the refund admits no further transition. */
export function isTerminalRefundStatus(status: RefundStatus): boolean {
  return REFUND_TERMINAL_STATUSES.includes(status);
}
