// M13's live `m22.document.rendered` back-ref consumer (§4.4 render handshake, downstream half).
//
// `medication_reconciliation_worksheet.document_id` (commented "M22 back-ref") and the
// `m13.pdf-rendered-backref` consumer NAME in ./consumers/index.ts have both been declared since M13
// landed, against an event that did not exist until M22 got a catalog. M13 is the one module that ALWAYS
// emitted its render request for real (`finalize-reconciliation`) — its rows just sat `pending` with
// nothing to drain them, and then nothing to answer them.
//
// FAIL-CLOSED: another module's document, or an aggregate type that is not M13's, is a deliberate no-op.
// Event name is a STRING literal; no M22 import, no new `dependsOn` edge.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, isNull } from "drizzle-orm";

const WS = schema.medicationReconciliationWorksheets;

export const M13_DOCUMENT_BACKREF_CONSUMER = {
  eventName: "m22.document.rendered",
  consumerName: "m13.pdf-rendered-backref",
} as const;

const M13_AGGREGATE_TYPES = new Set(["medication_reconciliation_worksheet"]);

/** The minimal `m22.document.rendered` shape M13 reads (M22 owns the canonical payload). */
interface DocumentRenderedPayload {
  readonly documentId?: unknown;
  readonly aggregateType?: unknown;
  readonly aggregateId?: unknown;
  readonly sourceModule?: unknown;
}

export function buildM13DocumentBackrefConsumer(deps: { readonly db: DbClient }) {
  return {
    consumerName: M13_DOCUMENT_BACKREF_CONSUMER.consumerName,
    consumerModule: "m13" as const,
    eventTypes: [M13_DOCUMENT_BACKREF_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const p = (event.payload ?? {}) as DocumentRenderedPayload;
      if (p.sourceModule !== "m13") return;
      if (typeof p.aggregateType !== "string" || !M13_AGGREGATE_TYPES.has(p.aggregateType)) return;
      if (typeof p.aggregateId !== "string" || typeof p.documentId !== "string") return;

      await withOrgContext(deps.db, { organizationId: event.organizationId, userId: "" }, (tx) =>
        tx
          .update(WS)
          .set({ documentId: p.documentId as string })
          .where(
            and(
              eq(WS.organizationId, event.organizationId),
              eq(WS.id, p.aggregateId as string),
              isNull(WS.documentId), // stamp once — see the M11 sibling for why
            ),
          ),
      );
    },
  };
}
