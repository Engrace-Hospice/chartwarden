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
import {
  M22_EXTRACTION_COMMIT_COMPLETED_EVENT,
  M22_EXTRACTION_COMMIT_REQUESTED_EVENT,
  M22_EXTRACTION_DIAGNOSIS_COMMIT_REQUESTED_EVENT,
  M22_INTAKE_SUD_CONFIRMED_EVENT,
  M22_INTAKE_SUD_DETECTED_EVENT,
  M22_INTAKE_SUD_REJECTED_EVENT,
  M22_INTAKE_SUD_RELINKED_EVENT,
  type ModuleEventContribution,
} from "@wardenx/types";
import { M22_CLINICAL_WRITEBACK_EVENTS } from "./events-by-m22-clinical";

const Id = Type.String({ minLength: 1 });
const IdN = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
const Iso = Type.String({ minLength: 1 });

/** The §7.2 W2 render-handshake event (downstream half). */
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
  // F-235 (#248) — the §7.1 W1 steps 11–13 chart-writeback handshake, narrowed by F-231's A1 + B
  // (`@wardenx/types` doclens-writeback.ts): medications never write back; M5 is the only target, as a
  // low-risk contact-field update on the batch's already-resolved patient. Emitted by
  // `POST /api/v1/intake/reviews/:id/complete` in the same transaction as the provenance rows.
  {
    eventName: M22_EXTRACTION_COMMIT_REQUESTED_EVENT,
    moduleOwner: "m22",
    description:
      "A completed DocLens review's approved, allowlisted demographics for ONE resolved patient (W1 step 11, grouped per target aggregate). Values are the server-side attested ones — the reviewer's stored edit, else the DEK-decrypted extraction — never client-supplied at commit. M5 applies them and replies with `m5.patient.draft_created_from_extraction`.",
    payloadSchema: Type.Object({
      extractionCommitId: Id,
      organizationId: Id,
      intakeBatchId: Id,
      targetModule: Type.Literal("m5"),
      targetAggregateId: Id,
      sourceDocumentIds: Type.Array(Id, { minItems: 1 }),
      reviewerMembershipId: Id,
      fields: Type.Array(
        Type.Object({ fieldPath: Id, value: Type.String({ minLength: 1, maxLength: 4000 }) }),
        { minItems: 1 },
      ),
      requestedAt: Iso,
    }),
    declaredConsumers: ["m5"],
    isOutboxOnly: true,
  },
  {
    eventName: M22_EXTRACTION_COMMIT_COMPLETED_EVENT,
    moduleOwner: "m22",
    description:
      "A target module's writeback reply was stamped onto `extraction_provenance.target_aggregate_id` for the fields the chart now holds (W1 step 13): M5 demographics (F-235), M5 allergies or M12 medication history (F-238). Terminal and informational; carries ids and per-field outcomes only, no values.",
    payloadSchema: Type.Object({
      extractionCommitId: Id,
      // F-238 — `m7` when the reply was M7's diagnosis proposals (`targetAggregateId` is then the patient);
      // `m12` for medication history; `m5` for demographics and allergies.
      targetModule: Type.Union([Type.Literal("m5"), Type.Literal("m7"), Type.Literal("m12")]),
      targetAggregateId: Id,
      provenanceIds: Type.Array(Id),
      skippedFieldPaths: Type.Array(Id),
      completedAt: Iso,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  // F-238 dx-writeback — the DIAGNOSIS half of the W1 steps 11–13 handshake. A completed review's approved
  // `diagnoses[n].*` for the resolved patient; M7 lands each as a PROPOSED problem (its own
  // `problem_proposal` table — never `problem`) that a clinician must accept, choosing `kind`. A separate
  // event rather than `commit_requested` + `targetModule='m7'` so M5's consumer (fail-closed on a non-M5
  // payload) never receives it; the payload still carries the D5 `targetModule` discriminator.
  {
    eventName: M22_EXTRACTION_DIAGNOSIS_COMMIT_REQUESTED_EVENT,
    moduleOwner: "m22",
    description:
      "A completed DocLens review's reviewer-attested diagnoses for ONE resolved patient (W1 step 11). Each carries the description as written (or the reviewer's edit), the ICD-10-CM code as PRINTED or as typed by the reviewer (never model-suggested), the document's own role label, and the Part 2 flag. M7 creates pending problem proposals a clinician must accept and replies with `m7.problem.draft_created_from_extraction`.",
    payloadSchema: Type.Object({
      extractionCommitId: Id,
      organizationId: Id,
      intakeBatchId: Id,
      targetModule: Type.Literal("m7"),
      targetAggregateId: Id,
      sourceDocumentIds: Type.Array(Id, { minItems: 1 }),
      reviewerMembershipId: Id,
      referralDate: Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }),
      diagnoses: Type.Array(
        Type.Object({
          itemKey: Type.String({ minLength: 1, maxLength: 200 }),
          description: Type.String({ minLength: 1, maxLength: 4000 }),
          icd10Code: Type.Union([Type.String({ minLength: 3, maxLength: 8 }), Type.Null()]),
          icd10Source: Type.Union([
            Type.Literal("document"),
            Type.Literal("reviewer_edit"),
            Type.Null(),
          ]),
          documentRole: Type.Union([
            Type.Literal("principal"),
            Type.Literal("secondary"),
            Type.Literal("history"),
            Type.Literal("unspecified"),
          ]),
          sudRelated: Type.Boolean(),
        }),
        { minItems: 1 },
      ),
      requestedAt: Iso,
    }),
    declaredConsumers: ["m7"],
    isOutboxOnly: true,
  },
  // F-237 — §7.4 W4 / D8: DocLens SUD detection → M5's interim `sud` privacy flag, and the reviewer's
  // confirm / false-positive round-trip. Ids only: a Part 2 indicator on a named patient is itself
  // protected, so no term, snippet or reason travels on the outbox (they stay encrypted on the batch).
  {
    eventName: M22_INTAKE_SUD_DETECTED_EVENT,
    moduleOwner: "m22",
    description:
      "The DocLens SUD detector (rules, plus the governed model pass when it may run) found 42 CFR Part 2 indicators in an intake batch. Emitted once per batch, in the transaction that completes extraction, independent of any reviewer decision (W4 step 3). M5 adds an interim, unconfirmed `sud` flag to the patient's privacy snapshot.",
    payloadSchema: Type.Object({
      intakeBatchId: Id,
      organizationId: Id,
      patientId: IdN,
      candidateCount: Type.Integer({ minimum: 0 }),
      suggestedSudKind: Type.Union([
        Type.Literal("medication"),
        Type.Literal("diagnosis"),
        Type.Literal("social_history"),
        Type.Literal("treatment_setting"),
      ]),
      pages: Type.Array(Type.Integer({ minimum: 1 })),
    }),
    declaredConsumers: ["m5"],
    isOutboxOnly: true,
  },
  {
    eventName: M22_INTAKE_SUD_CONFIRMED_EVENT,
    moduleOwner: "m22",
    description:
      "A licensed reviewer confirmed a DocLens SUD detection (W4 step 6). M5 marks the patient's interim `sud` flag confirmed; a §2.31 consent is still required before any disclosure.",
    payloadSchema: Type.Object({
      intakeBatchId: Id,
      organizationId: Id,
      patientId: IdN,
      resolvedByMembershipId: Id,
      resolvedAt: Iso,
    }),
    declaredConsumers: ["m5"],
    isOutboxOnly: true,
  },
  {
    eventName: M22_INTAKE_SUD_REJECTED_EVENT,
    moduleOwner: "m22",
    description:
      "A licensed reviewer rejected a DocLens SUD detection as a false positive (W4 step 6, e.g. methadone for pain). M5 retires the interim `sud` flag ONLY if DocLens put it there and no other live detection of the patient holds it (`patientRetainsFlag`); a consent-derived flag is untouched.",
    payloadSchema: Type.Object({
      intakeBatchId: Id,
      organizationId: Id,
      patientId: IdN,
      resolvedByMembershipId: Id,
      resolvedAt: Iso,
      patientRetainsFlag: Type.Optional(Type.Boolean()),
    }),
    declaredConsumers: ["m5"],
    isOutboxOnly: true,
  },
  {
    eventName: M22_INTAKE_SUD_RELINKED_EVENT,
    moduleOwner: "m22",
    description:
      "F-238 — a fax with a pending or confirmed DocLens SUD detection was moved to another patient (Move document), or adopted the patient its referral resolved to. M5 moves the DocLens-origin `sud` flag: the new patient gains it; the previous one loses it only if DocLens put it there and no other live detection of theirs holds it. Ids only.",
    payloadSchema: Type.Object({
      intakeBatchId: Id,
      organizationId: Id,
      fromPatientId: IdN,
      toPatientId: IdN,
      sudStatus: Type.Union([Type.Literal("detected"), Type.Literal("confirmed")]),
      fromPatientRetainsFlag: Type.Boolean(),
      movedByMembershipId: IdN,
    }),
    declaredConsumers: ["m5"],
    isOutboxOnly: true,
  },
  // F-238 — the medication-history (→ M12) and allergy (→ M5) commit requests (events-by-m22-clinical.ts).
  ...M22_CLINICAL_WRITEBACK_EVENTS,
];
