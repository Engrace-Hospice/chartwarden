// apps/backend/src/modules/26-cap/consumers — the M26 §4.4 upstream-consumer register surface (the M25/M27
// consumers/index.ts mirror). Routes each subscribed topic to its pure handler (./handlers.ts) and exposes
// `dispatchM26UpstreamEvent`. GAP-205: the former `registerM26Consumers` registrar is deleted (dead
// scaffolding). The LIVE M26 bindings are the `OutboxConsumerBinding`s in `./outbox-binding.ts` over the
// Drizzle `CapConsumerStore` (`./drizzle-store.ts`), wired from apps/backend/src/index.ts and proven by
// `arch:outbox-bindings`; `createInMemoryCapConsumerStore` below is test-only.
import {
  type CapConsumerStore,
  handleClaimDaysReversed,
  handleClaimReversed,
  handleFreeze,
  handleInpatientDay,
  handleRemittancePosted,
  handleTransfer,
} from "./handlers";
import { M26_SUBSCRIPTION_MAP, M26_UPSTREAM_SUBSCRIPTIONS } from "./subscription-map";

export { M26_SUBSCRIPTION_MAP, M26_UPSTREAM_SUBSCRIPTIONS } from "./subscription-map";
export type {
  CapConsumerStore,
  AccrualLineToRecord,
  InpatientDayToRecord,
  InpatientDaysReversal,
} from "./handlers";

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
    async reverseInpatientDays() {
      return { reversed: 0 };
    },
    async freezePatient() {
      return { frozen: false };
    },
    async setProportionalWeight() {
      return { updated: false };
    },
  };
}

/**
 * GAP-038 - the topics that also take a claim's inpatient days out of the cap ledger, and which payload field
 * names the affected (paid) claim. A topic keeps its single money-side action in `M26_SUBSCRIPTION_MAP`; the
 * day reversal is an additional effect of the same delivery, so no new topic is subscribed.
 */
const DAY_REVERSAL_CLAIM_FIELD: Readonly<Record<string, "originalClaimId" | "claimId">> = {
  "m23.claim.replaced": "originalClaimId",
  "m23.claim.voided": "originalClaimId",
  "m25.remittance.claim_recouped": "claimId",
};

/** Route one delivered upstream event to its M26 effect (§4.4). PHI-free reports; ids + cents only. */
export async function dispatchM26UpstreamEvent(
  event: { topic: string; payload: Record<string, unknown> },
  store: CapConsumerStore,
): Promise<M26ConsumeReport> {
  const primary = await routePrimaryEffect(event, store);
  const claimIdField = DAY_REVERSAL_CLAIM_FIELD[event.topic];
  if (!claimIdField) return primary;
  const days = await handleClaimDaysReversed(store, event.payload, claimIdField);
  return { handled: primary.handled || days.reversed > 0 };
}

async function routePrimaryEffect(
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
