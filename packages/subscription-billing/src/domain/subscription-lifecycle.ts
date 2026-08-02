// @wardenx/subscription-billing — §2.2 subscription state machine (pure kernel, M35-T01).
//
// The D7 status graph as pure data: `trialing → active → past_due → at_risk → suspended → canceled`
// with the lateral `paused` state reachable on `m2.organization.suspended`. This adjacency is the single
// source of truth the T05 XState machine + the route guards + the reconciler all check against; encoding
// it here (type-only deps) keeps the transition rules testable without a DB, a Stripe client, or Fastify.
//
// §2.3 rule: `canceled` is terminal — a "reactivation" creates a NEW subscription row, never a transition
// back out of `canceled`.

import type { SubscriptionStatus } from "@wardenx/types";

/** The allowed forward/lateral transitions per §2.2. A transition NOT listed here is rejected by the
 *  T05 XState guard (which additionally re-checks preconditions under the `SELECT ... FOR UPDATE` lock). */
export const SUBSCRIPTION_TRANSITIONS = {
  trialing: ["active", "past_due", "canceled", "paused"],
  active: ["past_due", "canceled", "paused"],
  past_due: ["active", "at_risk", "canceled", "paused"],
  at_risk: ["active", "suspended", "canceled", "paused"],
  suspended: ["active", "canceled", "paused"],
  paused: ["active", "trialing", "canceled"],
  canceled: [],
} as const satisfies Record<SubscriptionStatus, readonly SubscriptionStatus[]>;

/** §2.3 the only terminal status — no transition may leave it. */
export const SUBSCRIPTION_TERMINAL_STATUSES: readonly SubscriptionStatus[] = ["canceled"];

/** True iff `from → to` is a legal §2.2 transition. Self-transitions are not transitions (false). */
export function canTransitionSubscription(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return (SUBSCRIPTION_TRANSITIONS[from] as readonly SubscriptionStatus[]).includes(to);
}

/** True iff the status admits no further transition (only `canceled` today). */
export function isTerminalSubscriptionStatus(status: SubscriptionStatus): boolean {
  return SUBSCRIPTION_TERMINAL_STATUSES.includes(status);
}

/** The statuses in which billing does NOT block tenant access (`BillingStatus.isBlockedByBilling=false`).
 *  `suspended` blocks; `past_due`/`at_risk` warn but do not yet block (D7). */
export const SUBSCRIPTION_BILLABLE_NON_BLOCKING_STATUSES: readonly SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "at_risk",
  "paused",
];

/** True iff the subscription status hard-blocks tenant access (`suspended` only, per D7). */
export function isBillingBlocked(status: SubscriptionStatus): boolean {
  return status === "suspended";
}
