// M11's live `m22.document.rendered` back-ref consumer (§4.4 form-rendering handshake, downstream half).
//
// `order_record.document_id` has existed since M11's schema landed, commented "Document backref (M22 outbox
// handshake; null until reports rendered)", and nothing ever wrote it — M22 had no event catalog, so the
// event this subscribes to did not exist. The upstream half (M11 emitting `m11.order.document_requested` at
// sign) closed in GAP-023; this is the return leg.
//
// FAIL-CLOSED on every off-path: a document another module requested, or one whose aggregate type is not
// M11's, is a deliberate no-op. M11 never writes a back-ref for a document it did not ask for.
//
// The event name is a STRING literal and no M22 schema is imported — M11 reads M22 solely through the
// foundation outbox, so this adds no `dependsOn` edge.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, isNull } from "drizzle-orm";

const ORDER = schema.orderRecords;

export const M11_DOCUMENT_BACKREF_CONSUMER = {
  eventName: "m22.document.rendered",
  consumerName: "m11.document-backref",
} as const;

/** The `document.aggregate_type` values that materialize an `order_record` row (M22's `order_record`
 *  template, and the §7.15 lab-results PDF which renders under the same aggregate type). */
const M11_AGGREGATE_TYPES = new Set(["order_record"]);

/** The minimal `m22.document.rendered` shape M11 reads (M22 owns the canonical payload). */
interface DocumentRenderedPayload {
  readonly documentId?: unknown;
  readonly aggregateType?: unknown;
  readonly aggregateId?: unknown;
  readonly sourceModule?: unknown;
}

export function buildM11DocumentBackrefConsumer(deps: { readonly db: DbClient }) {
  return {
    consumerName: M11_DOCUMENT_BACKREF_CONSUMER.consumerName,
    consumerModule: "m11" as const,
    eventTypes: [M11_DOCUMENT_BACKREF_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const p = (event.payload ?? {}) as DocumentRenderedPayload;
      if (p.sourceModule !== "m11") return; // another module's document
      if (typeof p.aggregateType !== "string" || !M11_AGGREGATE_TYPES.has(p.aggregateType)) return;
      if (typeof p.aggregateId !== "string" || typeof p.documentId !== "string") return;

      await withOrgContext(deps.db, { organizationId: event.organizationId, userId: "" }, (tx) =>
        tx
          .update(ORDER)
          .set({ documentId: p.documentId as string })
          .where(
            and(
              eq(ORDER.organizationId, event.organizationId),
              eq(ORDER.id, p.aggregateId as string),
              // Only stamp an UNSET column. A re-delivery (at-least-once) re-announces the same document,
              // and a W2 addendum announces a new VERSION of the same document — neither should overwrite
              // a link a later, different render may have set.
              isNull(ORDER.documentId),
            ),
          ),
      );
    },
  };
}
