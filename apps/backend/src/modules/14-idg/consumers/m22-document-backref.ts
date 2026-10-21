// apps/backend/src/modules/14-idg/consumers/m22-document-backref.ts — M14's live `m22.document.rendered`
// back-ref consumer (§4.4 form-rendering handshake, the RETURN leg).
//
// The request half has been live since F-166: `m14.minutes.signed` / `m14.packet.render_requested` are bound
// to M22's render consumer, which renders through the real `DocumentRenderer` and emits
// `m22.document.rendered`. Nothing on M14's side ever consumed that answer, so `idg_minutes.minutes_document_id`
// and `idg_patient_packet.packet_document_id` — "M22 PDF back-ref (app-validated; no FK)" — were written by NO
// code path and read back as NULL forever: the minutes screen said "not rendered" for a document that HAD
// been rendered. `M14_OUTBOX_SUBSCRIPTIONS` has carried the `m14.m22-document-backref` name since M14-T06;
// this is the binding it named.
//
// FAIL-CLOSED: a document another module requested (`sourceModule !== 'm14'`), or an aggregate type that is
// not one of M14's two, is a deliberate no-op — never a stray write. Event and aggregate names are STRING
// literals and no M22 code/schema is imported, so this adds no `dependsOn` edge (§1.1).
//
// IDEMPOTENT: the write is "set the back-ref to this document id" keyed on `(organization_id, id)`. M22's
// W2 append path (`m14.minutes.amended`) renders a new VERSION of the SAME document, so the id is stable and
// a redelivery or an amendment re-stamps the identical value. A row that does not exist in the event's own
// org (erased / cross-tenant / stale) matches zero rows and is a no-op, not a retry storm.
//
// TENANCY: a relay tick is not a request — the write runs in `withOrgContext` pinned to the event's own
// `organizationId`, and the explicit `organization_id` predicate is the belt behind RLS.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";

const MIN = schema.idgMinutes;
const PKT = schema.idgPatientPacket;

/** §3.3 — a consumer-driven write names no acting membership. */
const CONSUMER_USER_ID = "";

export const M14_DOCUMENT_BACKREF_CONSUMER = {
  eventName: "m22.document.rendered",
  consumerName: "m14.m22-document-backref",
} as const;

/** The minimal `m22.document.rendered` shape M14 reads (M22 owns the canonical payload). */
interface DocumentRenderedPayload {
  readonly documentId?: unknown;
  readonly aggregateType?: unknown;
  readonly aggregateId?: unknown;
  readonly sourceModule?: unknown;
}

export interface IdgDocumentBackrefConsumerDeps {
  readonly db: DbClient;
}

export function buildM14DocumentBackrefConsumer(
  deps: IdgDocumentBackrefConsumerDeps,
): OutboxConsumerBinding {
  return {
    consumerName: M14_DOCUMENT_BACKREF_CONSUMER.consumerName,
    consumerModule: "m14",
    eventTypes: [M14_DOCUMENT_BACKREF_CONSUMER.eventName],
    async handle(event): Promise<void> {
      const p = (event.payload ?? {}) as DocumentRenderedPayload;
      if (p.sourceModule !== "m14") return;
      if (typeof p.aggregateId !== "string" || typeof p.documentId !== "string") return;
      const { aggregateType, aggregateId, documentId } = p as {
        aggregateType: unknown;
        aggregateId: string;
        documentId: string;
      };
      if (aggregateType !== "idg_minutes" && aggregateType !== "idg_patient_packet") return;

      const organizationId = event.organizationId;
      await withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (tx) => {
        if (aggregateType === "idg_minutes") {
          await tx
            .update(MIN)
            .set({ minutesDocumentId: documentId })
            .where(and(eq(MIN.organizationId, organizationId), eq(MIN.id, aggregateId)));
        } else {
          await tx
            .update(PKT)
            .set({ packetDocumentId: documentId })
            .where(and(eq(PKT.organizationId, organizationId), eq(PKT.id, aggregateId)));
        }
      });
    },
  };
}
