// apps/backend/src/modules/14-idg/consumers/m11-since-last-idg.ts — the §4.5 "since last IDG" projection
// cache, M11 half (F-164, #248). See `./since-last-idg-cache.ts` for the scope decision (this event is the
// deliberate departure from the seam-vs-push rule, not the redundant-with-a-seam case) and key scheme.
//
// `m11.order.discontinued`'s payload carries no `patientId` or order kind — both resolved via M11's
// org-explicit `orderPatientAndKindForOrg` seam (`11-orders/seams/drizzle-store.ts`), injected as a port
// rather than read off M11's schema directly (M14's `dependsOn` is `[1, 7, 8, 36]` — no edge to 11;
// `arch:tables` refuses a direct cross-module Drizzle import regardless). The same "a relay tick is not a
// request" reasoning `./m10-since-last-idg.ts` documents for M10 applies here too — M11's published
// `OrderProvider.getOrder` seam opens every read under `withOrgContextFromRequest` and cannot be called
// from here.
import type Redis from "ioredis";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { appendSinceLastIdgEntry } from "./since-last-idg-cache";

export interface SinceLastIdgOrderDeps {
  readonly redis: Redis;
  /** M11's org-explicit `orderPatientAndKindForOrg` seam, injected as a port. */
  readonly orderPatientAndKind: (
    organizationId: string,
    orderId: string,
  ) => Promise<{ readonly patientId: string; readonly kind: string } | null>;
}

function stringField(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `m11.order.discontinued` → the shared `orderChanges` slot. */
export function buildM14OrderDiscontinuedConsumer(
  deps: SinceLastIdgOrderDeps,
): OutboxConsumerBinding {
  return {
    consumerName: "m14.m11-order-discontinued",
    consumerModule: "m14",
    eventTypes: ["m11.order.discontinued"],
    async handle(event): Promise<void> {
      const orderId = stringField(event.payload, "orderId");
      const effectiveAt = stringField(event.payload, "effectiveAt");
      if (orderId === null || effectiveAt === null) {
        throw new Error("m14.m11-order-discontinued: payload missing a required field");
      }
      const order = await deps.orderPatientAndKind(event.organizationId, orderId);
      if (order === null) return; // no matching order_record in this org — nothing to cache
      await appendSinceLastIdgEntry(deps.redis, order.patientId, "orderChanges", event.id, {
        _digestId: event.id,
        orderId,
        orderKind: order.kind,
        changeKind: "discontinued",
        changedAt: effectiveAt,
      });
    },
  };
}
