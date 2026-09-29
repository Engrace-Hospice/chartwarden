// apps/backend/src/modules/26-cap/consumers/outbox-binding.ts — the `OutboxConsumerBinding` adapter
// (F-131, #248) over `dispatchM26UpstreamEvent` (the `buildM13ReconciliationTriggerConsumer` /
// `buildM30UpstreamConsumerPorts` shape) — a THIN wrapper, not a second implementation: the actual
// per-topic routing stays exactly where it already lived, in `./index.ts`'s `dispatchM26UpstreamEvent` +
// `./subscription-map.ts`'s `M26_SUBSCRIPTION_MAP`. This file exists only so
// `check-outbox-bindings.ts`'s discovery probe (which imports every `build*Consumer`-named export and
// calls it with an absorbing stub) can see M26 has a real, live binding once the composition root wires
// it — `registerM26Consumers({ store, bind })` was never itself an `OutboxConsumerBinding`, and nothing
// in `apps/backend/src/index.ts` has ever called it.
//
// BOUND_TOPICS covers all nine keys of `M26_SUBSCRIPTION_MAP` as of F-163 (#248): the original six
// F-131 confirmed as real, catalog-agreeing §4.4 subscriptions — `m23.claim.line_finalized` / `.replaced`
// / `.voided`, `m25.remittance.advice_posted`, `m6.revocation.created`, `m6.transfer.created` — plus two
// more whose routing was already real but whose catalog declaration was missing:
//   - `m5.patient.deceased` maps to the same `freeze-patient` action (over the identical `handleFreeze`
//     handler) as the already-bound `m6.revocation.created`. `events-by-m5.ts` now lists `m26` in its
//     `declaredConsumers` (F-160).
//   - `m36.notification.delivery_failed` routes to `surface-stuck-alert`, a documented no-op
//     (`dispatchM26UpstreamEvent`'s own comment: "operational surfacing only; no ledger effect") — binding
//     it live fixes the catalog/binding disagreement even though no delivery does anything observable yet,
//     and the event still has no real producer (`events-by-m36.ts`'s own header). `events-by-m36.ts` now
//     lists `m26` in its `declaredConsumers` (F-160).
// F-163 (#248) added the ninth and last of M26's originally-deferred pairs: `m25.remittance.claim_recouped`
// routes to the same `record-reversal-line` action (`handleClaimReversed`) as `m23.claim.replaced`/
// `.voided`, now that its payload actually carries the `patientId`/`recoupedAmountCents`/`serviceFrom`/
// `serviceTo` fields the handler reads (widened at the M25 emit site — see `events-by-m25.ts` and
// `ingest/service-drizzle.ts`'s own F-163 comments). `m23.claim.replaced`/`.voided` themselves stay a
// documented, PRE-EXISTING no-op independent of this fix — neither payload carries `patientId` or any
// amount field under any of the three names `handleClaimReversed` reads (F-131's own note, confirmed
// still true here) — so they are correctly BOUND (routed, catalog-agreeing) while still functionally
// inert until a future pass widens THEIR payloads the same way.
import { type CapConsumerStore, dispatchM26UpstreamEvent } from "./index";
import type { M26SubscribedTopic } from "./subscription-map";

export interface OutboxEventToConsume {
  readonly eventType: string;
  readonly id: string;
  readonly organizationId: string;
  readonly payload: unknown;
}

/** All nine confirmed-real, catalog-agreeing §4.4 subscriptions (F-131, F-160, F-163) — see the header. */
export const BOUND_TOPICS: readonly M26SubscribedTopic[] = [
  "m23.claim.line_finalized",
  "m23.claim.replaced",
  "m23.claim.voided",
  "m25.remittance.advice_posted",
  "m25.remittance.claim_recouped",
  "m5.patient.deceased",
  "m6.revocation.created",
  "m6.transfer.created",
  "m36.notification.delivery_failed",
];

/**
 * Build the live M26 upstream-consumer binding over an already-constructed {@link CapConsumerStore}
 * (the composition root passes `createDrizzleCapConsumerStore(db, { mbi, firstElection })` —
 * `./drizzle-store.ts`). An unrecognized payload shape degrades to the handler's own honest
 * `{ recorded: false }` / `{ frozen: false }` / `{ updated: false }` rather than throwing, so a
 * malformed delivery does not wedge the dispatcher — `dispatchM26UpstreamEvent`'s own handlers already
 * guard every field read.
 */
export function buildM26UpstreamConsumer(store: CapConsumerStore) {
  return {
    consumerName: "m26.upstream-events" as const,
    consumerModule: "m26" as const,
    eventTypes: BOUND_TOPICS,
    async handle(event: OutboxEventToConsume): Promise<void> {
      await dispatchM26UpstreamEvent(
        { topic: event.eventType, payload: (event.payload ?? {}) as Record<string, unknown> },
        store,
      );
    },
  };
}
