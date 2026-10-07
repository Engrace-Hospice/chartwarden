// apps/backend/src/modules/24-billing-medicaid/consumers — the M24 §4.4 upstream-consumer register surface
// (the M25/M26 consumers/index.ts mirror). Routes each subscribed topic to its pure handler (./handlers.ts)
// (`dispatchM24UpstreamEvent`). GAP-205: the former `registerM24Consumers` registrar was dead scaffolding (no caller, no dispatcher took a registrar) and is deleted; the LIVE bindings are the `OutboxConsumerBinding`s under `../outbox-consumers/` (wired from apps/backend/src/index.ts, proven by `arch:outbox-bindings`).
// The Drizzle M24ConsumerStore binding is deferred: advancing a claim to PAID
// / DENIED / resolving a held Medicare-primary claim runs the §2.2 reducer over the live claim row, which the
// claim-lifecycle write path owns; the live store binds with that path.
import {
  type M24ConsumerStore,
  handleClaimDenied,
  handleClaimPaid,
  handleMedicarePrimaryAck,
  handleUpstreamChange,
} from "./handlers";
import { M24_SUBSCRIPTION_MAP, M24_UPSTREAM_SUBSCRIPTIONS } from "./subscription-map";

export { M24_SUBSCRIPTION_MAP, M24_UPSTREAM_SUBSCRIPTIONS } from "./subscription-map";
export type { M24ConsumerStore } from "./handlers";

export interface M24ConsumeReport {
  readonly handled: boolean;
}

/** The deferred-bind no-op store: records nothing (the live Drizzle store binds with the claim-lifecycle path). */
export function createInMemoryM24ConsumerStore(): M24ConsumerStore {
  return {
    async markClaimPaid() {
      return { applied: false };
    },
    async markClaimDenied() {
      return { applied: false };
    },
    async resolveMedicarePrimary() {
      return { applied: false };
    },
    async enqueueRevalidation() {
      return { enqueued: false };
    },
  };
}

/** Route one delivered upstream event to its M24 effect (§4.4). PHI-free reports; ids + codes only. */
export async function dispatchM24UpstreamEvent(
  event: { topic: string; payload: Record<string, unknown> },
  store: M24ConsumerStore,
): Promise<M24ConsumeReport> {
  const action = (M24_SUBSCRIPTION_MAP as Record<string, string>)[event.topic];
  switch (action) {
    case "mark-claim-paid":
      return { handled: (await handleClaimPaid(store, event.payload)).applied };
    case "mark-claim-denied":
      return { handled: (await handleClaimDenied(store, event.payload)).applied };
    case "resolve-medicare-primary":
      return { handled: (await handleMedicarePrimaryAck(store, event.payload)).applied };
    case "trigger-revalidate":
      return { handled: (await handleUpstreamChange(store, event.payload)).enqueued };
    default:
      return { handled: false };
  }
}
