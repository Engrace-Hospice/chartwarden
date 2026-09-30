// apps/backend/src/modules/22-documents/events-by-m22.ts — Module 22's outbox-event contribution: the
// DOWNSTREAM half of the §7.2 W2 render handshake.
//
// M22 had no event catalog at all. Every source module's `m*.document-backref` consumer name has been
// declared since its own T0x task — M12 `m12.document-backref`, M13 `m13.pdf-rendered-backref`, M14, M21,
// M23, M25, M27, M39 — all subscribing to `m22.document.rendered`, an event that existed only in prose.
// So `order_record.document_id`, `medication_order.document_id`,
// `medication_reconciliation_worksheet.document_id`, `comfort_kit_dispatch.bol_document_id` and
// `comfort_kit_return.receipt_document_id` (columns that all exist, each commented "M22 back-ref") were
// unreachable: the render half (./outbox-consumers/render-consumer.ts) files a document the source row can
// never point at. This catalog is the missing half.
//
// The rendered document was already DISCOVERABLE without the stamp — `document.(aggregate_type,
// aggregate_id)` is the reverse index — so this is not "the PDF is lost". It is that every read path on the
// source row has to know M22's taxonomy and join sideways, and the columns the source modules built for
// exactly this purpose stay NULL forever.
//
// DECLARED CONSUMERS ARE THE BOUND ONES, NOT THE INTERESTED ONES. The dispatcher keeps a row `pending` on a
// slow re-check clock while any catalog-declared consumer module has no live binding (staged deployment,
// deliberately) — and it THROWS at construction if a module binds an event it is not declared for, so the
// list and the bindings move together, in one commit, in both directions. Listing M14/M23/M25/M27/M39 here
// because their subscription maps name the event would leave EVERY render's back-ref event pending forever
// — a permanent backlog that reads as an outage. Each belongs here on the commit that binds its handler;
// M33 joined on GAP-051's.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

const Id = Type.String({ minLength: 1 });
const IdN = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
const Iso = Type.String({ minLength: 1 });

/** The one `m22.*` event M22 produces (§7.2 W2, downstream half). */
export const M22_DOCUMENT_RENDERED_EVENT = "m22.document.rendered" as const;

export const M22_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: M22_DOCUMENT_RENDERED_EVENT,
    moduleOwner: "m22",
    description:
      "A `*.document_requested` render completed: the rendered `document` (+ version) exists and the requesting module can stamp its own back-ref column. Carries the routing the requester keys on — `sourceEvent` / `sourceModule` (whose request this answers), `aggregateType` / `aggregateId` (which of its rows), and the minted `documentId`.",
    payloadSchema: Type.Object({
      /** The minted M22 document — the value the requesting module writes to its back-ref column. */
      documentId: Id,
      documentVersionId: Id,
      /** 1 on a first render; >1 when the W2 addendum/correction path appended to an existing document. */
      versionNumber: Type.Integer(),
      isFirstVersion: Type.Boolean(),
      /** The published template key that produced it (`order_record`, `abn`, …). */
      templateKey: Id,
      /** The source artifact this document materializes — the requester's own row. */
      aggregateType: Id,
      aggregateId: Id,
      retentionClass: Id,
      /** The chart-target patient, or null for a patient-independent render. */
      patientId: IdN,
      /** The `*.document_requested` event this answers, and the module that emitted it. A consumer keys on
       *  these to ignore documents it did not request (fail-closed: never a stray back-ref write). */
      sourceEvent: Id,
      sourceModule: Id,
      renderedAt: Iso,
    }),
    // F-108 — m27 joins on the commit that binds `m27.document-backref`, exactly as the header above
    // requires. Its three `ecr_submission` back-ref columns are the ECR file, the Print Image and the
    // supporting-doc bundle; the pure decider for them shipped with M27-T09 and had no caller at all.
    // F-139 (#248) — m31 was ADDED here (M31's §4.10 table names this event -> a `portal_document_share`
    // row). F-225 (#248) — m31 DROPPED again (user-approved, F-221): M31 answers "what can this account see"
    // by SEAM PULL (`PortalDocumentReader.documentsForPatient`), a push on render cannot record a VIEW, and
    // the disclosure accounting it was presumed to back now exists where it belongs — M22's
    // `document_access_log` row appended by `mintPortalDownloadUrl` + the route's M4 read-audit.
    // See docs/history/m31-portal-deferrals.md. `m31` is recorded as a `seamConsumers` entry (the F-043 / #103
    // / F-180 shape): a real relationship the outbox does not carry.
    declaredConsumers: ["m6", "m11", "m12", "m13", "m14", "m21", "m27", "m33"],
    seamConsumers: ["m31"],
    isOutboxOnly: true,
  },
];
