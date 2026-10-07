// apps/backend/src/modules/26-cap/consumers — the M26 §4.4 upstream-consumer register surface (the M25/M27
// consumers/index.ts mirror). Routes each subscribed topic to its pure handler (./handlers.ts) and exposes
// `dispatchM26UpstreamEvent`. GAP-205: the former `registerM26Consumers` registrar is deleted (dead
// scaffolding). The LIVE M26 bindings are the `OutboxConsumerBinding`s in `./outbox-binding.ts` over the
// Drizzle `CapConsumerStore` (`./drizzle-store.ts`), wired from apps/backend/src/index.ts and proven by
// `arch:outbox-bindings`; `createInMemoryCapConsumerStore` below is test-only.
import {
  type CapConsumerStore,
  handleClaimReversed,
  handleFreeze,
  handleInpatientDay,
  handleRemittancePosted,
  handleTransfer,
} from "./handlers";
import {
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
