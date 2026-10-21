// M21's live `m22.document.rendered` back-ref consumer (§4.5.2 M22 handoff, downstream half).
//
// M21 §3 declares THREE back-ref columns — `supply_request.document_id`,
// `comfort_kit_dispatch.bol_document_id`, `comfort_kit_return.receipt_document_id` — and M21's spec §4.4
// says outright: "M21 stores the rendered-document UUID returned by M22's `m22.document.rendered`
// consumer". That consumer did not exist, on either side of the handshake, until now.
//
// M21 is the only requester whose ONE event yields TWO artifacts, so this is also the only back-ref
// consumer that routes on `aggregateType`: the bill of lading lands on the DISPATCH row, the DEA-1304
// return receipt on the RETURN row. `supply_request.document_id` is deliberately NOT written here — M21
// emits no request that back-refs the supply_request itself (the packing-list kind its event description
// mentions is never emitted), and inventing a mapping would put a dispatch's document on a different row.
//
// FAIL-CLOSED: another module's document, or an aggregate type that is not M21's, is a deliberate no-op.
// Event name is a STRING literal; no M22 import, no new `dependsOn` edge.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, isNull } from "drizzle-orm";

const DISPATCH = schema.comfortKitDispatch;
const RETURN = schema.comfortKitReturn;

export const M21_DOCUMENT_BACKREF_CONSUMER = {
  eventName: "m22.document.rendered",
  consumerName: "m21.document-backref",
} as const;

/** The minimal `m22.document.rendered` shape M21 reads (M22 owns the canonical payload). */
interface DocumentRenderedPayload {
  readonly documentId?: unknown;
  readonly aggregateType?: unknown;
  readonly aggregateId?: unknown;
  readonly sourceModule?: unknown;
}

export function buildM21DocumentBackrefConsumer(deps: { readonly db: DbClient }) {
  return {
    consumerName: M21_DOCUMENT_BACKREF_CONSUMER.consumerName,
    consumerModule: "m21" as const,
    eventTypes: [M21_DOCUMENT_BACKREF_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const p = (event.payload ?? {}) as DocumentRenderedPayload;
      if (p.sourceModule !== "m21") return;
      if (typeof p.aggregateId !== "string" || typeof p.documentId !== "string") return;
      const documentId = p.documentId as string;
      const aggregateId = p.aggregateId as string;

      // Route BEFORE opening the transaction. Every rendered document in the tenant is delivered to this
      // consumer; deciding inside the tx would take a pooled connection for each one only to discover it
      // is not M21's — and the other three back-ref consumers are doing the same thing at the same moment.
      const target =
        p.aggregateType === "supply_bill_of_lading"
          ? ({ kind: "bol" } as const)
          : p.aggregateType === "comfort_kit_return_receipt"
            ? ({ kind: "receipt" } as const)
            : null;
      if (target === null) return;

      await withOrgContext(
        deps.db,
        { organizationId: event.organizationId, userId: "" },
        async (tx) => {
          if (target.kind === "bol") {
            await tx
              .update(DISPATCH)
              .set({ bolDocumentId: documentId })
              .where(
                and(
                  eq(DISPATCH.organizationId, event.organizationId),
                  eq(DISPATCH.id, aggregateId),
                  isNull(DISPATCH.bolDocumentId), // stamp once — see the M11 sibling for why
                ),
              );
            return;
          }
          await tx
            .update(RETURN)
            .set({ receiptDocumentId: documentId })
            .where(
              and(
                eq(RETURN.organizationId, event.organizationId),
                eq(RETURN.id, aggregateId),
                isNull(RETURN.receiptDocumentId),
              ),
            );
        },
      );
    },
  };
}
