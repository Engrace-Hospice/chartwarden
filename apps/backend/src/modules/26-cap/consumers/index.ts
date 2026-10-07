// apps/backend/src/modules/26-cap/consumers — the M26 §4.4 upstream-consumer register surface (the M25/M27
// consumers/index.ts mirror). Routes each subscribed topic to its pure handler (./handlers.ts) and exposes
// `registerM26Consumers`. GAP-205: `registerM26Consumers` and `createInMemoryCapConsumerStore` are DEAD
// SCAFFOLDING — nothing outside tests calls them. The LIVE M26 bindings are the `OutboxConsumerBinding`s in
// `./outbox-binding.ts` over the Drizzle `CapConsumerStore` (`./drizzle-store.ts`), wired from
// apps/backend/src/index.ts; `arch:outbox-bindings` proves them, not this file.
import {
  type CapConsumerStore,
  handleClaimReversed,
  handleFreeze,
  handleInpatientDay,
  handleRemittancePosted,
  handleTransfer,
} from "./handlers";
import {
  type M26SubscribedTopic,
  M26_SUBSCRIPTION_MAP,
  M26_UPSTREAM_SUBSCRIPTIONS,
} from "./subscription-map";

export { M26_SUBSCRIPTION_MAP, M26_UPSTREAM_SUBSCRIPTIONS } from "./subscription-map";
export type { CapConsumerStore, AccrualLineToRecord, InpatientDayToRecord } from "./handlers";

export interface M26ConsumeReport {
  readonly handled: boolean;
}

/** A no-op store for tests: records nothing. Production binds the Drizzle store (`./drizzle-store.ts`). */
export function createInMemoryCapConsumerStore(): CapConsumerStore {
  return {
    async recordAccrualLine() {
      return { recorded: false };
    },
    async recordInpatientDay() {
      return { recorded: false };
    },
    async freezePatient() {
      return { frozen: false };
    },
    async setProportionalWeight() {
      return { updated: false };
    },
  };
}

/** Route one delivered upstream event to its M26 effect (§4.4). PHI-free reports; ids + cents only. */
export async function dispatchM26UpstreamEvent(
  event: { topic: string; payload: Record<string, unknown> },
  store: CapConsumerStore,
): Promise<M26ConsumeReport> {
  const action = (M26_SUBSCRIPTION_MAP as Record<string, string>)[event.topic];
  switch (action) {
    case "record-accrual-line":
      return { handled: (await handleRemittancePosted(store, event.payload)).recorded };
    case "record-reversal-line":
      return { handled: (await handleClaimReversed(store, event.payload)).recorded };
    case "record-inpatient-day-line":
      return { handled: (await handleInpatientDay(store, event.payload)).recorded };
    case "freeze-patient":
      return { handled: (await handleFreeze(store, event.payload)).frozen };
    case "init-proportional-weight":
      return { handled: (await handleTransfer(store, event.payload)).updated };
    case "surface-stuck-alert":
      // m36.notification.delivery_failed — operational surfacing only; no ledger effect (forward-declared).
      return { handled: true };
    default:
      return { handled: false };
  }
}

/**
 * Register the M26 §4.4 upstream consumers (the M25 register-surface mirror). The boot dispatcher calls this
 * with its `bind(topic, handler)` registrar + the live store; each subscription is bound to a closure over
 * {@link dispatchM26UpstreamEvent}. NOT CALLED by the composition root (GAP-205): the live bindings are in
 * `./outbox-binding.ts`; this only returns the forward-declared subscriptions.
 */
export function registerM26Consumers(options?: {
  readonly store?: CapConsumerStore;
  readonly bind?: (
    topic: string,
    handler: (payload: Record<string, unknown>) => Promise<M26ConsumeReport>,
  ) => void;
}): readonly M26SubscribedTopic[] {
  const { store, bind } = options ?? {};
  if (bind && store) {
    for (const topic of M26_UPSTREAM_SUBSCRIPTIONS) {
      bind(topic, (payload) => dispatchM26UpstreamEvent({ topic, payload }, store));
    }
  }
  return M26_UPSTREAM_SUBSCRIPTIONS;
}
