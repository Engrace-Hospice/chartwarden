// M12's live `m22.document.rendered` back-ref consumer (§4.4 form-rendering handshake, downstream half).
//
// `medication_order.document_id` — "Document backref (M22 outbox handshake; null until rendered)" — and the
// `m12.document-backref` consumer NAME in ./consumers/index.ts have both been declared since M12 landed,
// against an event that did not exist until M22 got a catalog. GAP-024 closed the request half (M12 emits
// at both sign paths); this is the return leg.
//
// FAIL-CLOSED: a document another module requested, or one whose aggregate type is not M12's, is a
// deliberate no-op. Event name is a STRING literal; no M22 import, no new `dependsOn` edge.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, isNull } from "drizzle-orm";

const MED_ORDER = schema.medicationOrders;

export const M12_DOCUMENT_BACKREF_CONSUMER = {
  eventName: "m22.document.rendered",
  consumerName: "m12.document-backref",
} as const;

const M12_AGGREGATE_TYPES = new Set(["medication_order"]);

/** The minimal `m22.document.rendered` shape M12 reads (M22 owns the canonical payload). */
interface DocumentRenderedPayload {
  readonly documentId?: unknown;
  readonly aggregateType?: unknown;
  readonly aggregateId?: unknown;
  readonly sourceModule?: unknown;
}

export function buildM12DocumentBackrefConsumer(deps: { readonly db: DbClient }) {
  return {
    consumerName: M12_DOCUMENT_BACKREF_CONSUMER.consumerName,
    consumerModule: "m12" as const,
    eventTypes: [M12_DOCUMENT_BACKREF_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const p = (event.payload ?? {}) as DocumentRenderedPayload;
      if (p.sourceModule !== "m12") return;
      if (typeof p.aggregateType !== "string" || !M12_AGGREGATE_TYPES.has(p.aggregateType)) return;
      if (typeof p.aggregateId !== "string" || typeof p.documentId !== "string") return;

      await withOrgContext(deps.db, { organizationId: event.organizationId, userId: "" }, (tx) =>
        tx
          .update(MED_ORDER)
          .set({ documentId: p.documentId as string })
          .where(
            and(
              eq(MED_ORDER.organizationId, event.organizationId),
              eq(MED_ORDER.id, p.aggregateId as string),
              isNull(MED_ORDER.documentId), // stamp once — see the M11 sibling for why
            ),
          ),
      );
    },
  };
}
