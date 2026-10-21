// apps/backend/src/modules/36-messaging/promotions/promotion-events.ts - WP 3.7: the transactional outbox event a proposal
// emits. PHI-free by construction: ids, enums and an instant only - never a patient id, a body hash or any text. Published
// in the SAME transaction as the write (the caller passes its `tx`), so an event never announces a write that rolled back.
// A replay changes nothing and publishes nothing. The catalog entries live in events-by-m36.ts (added with the consumers).
// The two `decided` events are published by the OWNING modules (M8, M14), not here; the outcome consumer reads them.
import type { ChartPromotionTargetKind, ChartPromotionTargetModule } from "@chartwarden/types";
import type { HintOutboxPort } from "../message-hint-events";

export const M36_PROMOTION_EVENTS = {
  requested: "m36.promotion.requested",
} as const;

export const PROMOTION_AGGREGATE_KIND = "chart_promotion_request";

export interface PromotionRequestedFacts {
  readonly orgId: string;
  readonly promotionRequestId: string;
  readonly targetModule: ChartPromotionTargetModule;
  readonly targetKind: ChartPromotionTargetKind;
  readonly requestedByUserId: string;
  readonly at: Date;
}

/** The event payload: `organizationId` named as the catalog expects, the instant as an ISO string. */
export function promotionRequestedPayload(facts: PromotionRequestedFacts): Record<string, unknown> {
  return {
    organizationId: facts.orgId,
    promotionRequestId: facts.promotionRequestId,
    targetModule: facts.targetModule,
    targetKind: facts.targetKind,
    requestedByUserId: facts.requestedByUserId,
    at: facts.at.toISOString(),
  };
}

export async function publishPromotionRequested(
  outbox: HintOutboxPort | undefined,
  tx: unknown,
  facts: PromotionRequestedFacts,
): Promise<void> {
  await outbox?.publish(tx, {
    eventName: M36_PROMOTION_EVENTS.requested,
    organizationId: facts.orgId,
    aggregateKind: PROMOTION_AGGREGATE_KIND,
    aggregateId: facts.promotionRequestId,
    payload: promotionRequestedPayload(facts),
  });
}
