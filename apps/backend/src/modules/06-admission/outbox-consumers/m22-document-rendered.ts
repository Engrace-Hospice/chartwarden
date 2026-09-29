// M6's live `m22.document.rendered` back-ref consumer (§4.11 render handshake, downstream half).
//
// SIX `document_id` columns — on `certification`, `election_statement`, `f2f_encounter`,
// `nor_acknowledgment`, `revocation_event` and `discharge_event` — have existed since M6's schema landed,
// each commented "M22 document (app-validated)", and NOTHING ever wrote one. Both halves were missing at
// once, which is why neither end looked broken: M22 subscribed to none of M6's six source events, so no
// CoP document was ever rendered, and M6 subscribed to `m22.document.rendered`, so there was nothing to
// stamp even if one had been. These are the Medicare Conditions of Participation artifacts — the
// certification of terminal illness, the election statement, the face-to-face encounter, the notice of
// rights, the revocation and the discharge summary.
//
// F-192 (#248) — the seventh, `transfer_event.document_id` ("(M22) transfer summary"), landed the same
// way once M22 published the `discharge_summary_transfer` variant (mig 0267): a row in the map below,
// not a branch.
//
// The document was already DISCOVERABLE without the stamp — `document.(aggregate_type, aggregate_id)` is
// the reverse index — so this is not "the PDF is lost". It is that every read path on the source row has
// to know M22's taxonomy and join sideways, and the columns M6 built for exactly this stay NULL forever.
//
// FAIL-CLOSED on every off-path: a document another module requested, or one whose aggregate type is not
// M6's, is a deliberate no-op. M6 never writes a back-ref for a document it did not ask for.
//
// The event name is a STRING literal and no M22 schema is imported — M6 reads M22 solely through the
// foundation outbox, so this adds no `dependsOn` edge.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, isNull } from "drizzle-orm";

export const M6_DOCUMENT_BACKREF_CONSUMER = {
  eventName: "m22.document.rendered",
  consumerName: "m6.document-backref",
} as const;

/**
 * `document.aggregate_type` → the UPDATE that stamps the matching M6 row. Kept as DATA rather than a
 * switch so the whole mapping is one assertable table, and so M6's seventh artifact (the transfer
 * variant, once M22 publishes one) is a row rather than a branch.
 *
 * Each entry is a closure rather than a `{table, column}` triple because Drizzle's `update()` is typed
 * per table: a map of heterogeneous tables can only be held by widening them, and a cast here would
 * erase exactly the check that says `documentId` is a column of the table being updated.
 *
 * Every target is keyed by the SAME id M22 was handed as `aggregateId` — the render request carried the
 * source row's own primary key — so the stamp is a single UPDATE with no lookup.
 */
type Stamp = (tx: DbClient, orgId: string, rowId: string, documentId: string) => Promise<unknown>;

const M6_BACKREF_TARGETS: Readonly<Record<string, Stamp>> = {
  cti: (tx, orgId, rowId, documentId) => {
    const T = schema.certificationsOfTerminalIllness;
    return tx
      .update(T)
      .set({ documentId })
      .where(and(eq(T.organizationId, orgId), eq(T.id, rowId), isNull(T.documentId)));
  },
  election_statement: (tx, orgId, rowId, documentId) => {
    const T = schema.electionStatements;
    return tx
      .update(T)
      .set({ documentId })
      .where(and(eq(T.organizationId, orgId), eq(T.id, rowId), isNull(T.documentId)));
  },
  f2f: (tx, orgId, rowId, documentId) => {
    const T = schema.faceToFaceEncounters;
    return tx
      .update(T)
      .set({ documentId })
      .where(and(eq(T.organizationId, orgId), eq(T.id, rowId), isNull(T.documentId)));
  },
  nor: (tx, orgId, rowId, documentId) => {
    const T = schema.noticeOfRightsAcknowledgments;
    return tx
      .update(T)
      .set({ documentId })
      .where(and(eq(T.organizationId, orgId), eq(T.id, rowId), isNull(T.documentId)));
  },
  revocation: (tx, orgId, rowId, documentId) => {
    const T = schema.revocationEvents;
    return tx
      .update(T)
      .set({ documentId })
      .where(and(eq(T.organizationId, orgId), eq(T.id, rowId), isNull(T.documentId)));
  },
  discharge_summary: (tx, orgId, rowId, documentId) => {
    const T = schema.dischargeEvents;
    return tx
      .update(T)
      .set({ documentId })
      .where(and(eq(T.organizationId, orgId), eq(T.id, rowId), isNull(T.documentId)));
  },
  // F-192 (#248) — M6's seventh artifact, the transfer variant, landed. `transfer_event.document_id`
  // ("(M22) transfer summary") has carried this exact comment since the schema landed.
  discharge_summary_transfer: (tx, orgId, rowId, documentId) => {
    const T = schema.transferEvents;
    return tx
      .update(T)
      .set({ documentId })
      .where(and(eq(T.organizationId, orgId), eq(T.id, rowId), isNull(T.documentId)));
  },
};

/** The `document_aggregate_type` values M6 stamps — exported so a test can assert this mapping covers
 *  exactly the templates M22's request consumer renders for M6, in both directions. */
export const M6_BACKREF_AGGREGATE_TYPES = Object.keys(M6_BACKREF_TARGETS);

/** The minimal `m22.document.rendered` shape M6 reads (M22 owns the canonical payload). */
interface DocumentRenderedPayload {
  readonly documentId?: unknown;
  readonly aggregateType?: unknown;
  readonly aggregateId?: unknown;
  readonly sourceModule?: unknown;
}

export function buildM6DocumentBackrefConsumer(deps: { readonly db: DbClient }) {
  return {
    consumerName: M6_DOCUMENT_BACKREF_CONSUMER.consumerName,
    consumerModule: "m6" as const,
    eventTypes: [M6_DOCUMENT_BACKREF_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const p = (event.payload ?? {}) as DocumentRenderedPayload;
      if (p.sourceModule !== "m6") return; // another module's document
      if (typeof p.aggregateType !== "string") return;
      const stamp = M6_BACKREF_TARGETS[p.aggregateType];
      if (!stamp) return; // an aggregate type M6 does not own
      if (typeof p.aggregateId !== "string" || typeof p.documentId !== "string") return;
      const documentId = p.documentId;
      const aggregateId = p.aggregateId;

      // Each stamp narrows on org + id and requires the column to be UNSET. A re-delivery
      // (at-least-once) re-announces the same document, and the W2 addendum path announces a new VERSION
      // of one — neither should overwrite a link a later, different render may have set. The
      // `organization_id` predicate is defence in depth beside RLS, matching M11's consumer.
      await withOrgContext(deps.db, { organizationId: event.organizationId, userId: "" }, (tx) =>
        stamp(tx as DbClient, event.organizationId, aggregateId, documentId),
      );
    },
  };
}
