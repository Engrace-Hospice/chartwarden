// apps/backend/src/modules/22-documents/outbox-consumers/render-consumer.ts — GAP-023/024/038. The LIVE
// §4.11 render-handshake consumer: the half that was forward-declared in ./bindings.ts and never built.
//
// Before this file NOTHING drained a `*.document_requested` row. The pure decider (T06
// {@link decideDocumentRequest}), the two real seam gates (M39 consent / M40 BAA), the T04
// `DocumentRenderer`, and — since GAP-095 — a Drizzle document-row write store all existed and were
// individually tested; the dispatcher was simply never told about any of them. So M13's
// `finalize-reconciliation` (the ONE source module that genuinely emits) wrote an outbox row that sat
// `pending` forever, and the audit's "M22 is ready and waiting for this event" (GAP-023) was true only of
// a `const` array of strings. This binding closes the loop: normalize → resolve facts → decide → render.
//
// Why the normalizer exists: each source module owns its own payload wire shape (M11/M12 emit
// `{orderId, formTemplate, renderPayload}`, M13 `{worksheetId, …}`, M23's ABN a flat financial record) and
// M22 must not import any of them (deps stay `[1, 5]` — event STRINGS only, §4 boundary rule). The §4.11
// {@link DocumentRequestPayload} is M22's own canonical shape; {@link normalizeDocumentRequest} is the pure,
// per-event adapter into it. An event whose payload does not normalize THROWS — the dispatcher retries then
// dead-letters it (§7.2), which is the honest outcome for a malformed render request; it is never a silent
// no-op that would leave a signed clinical artifact permanently un-rendered with a green outbox.
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { getDocumentRenderer } from "../seams";
import { PLATFORM_TEMPLATE_TABLE, type TemplateDescriptor } from "../seams/renderer";
import type { DocumentSeamStore } from "../seams/store";
import { resolveExternalBaaActive } from "./baa-gate";
import { M22_DOCUMENT_RENDER_CONSUMER } from "./bindings";
import { resolveSudConsentPresent } from "./consent-gate";
import {
  type DocumentRequestEvent,
  type DocumentRequestFacts,
  type DocumentRequestPayload,
  M22_DOCUMENT_REQUEST_EVENTS,
  decideDocumentRequest,
} from "./decide-document-request";

// ── The per-event payload adapter (pure) ────────────────────────────────────────────────────────────────

/** How one source module's wire payload maps onto M22's canonical {@link DocumentRequestPayload}. Kept as
 * DATA (not a switch) so adding a source module is one row, and so the whole mapping is assertable. */
interface RequestShape {
  /** Payload field(s) holding the source aggregate id — the first present, non-empty string wins. Empty
   *  when the identity is only on the ENVELOPE (see {@link aggregateIdFromEvent}). */
  readonly aggregateIdFields: readonly string[];
  /** Take the aggregate id from the outbox row's own `aggregate_id` rather than the payload. M21 needs
   *  this: its return-receipt request carries `dispatchId` in the body but the RETURN row's id on the
   *  envelope, so the body would back-ref the wrong artifact. */
  readonly aggregateIdFromEvent?: boolean;
  /** The M22 template key, when the source module's own form-template name is NOT one (M13 asks for
   *  `reconciliation_worksheet_v1`; M22's published key is `medication_reconciliation_worksheet`). */
  readonly templateKey?: string;
  /** Payload field holding the source's own template name, used when {@link templateKey} is absent. */
  readonly templateKeyField?: string;
  /** One event carrying SEVERAL artifacts, discriminated by a payload field: `{field, map}` resolves the
   *  M22 template key from the discriminator's value. A value absent from the map is a malformed request
   *  (a throw), never a guess — rendering the wrong document under a real patient's chart is worse than
   *  a dead letter. */
  readonly templateKeyByField?: {
    readonly field: string;
    readonly map: Readonly<Record<string, string>>;
  };
  /** Payload field holding the render content blob (passed through to the byte renderer). */
  readonly contentField?: string;
  /**
   * F-168 (#248) — true for the rare event that is meant to fire MORE THAN ONCE against the same
   * aggregate, each time producing a genuinely NEW `document_version` (an addendum, an amendment, a
   * transmission confirmation). Default (unset/false): the event is GENESIS-only — this source
   * transition fires exactly once per real-world occurrence, so `alreadyRendered` stays keyed on
   * `(aggregateType, aggregateId)` (`renderedDocumentForAggregate`), exactly the pre-F-168 behaviour.
   * That is NOT merely the safer default, it is the semantically correct one for these events: an order
   * is signed once, so `m11.order.document_requested` firing TWICE for the same order (a producer-side
   * duplicate emission, a double-submitted request — never a real second signature) must still resolve
   * to exactly ONE `order_record` document, proven by `gap-023-024-038-render-handshake.live.test.ts`'s
   * own D14 "re-delivering the same request renders nothing new" cases, which key on a FRESH outbox row
   * with identical content rather than a redelivery of the same row id — the aggregate-level dedup is
   * what makes that scenario safe, and per-event-id dedup alone would NOT catch it (a fresh row has a
   * fresh id). Setting `appends: true` keys `alreadyRendered` on `documentVersionForSourceEvent`
   * instead (the specific delivered outbox event id) — correct ONLY for an event whose real-world
   * source transition can legitimately recur against the same aggregate.
   */
  readonly appends?: boolean;
}

/** The §4.11 wire shapes, one per LIVE consumed event (see {@link M22_DOCUMENT_REQUEST_EVENTS}). */
const REQUEST_SHAPES: Readonly<Record<DocumentRequestEvent, RequestShape>> = {
  // M11 §4.4 — "mirror of `m11.order.signed`". `formTemplate` IS the M22 key (`order_record`).
  "m11.order.document_requested": {
    aggregateIdFields: ["orderId"],
    templateKeyField: "formTemplate",
    contentField: "renderPayload",
  },
  // M12 §4.4 — same shape as M11; `formTemplate` is `medication_order`.
  "m12.medication_order.document_requested": {
    aggregateIdFields: ["orderId"],
    templateKeyField: "formTemplate",
    contentField: "renderPayload",
  },
  // M13 — the one source module that already emitted before this consumer existed. Its `formTemplate`
  // (`reconciliation_worksheet_v1`) is M13's OWN form name, not an M22 published key, so the key is fixed
  // here rather than read off the payload.
  "m13.reconciliation.document_requested": {
    aggregateIdFields: ["worksheetId"],
    templateKey: "medication_reconciliation_worksheet",
    contentField: "renderPayload",
  },
  // M21 §4.5.2 — ONE event, TWO artifacts, discriminated by `documentKind`. M21 has been emitting this
  // from both write paths since it landed with nothing consuming it. The aggregate identity is on the
  // ENVELOPE, not the body: `prepareDispatch` publishes with aggregate `comfort_kit_dispatch`/dispatch.id
  // and the return path with `comfort_kit_return`/return.id, while BOTH bodies carry `dispatchId` — so
  // reading the body would file the return receipt against the dispatch.
  "m21.supply_request.document_requested": {
    aggregateIdFields: [],
    aggregateIdFromEvent: true,
    templateKeyByField: {
      field: "documentKind",
      map: {
        bill_of_lading: "supply_bill_of_lading",
        return_receipt: "comfort_kit_return_receipt",
      },
    },
  },
  // M23 §4.10 (GAP-038) — the CMS-R-131 ABN. A flat financial record, no `formTemplate` field at all: the
  // event name itself names the artifact, so the template key is fixed and the whole payload is content.
  "m23.abn.required": {
    aggregateIdFields: ["abnId"],
    templateKey: "abn",
  },
  // M33 §1.1 (GAP-051) — ONE wire name, TWO producers: the `report.scheduled_run` cron path
  // (`report_schedule_run`, aggregate = the run) and the ad-hoc "export now" route (`report_export`,
  // aggregate = the export). They are two different `document_aggregate_type`s, so the payload's own
  // `aggregateType` picks the template. The identity is taken from the ENVELOPE for the same reason M21's
  // is: both producers set the outbox row's aggregate correctly, and only the ad-hoc payload happens to
  // repeat it in the body. No `contentField` — the WHOLE payload is the report (columns + rows + the
  // format + the snapshot query's provenance), which is exactly what the renderer should receive.
  "m33.scheduled_report.render_requested": {
    aggregateIdFields: [],
    aggregateIdFromEvent: true,
    templateKeyByField: {
      field: "aggregateType",
      map: {
        report_export: "report_export",
        report_schedule_run: "scheduled_report",
      },
    },
  },
  // ── F-099 — the six request-spelled events that were emitted and drained by nothing ───────────────────
  // M10 §2.4 — `POST /hope/assessments/:id/summary-pdf`. One artifact, so the key is fixed; no
  // `contentField`, because the whole payload (the assessment id + who asked) is what the summary renders
  // from. `patientId` rides the payload as of F-099 — see the note at the head of the file about why the
  // chart target has to be on the wire rather than resolved here.
  "m10.hope.summary_requested": {
    aggregateIdFields: ["assessmentId"],
    templateKey: "hope_summary",
  },
  // M16 D14 — the payload names its own template key (`bereavement_welcome_packet`), the M11/M12
  // `formTemplate` shape. The aggregate is the PLAN, not the contact: one welcome packet per plan, and
  // filing it against `contactId` would make a second contact's packet a fresh render of a document the
  // family already has. `outreachId` is legitimately null at plan-open and is not an identity here.
  "m16.bereavement.outreach_artifact_requested": {
    aggregateIdFields: ["planId"],
    templateKeyField: "templateKey",
    contentField: "payloadJsonb",
  },
  // M20 §4.10 — "M22's renderer consumes it; M20 ships no PDF code". `renderTargetKind` is a literal
  // `"pdf"`, so it discriminates nothing and the key is fixed.
  "m20.safety.incident_report_requested": {
    aggregateIdFields: ["incidentId"],
    templateKey: "safety_incident_report",
  },
  // M25 — the tier-specific appeal letter. `tier` selects the letter's CONTENT, not a different artifact
  // (an ALJ appeal is the same document class as a redetermination), so it stays in the content blob
  // rather than becoming a template discriminator.
  "m25.appeal_packet.render_requested": {
    aggregateIdFields: ["appealCaseId"],
    templateKey: "appeal_packet",
    contentField: "payload",
  },
  // M27 §4.10 — ONE wire name, THREE artifacts, discriminated by `artifactKind`. The aggregate is the
  // SUBMISSION (`submissionId`), not the cost report: a reopened report submits again, and filing both
  // against `costReportId` would make the second render an idempotent skip of the first.
  "m27.artifact.render_requested": {
    aggregateIdFields: ["submissionId"],
    templateKeyByField: {
      field: "artifactKind",
      map: {
        ecr: "cost_report_ecr",
        pi: "cost_report_pi",
        supporting_doc: "cost_report_supporting_doc",
      },
    },
  },
  // M37 §2.11 — emitted by the body-release machine on `identifyFuneralHome`.
  // `ipu_body_release.release_document_id` is the column waiting for it, and its schema comment names this
  // template. The identity is on the BODY (`bodyReleaseId`), which the service publishes as the envelope
  // aggregate too — the body is used because it is the field the catalog pins.
  "m37.body_release.document_requested": {
    aggregateIdFields: ["bodyReleaseId"],
    templateKey: "body_release_authorization",
  },
  // ── F-100 — M6's six CoP compliance documents ────────────────────────────────────────────────────────
  // The event NAME is the template, the way `m23.abn.required`'s is: M6 emits no `*.document_requested`,
  // and the M22 spec's consumer table routes these six source events here one template each. No
  // `contentField` on any of them — the whole payload is what the form renders from, and each carries
  // exactly the identifiers its template needs.
  "m6.election.signed": {
    aggregateIdFields: ["electionStatementId"],
    templateKey: "election_statement",
  },
  "m6.cti.signed": { aggregateIdFields: ["ctiId"], templateKey: "cti" },
  "m6.f2f.attested": { aggregateIdFields: ["f2fId"], templateKey: "f2f" },
  "m6.nor.acknowledged": {
    // The outbox ENVELOPE for this one is the ADMISSION (the transition runs on the admission row), so
    // the identity must come from the body — reading the envelope would file every tenant's NOR against
    // an admission id and collide with anything else that renders under an admission.
    aggregateIdFields: ["norAcknowledgmentId"],
    templateKey: "nor",
  },
  "m6.revocation.created": {
    aggregateIdFields: ["revocationEventId"],
    templateKey: "revocation",
  },
  "m6.discharge.created": {
    aggregateIdFields: ["dischargeEventId"],
    templateKey: "discharge_summary",
  },
  // F-176 (#248) — M22 spec §4.11/§7.17: a for-cause cosign renders a NEW VERSION of the discharge summary. Fires on
  // the SAME `discharge_event` id `.created` rendered, so it appends (F-168's per-request idempotency key). If the
  // filing-time `.created` row is still undispatched, the cosign render becomes v1 and `.created` idempotent-skips
  // (benign). The M6 back-ref stamps `document_id` only while NULL, so v2 never overwrites the v1 link.
  "m6.discharge.cosigned": {
    aggregateIdFields: ["dischargeEventId"],
    templateKey: "discharge_summary",
    appends: true,
  },
  // FY2027 (CMS-1851-F) — the election statement addendum, one DOCUMENT per addendum VERSION (an update after a
  // plan-of-care change is a new `election_addendum` row and a new document). `furnished` is the genesis render
  // (the (c)(10) written copy); `acknowledged` appends a version carrying the signature, the refusal reason, or
  // the (d)(4) signature-not-required notation — the regulation wants that noted ON the addendum. The whole
  // 418.24(c) content rides `renderPayload`; the regulatory language is the template's own text.
  "m6.election_addendum.furnished": {
    aggregateIdFields: ["electionAddendumId"],
    templateKey: "election_addendum",
    contentField: "renderPayload",
  },
  "m6.election_addendum.acknowledged": {
    aggregateIdFields: ["electionAddendumId"],
    templateKey: "election_addendum",
    contentField: "renderPayload",
    appends: true,
  },
  // ── F-144 (#248) — four render requests M22's own §4.11 sweep found catalogued, spec-named, and never
  // emitted (the producer-side gap, not a declaration gap). All emit `patientId` inside the content blob
  // (the M11/M12/M16 shape), never on the envelope.
  //
  // M13 — `formTemplate` is M13's OWN form name (`administration_record_v1`), the `m13.reconciliation
  // .document_requested` shape one row up: the M22 published key is fixed here, not read off the payload.
  "m13.administration_record.document_requested": {
    aggregateIdFields: ["administrationRecordId"],
    templateKey: "medication_administration_record",
    contentField: "renderPayload",
  },
  // M23 — ONE wire event, FOUR artifacts, discriminated by `kind` (the M27/M33 `templateKeyByField`
  // shape). `aggregateId` rides the payload body (the `document-render.ts` builders' own field name),
  // not the envelope: all four kinds share the ONE event name, so the envelope's own aggregate would be
  // whatever the LAST emit in the same transaction happened to carry.
  "m23.billing.document_render_requested": {
    aggregateIdFields: ["aggregateId"],
    templateKeyByField: {
      field: "kind",
      map: {
        noe_confirmation_receipt: "noe_confirmation_receipt",
        notr_confirmation_receipt: "notr_confirmation_receipt",
        claim_acknowledgment_letter: "claim_acknowledgment_letter",
        denial_appeal_cover_letter: "denial_appeal_cover_letter",
      },
    },
    contentField: "payload",
  },
  // M24 — the identical shape one module over. Only `claim_acknowledgment_letter` has a live producer
  // today (ACK_ACCEPTED, `jobs/submission-jobs.ts`); the other three kinds the M24 spec names have no
  // emit site, so they carry no map entry — a `kind` this map does not recognize is a malformed request
  // (retry-then-DLQ), never a guess.
  "m24.medicaid_billing.document_render_requested": {
    aggregateIdFields: ["aggregateId"],
    templateKeyByField: {
      field: "kind",
      map: { claim_acknowledgment_letter: "medicaid_claim_acknowledgment_letter" },
    },
    contentField: "payload",
  },
  // M25 — the manual (no-appeal) denial-resolution letter. One artifact, so the key is fixed; the
  // aggregate is the `denial_case`, matching `denial_case.claim_id`'s own nullability (a denial may
  // resolve with no claim yet attached — `patientId` in the content blob is honestly null then, F-099).
  "m25.denial_resolution_letter.render_requested": {
    aggregateIdFields: ["denialCaseId"],
    templateKey: "denial_resolution_letter",
    contentField: "payload",
  },
  // ── F-161 (#248) — two of M22's own `handlers-unbound` group's seven "decisively named" SOURCE
  // events that turned out to be real, buildable renders. The other five in that same group of seven
  // were checked and are NOT document renders, despite the group's own reason text calling all seven
  // "genuine, no catalog change needed": `m14.minutes.amended` wants a RE-render of the SAME
  // `idg_minutes` aggregate `m14.minutes.signed` would first render — the identical "new VERSION, not a
  // new document" gap `m6.discharge.cosigned` is deliberately NOT bound for, two sections up ("the W2
  // append path has to be built before it can be bound"); `m21.supply_request.delivered`'s own catalog
  // text is "M22 opens the optional caregiver-signature flow off `evidenceDocumentId`" — D7's "optional
  // caregiver signature … via M22 form rendering" is an e-signature CAPTURE workflow, not a render from
  // typed payload, and no such capability (route, seam, or FormFill consumer) exists anywhere in
  // `22-documents/` to bind it to; and all three `m39.consent.{expired,recipient_added,recipient_removed}`
  // events are M39's own catalog naming a "signed-URL revoke" / "disclosure-subsetter cache invalidation"
  // that M22 has no state for — `consent-gate.ts`'s `resolveSudConsentPresent` (and the disclosure
  // subsetter it mirrors) resolves M39's `ConsentEvaluator` FRESH on every signed-URL mint, the identical
  // F-115/M28 seam-pull shape one module over, so there is no persistent access grant or cache to revoke
  // or invalidate — the consent-lifecycle events need no M22-side consumer at all.
  //
  // M17 §4.11 D15 — the 24h-out caregiver visit-confirmation reminder. One artifact per visit, so the
  // key is fixed; `patientId` rides the payload top level. GAP-052: M17's `scheduling.caregiver-reminder`
  // cron (`17-scheduling/reassignment-scan.ts` `emitDueCaregiverReminders`) is the producer.
  "m17.caregiver_reminder_due": {
    aggregateIdFields: ["visitId"],
    templateKey: "visit_confirmation",
  },
  // M7 §2.4 — the care-plan PDF, rendered on every quorum-met sign (initial and each IDG review). One
  // artifact per VERSION (`versionId`), never per plan — a superseding version is a new render, matching
  // `care_plan_version`'s own append-only versioning model.
  "m7.care_plan.version_signed": {
    aggregateIdFields: ["versionId"],
    templateKey: "care_plan",
  },
  // F-192 (#248) — M6 §2.3.6/§7.7 — the transfer summary. One artifact per `transferEventId`, GENESIS
  // only (a benefit period allows at most one transfer-out per period, R-XFR-01; a transfer-in mints a
  // brand-new `transfer_event` row on the new admission, never a re-render of the sending hospice's).
  // Fires from BOTH `transferOut` and `transferIn` under the SAME event name/template — the payload's own
  // `direction` field (widened onto the wire alongside `patientId`, at the two real emit sites) carries
  // which. No `contentField`: the whole payload — `direction`/`effectiveAt`/`otherHospiceCcn` — is what
  // the transfer summary renders, the F-100 M6-CoP-documents shape exactly (an admission id also rides
  // the payload but is not the render aggregate — the transfer event itself is).
  "m6.transfer.created": {
    aggregateIdFields: ["transferEventId"],
    templateKey: "discharge_summary_transfer",
  },
  // ── F-166 (#248) — five GENESIS-only source-event renders M22's own survey-then-build pass on the
  // `handlers-unbound` group found buildable (see decide-document-request.ts's own comment on each).
  //
  // M8 §2 — the signed encounter note. `documentRenderPayload` (`{final, addenda}`) has carried the
  // renderable content on the LOCKED payload since the event existed; `patientId` rides the top level.
  "m8.encounter.signed": {
    aggregateIdFields: ["encounterId"],
    templateKey: "encounter",
    contentField: "documentRenderPayload",
  },
  // M18 §4.11 D11 — the real (only-ever-emitted) EVV verification-PDF trigger; its declared
  // `verification_pdf_requested` sibling is vapor (no emit site anywhere in `18-evv/`). No `patientId`
  // on this payload — honestly null (see decide-document-request.ts's comment on this event).
  "m18.evv.aggregator_accepted": {
    aggregateIdFields: ["submissionId"],
    templateKey: "evv_verification",
  },
  // M14 — both request-shaped, `renderPayload: Type.Unknown()` (the M11/M12 shape): the M22 template
  // key is fixed per event, not read off the payload.
  // `appends: true`: the packet build is replace-in-place (D5 — one `idg_patient_packet` row per
  // (meeting, patient), rebuilt by the T-24h resume and the coordinator's on-demand build), so the SAME
  // `packetId` legitimately requests a render again with NEW content. Genesis-only idempotency answered
  // `idempotent_skip` for every rebuild, leaving the first PDF stale forever; the per-delivered-event key
  // renders each rebuild as a new VERSION of the same packet document (a redelivery still renders nothing).
  "m14.packet.render_requested": {
    aggregateIdFields: ["packetId"],
    templateKey: "idg_patient_packet",
    contentField: "renderPayload",
    appends: true,
  },
  "m14.minutes.signed": {
    aggregateIdFields: ["minutesId"],
    templateKey: "idg_minutes",
    contentField: "renderPayload",
  },
  // M15 §2.4/D12 — ONE event, FOUR artifacts, discriminated by `kind` (the M23/M27/M33
  // `templateKeyByField` shape). `versionId` is the aggregate — a genuinely new `discipline_care_plan_
  // version` row per signature, never a collision with a prior kind's render.
  "m15.plan.version_signed": {
    aggregateIdFields: ["versionId"],
    templateKeyByField: {
      field: "kind",
      map: {
        aide_poc: "aide_poc",
        msw_plan: "msw_plan",
        spiritual_plan: "spiritual_plan",
        volunteer_plan: "volunteer_plan",
      },
    },
    contentField: "snapshot",
  },
  // ── F-168 (#248) — the three §4.11 render requests that were genuinely blocked ONLY by the
  // idempotency-key-granularity gate (migration 0261 fixed it): each asks for a NEW VERSION of an
  // aggregate its own GENESIS sibling (above) already rendered, which the OLD `(aggregateType,
  // aggregateId)`-only check answered `idempotent_skip` for, silently, forever.
  //
  // M8 §2 — the addendum. Appends onto the SAME `encounterId` `.signed` genesis-rendered. Payload
  // widened at the source (`signAddendum`) to carry `documentRenderPayload`, the exact `.signed` shape.
  "m8.encounter.addendum_signed": {
    aggregateIdFields: ["encounterId"],
    templateKey: "encounter",
    contentField: "documentRenderPayload",
    appends: true,
  },
  // M14 §2.6 D10 — the minutes amendment. Appends onto the SAME `minutesId` `.signed` genesis-rendered.
  // Payload widened at the source (`submitAmendment`) to carry `renderPayload`, the exact `.signed`
  // shape (never the DENYLISTED `amendmentReason` plaintext — only its hash was ever on the wire).
  "m14.minutes.amended": {
    aggregateIdFields: ["minutesId"],
    templateKey: "idg_minutes",
    contentField: "renderPayload",
    appends: true,
  },
  // M14 spec §13 — a late discipline-note ADDENDUM on an adjourned meeting. A dedicated event (not a
  // re-use of `.amended`, which carries an approver/amendment id and an M33 seam consumer and would
  // mislabel an addendum as an amendment) that appends a new version of the SAME `minutesId` document,
  // carrying the frozen snapshots plus the live `disciplineAddenda` appendix.
  "m14.discipline_note.addendum_recorded": {
    aggregateIdFields: ["minutesId"],
    templateKey: "idg_minutes",
    contentField: "renderPayload",
    appends: true,
  },
  // M12 §4.4 — the transmit-to-pharmacy confirmation. Appends onto the SAME `orderId`
  // `.document_requested` genesis-rendered. NOTE (reported, not fixed): this event is CATALOGUED with
  // no producer anywhere in `12-dosespot/` — the `dosespot.transmit_newrx` worker its own catalog
  // description names does not exist in this codebase (no DoseSpot vendor credential is configured
  // anywhere either). The consumer binding is real and tested against the real catalogued payload
  // shape, the `m17.caregiver_reminder_due` (F-161) posture — nothing emits the event yet. No
  // `contentField`: the whole payload (the transmission facts) is what the appended version renders.
  "m12.medication_order.transmitted": {
    aggregateIdFields: ["orderId"],
    templateKey: "medication_order",
    appends: true,
  },
  // F-208 (#248) — M9's printable assessment summary. No per-request id on the payload
  // (`{patientId, asOfDate, scales, lang}`), so `patientId` is the aggregate — the first patientId-keyed
  // render this table binds. `appends: true`: every request (chart-open auto-refresh or the explicit
  // download/print action) renders a NEW version of the SAME per-patient document, never a fresh
  // aggregate per `asOfDate`. No `contentField`: the whole payload is what the summary renders from.
  "m9.assessment.summary_requested": {
    aggregateIdFields: ["patientId"],
    templateKey: "assessment_summary",
    appends: true,
  },
  // F-224 (#248) — M19's caregiver/attending triage-call summary. The aggregate is the CALL
  // (`triageCallId`), and `recipientKind` (added to the payload by this round — the catalogued payload had
  // none while `M19TriageSummaryRequestedPayload` required it) discriminates the TWO artifacts: a
  // value outside {caregiver, attending} is a malformed request (a throw), never a guess — rendering the
  // attending variant for a caregiver is a disclosure error. `appends: true`: every explicit re-request is a
  // NEW version of the same per-audience document (F-168), never an `idempotent_skip`.
  "m19.triage.summary_requested": {
    aggregateIdFields: ["triageCallId"],
    templateKeyByField: {
      field: "recipientKind",
      map: {
        caregiver: "triage_summary_caregiver",
        attending: "triage_summary_attending",
      },
    },
    appends: true,
  },
};

/** Raised when a delivered render request cannot be read into M22's canonical shape (unknown event name,
 * missing aggregate id, or a template key the payload never names). The dispatcher retries then
 * dead-letters — a malformed render request is evidence, never a silent skip. */
export class MalformedRenderRequestError extends Error {
  readonly code = "MALFORMED_RENDER_REQUEST";
  constructor(eventType: string, why: string) {
    super(`render request '${eventType}' is not renderable: ${why}`);
    this.name = "MalformedRenderRequestError";
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/**
 * Adapt one source module's delivered payload into M22's canonical §4.11 {@link DocumentRequestPayload}
 * (pure). `organizationId` comes from the OUTBOX ROW, never the payload body — the row is the RLS-scoped,
 * dispatcher-verified tenant anchor; a payload-carried org would be caller-asserted (M23's ABN payload does
 * carry one, and it is deliberately ignored here).
 *
 * @throws MalformedRenderRequestError when the event is not a known §4.11 request or the payload lacks the
 * aggregate identity / template key the render needs.
 */
export function normalizeDocumentRequest(delivered: {
  readonly eventType: string;
  readonly organizationId: string;
  /** The outbox row's own `aggregate_id` — the identity for shapes that carry it on the envelope. */
  readonly aggregateId?: string;
  readonly payload: unknown;
}): { event: DocumentRequestEvent; payload: DocumentRequestPayload } {
  const { eventType, organizationId, payload: rawPayload } = delivered;
  const shape = (REQUEST_SHAPES as Record<string, RequestShape | undefined>)[eventType];
  if (!shape) throw new MalformedRenderRequestError(eventType, "not a §4.11 render-request event");
  if (!rawPayload || typeof rawPayload !== "object") {
    throw new MalformedRenderRequestError(eventType, "payload is not an object");
  }
  const p = rawPayload as Record<string, unknown>;

  const aggregateId = shape.aggregateIdFromEvent
    ? str(delivered.aggregateId)
    : shape.aggregateIdFields.map((f) => str(p[f])).find((v) => v !== undefined);
  if (!aggregateId) {
    throw new MalformedRenderRequestError(
      eventType,
      shape.aggregateIdFromEvent
        ? "the outbox row carries no aggregate_id"
        : `payload names no aggregate id (looked at ${shape.aggregateIdFields.join(", ")})`,
    );
  }

  const byField = shape.templateKeyByField;
  const discriminator = byField ? str(p[byField.field]) : undefined;
  if (byField && discriminator !== undefined && byField.map[discriminator] === undefined) {
    throw new MalformedRenderRequestError(
      eventType,
      `${byField.field} '${discriminator}' maps to no M22 template`,
    );
  }
  const templateKey =
    shape.templateKey ??
    (discriminator !== undefined ? byField?.map[discriminator] : undefined) ??
    (shape.templateKeyField ? str(p[shape.templateKeyField]) : undefined);
  if (!templateKey) {
    throw new MalformedRenderRequestError(
      eventType,
      `payload names no template (expected '${shape.templateKeyField ?? byField?.field}')`,
    );
  }

  const rawContent = shape.contentField ? p[shape.contentField] : p;
  const content =
    rawContent && typeof rawContent === "object" ? (rawContent as Record<string, unknown>) : {};

  // The chart-target patient may live on the envelope (M21/M23 style) or inside the content blob (M11/M12
  // thread it through `renderPayload`, whose schema is `Type.Unknown()` — no catalog change needed).
  const patientId = str(p.patientId) ?? str(content.patientId) ?? null;

  return {
    event: eventType as DocumentRequestEvent,
    payload: {
      organizationId,
      templateKey,
      aggregateId,
      patientId,
      content,
      ...(p.isSudClass === true || content.isSudClass === true ? { isSudClass: true } : {}),
      ...(str(p.title) ? { title: str(p.title) as string } : {}),
    },
  };
}

// ── The live consumer ───────────────────────────────────────────────────────────────────────────────────

export interface DocumentRequestConsumerDeps {
  /** The document-ROW store — the idempotency fact (`renderedDocumentForAggregate`) comes from the real
   *  `document` table, not a separate dedup registry: the rendered row IS the durable record of the render,
   *  so a re-delivery after a crash between render and receipt still cannot double-render. */
  readonly store: DocumentSeamStore;
  /** Overridable for tests; production resolves M22's own registered `DocumentRenderer` seam lazily (the
   *  seam is registered at boot, before the dispatcher starts, but resolving per-call keeps a re-registered
   *  seam — every test boot does this — from being captured at construction time). */
  readonly renderer?: () => {
    render(
      scope: { orgId: string },
      templateKey: string,
      payload: unknown,
    ): Promise<{ documentId: string }>;
  };
  /** Structured sink for the three REFUSAL outcomes (unknown template / SUD consent absent / BAA inactive).
   *  A refusal is a decision with a reason, not an error: it must be visible without being a dead letter. */
  readonly onRefusal?: (refusal: {
    readonly eventType: string;
    readonly organizationId: string;
    readonly aggregateId: string;
    readonly kind: "unknown_template" | "sud_consent_absent" | "baa_inactive";
    readonly detail: string;
  }) => void;
  /** Template table override (tests); defaults to the T04 published table. */
  readonly templates?: Readonly<Record<string, TemplateDescriptor>>;
  /**
   * The §7.2 downstream half: emits `m22.document.rendered` so the requesting module can stamp its own
   * back-ref column. Optional — omitted, the render still happens and the document is still reachable
   * through `document.(aggregate_type, aggregate_id)`; the source row's column simply stays NULL.
   */
  readonly emitRendered?: (event: DocumentRenderedEmit) => Promise<void>;
}

/** The `m22.document.rendered` payload (see ../events-by-m22.ts) as the consumer hands it to the emitter. */
export interface DocumentRenderedEmit {
  readonly organizationId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly versionNumber: number;
  readonly isFirstVersion: boolean;
  readonly templateKey: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly retentionClass: string;
  readonly patientId: string | null;
  readonly sourceEvent: string;
  readonly sourceModule: string;
  readonly renderedAt: string;
}

/** `m11.order.document_requested` → `m11`. The producer is the event name's own namespace — M22 reads every
 *  source module through the event STRING, so the string is also where the requester's identity lives. */
function sourceModuleOf(eventName: string): string {
  return eventName.split(".")[0] ?? "";
}

/**
 * Build the LIVE §4.11 render-handshake consumer (GAP-023/024/038). One binding drains every consumed
 * `*.document_requested` queue: it normalizes the source payload, resolves {@link DocumentRequestFacts}
 * (idempotency from the `document` table, the template descriptor from the T04 table, and — only when the
 * payload flags them — the M39 consent and M40 BAA gates), calls the pure {@link decideDocumentRequest},
 * and executes the returned action through the T04 `DocumentRenderer`.
 *
 * `unknown_template` THROWS (retry-then-dead-letter per §7.2 — a template that has not been published yet
 * may be published in a minute, and the request must survive until it is). The two GATE refusals do NOT
 * throw: they are settled decisions — a SUD render with no consent must never be retried into existence —
 * so the row completes and the refusal goes to {@link DocumentRequestConsumerDeps.onRefusal}.
 */
export function buildM22DocumentRequestConsumer(
  deps: DocumentRequestConsumerDeps,
): OutboxConsumerBinding {
  const templates = deps.templates ?? PLATFORM_TEMPLATE_TABLE;
  const renderer = deps.renderer ?? getDocumentRenderer;

  return {
    consumerName: M22_DOCUMENT_RENDER_CONSUMER,
    consumerModule: "m22",
    eventTypes: [...M22_DOCUMENT_REQUEST_EVENTS],
    async handle(event: DispatchableOutboxEvent): Promise<void> {
      const { event: sourceEvent, payload } = normalizeDocumentRequest(event);
      // F-168 (#248) — two-tier idempotency, per event shape. Most events are GENESIS-only (their real
      // source transition fires exactly once per real-world occurrence — an order is signed once), so
      // `alreadyRendered` stays keyed on `(aggregateType, aggregateId)`: this is what makes a PRODUCER-
      // side duplicate emission (a fresh outbox row, same order, same content — never a real second
      // signature) still resolve to exactly one `order_record` document, the pre-F-168 behaviour
      // `gap-023-024-038-render-handshake.live.test.ts`'s own D14 cases prove and still require. Only the
      // events whose real source transition CAN legitimately recur against the same aggregate
      // (`RequestShape.appends`, e.g. `m8.encounter.addendum_signed`) use the finer per-request key
      // (`documentVersionForSourceEvent`, keyed on the specific delivered outbox event id) — see that
      // flag's own doc comment for why the two must not be conflated.
      const appends = REQUEST_SHAPES[sourceEvent]?.appends === true;

      const descriptor = templates[payload.templateKey];
      const prior = descriptor
        ? appends
          ? await deps.store.documentVersionForSourceEvent({
              sourceEventId: event.id,
              organizationId: payload.organizationId,
            })
          : await deps.store.renderedDocumentForAggregate({
              aggregateType: descriptor.aggregateType,
              aggregateId: payload.aggregateId,
              organizationId: payload.organizationId,
            })
        : null;

      const facts: DocumentRequestFacts = {
        alreadyRendered: prior !== null,
        templateKnown: descriptor !== undefined,
        aggregateType: descriptor?.aggregateType ?? null,
        retentionClass: descriptor?.retentionClass ?? null,
        // Both gates are resolved ONLY when the payload flags them (the decider reads them only then), so a
        // routine clinical render never pays for an M39/M40 seam call.
        ...(payload.isSudClass === true && payload.patientId
          ? {
              sudConsentPresent: await resolveSudConsentPresent({
                organizationId: payload.organizationId,
                patientId: payload.patientId,
              }),
            }
          : {}),
        ...(payload.externalRecipient
          ? {
              externalBaaActive: await resolveExternalBaaActive({
                organizationId: payload.organizationId,
                recipient: payload.externalRecipient,
              }),
            }
          : {}),
      };

      /** Emit the §7.2 downstream half for a document that now exists. Shared by the render path and the
       *  re-delivery path — see the `idempotent_skip` note below for why the latter must emit too. */
      const announce = async (row: {
        documentId: string;
        versionId: string;
        versionNumber: number;
        renderedAt: string;
      }): Promise<void> => {
        if (!deps.emitRendered || !descriptor) return;
        await deps.emitRendered({
          organizationId: payload.organizationId,
          documentId: row.documentId,
          documentVersionId: row.versionId,
          versionNumber: row.versionNumber,
          isFirstVersion: row.versionNumber === 1,
          templateKey: payload.templateKey,
          aggregateType: descriptor.aggregateType,
          aggregateId: payload.aggregateId,
          retentionClass: descriptor.retentionClass,
          patientId: payload.patientId ?? null,
          sourceEvent,
          sourceModule: sourceModuleOf(sourceEvent),
          renderedAt: row.renderedAt,
        });
      };

      const action = decideDocumentRequest(sourceEvent, payload, facts);
      switch (action.kind) {
        case "idempotent_skip":
          // D14 — a re-delivery never produces a second DOCUMENT. It must still ANNOUNCE one: the render
          // and the emit are two transactions (the renderer opens its own), so a crash between them is
          // exactly the case that gets redelivered, and returning here would make that the one path where
          // the back-ref is lost permanently — silently, and only under a crash. Consumers stamp the same
          // `document_id` they already hold, which is idempotent by construction.
          if (prior) await announce(prior);
          return;
        case "unknown_template":
          deps.onRefusal?.({
            eventType: event.eventType,
            organizationId: payload.organizationId,
            aggregateId: payload.aggregateId,
            kind: "unknown_template",
            detail: action.templateKey,
          });
          // Retry-then-DLQ (§7.2): the request outlives a not-yet-published template.
          throw new MalformedRenderRequestError(
            event.eventType,
            `no published M22 template for key '${action.templateKey}'`,
          );
        case "sud_consent_absent":
          deps.onRefusal?.({
            eventType: event.eventType,
            organizationId: payload.organizationId,
            aggregateId: payload.aggregateId,
            kind: "sud_consent_absent",
            detail: action.templateKey,
          });
          return; // §7.16 — settled refusal, never retried into a plaintext SUD render.
        case "baa_inactive":
          deps.onRefusal?.({
            eventType: event.eventType,
            organizationId: payload.organizationId,
            aggregateId: payload.aggregateId,
            kind: "baa_inactive",
            detail: action.mdmEntityId,
          });
          return; // §4.12 — settled refusal; no out-of-network disclosure without an active BAA.
        case "render": {
          const { render } = action;
          // The RESOLVED routing wins over the content blob, which is why it is spread first (F-100).
          // The other way round, a source module whose payload happens to carry an `aggregateId` or
          // `patientId` of its own silently overwrites the identity the normalizer just decided — and it
          // is not hypothetical: `runEffects` in M6 puts the TRANSITION's aggregate in the body, so every
          // NOR rendered under its ADMISSION's id and `notice_of_rights_acknowledgment.document_id` could
          // never be stamped. The document existed, addressed to the wrong row, which is the one failure
          // mode a back-ref cannot recover from.
          await renderer().render({ orgId: payload.organizationId }, render.templateKey, {
            ...render.content,
            aggregateId: render.aggregateId,
            patientId: render.patientId,
            ...(render.title ? { title: render.title } : {}),
            ...(render.sudRedacted ? { sudRedacted: true } : {}),
            // F-168 (#248) — carried straight through renderer.ts's `RenderPayloadCore.sourceEventId` into
            // `document_version.source_event_id`, so the crash-retry dedup and this write are ATOMIC (one
            // insert), not a separate receipt that could itself be lost between the two. Resolved fields
            // win over the content blob for the same F-100 reason as `aggregateId`/`patientId` above.
            sourceEventId: event.id,
          });
          // Re-read BY SOURCE EVENT rather than trusting the renderer's `{documentId}`: the leaf-typed
          // `DocumentRenderer` seam returns only that, and the back-ref event carries the version identity
          // too. Reading by `event.id` (not `renderedDocumentForAggregate`) is deliberate — it is the exact
          // row this call just wrote, never a DIFFERENT version that happened to be active if another
          // request for the same aggregate raced in between.
          if (deps.emitRendered && descriptor) {
            const written = await deps.store.documentVersionForSourceEvent({
              sourceEventId: event.id,
              organizationId: payload.organizationId,
            });
            if (written) await announce(written);
          }
          return;
        }
      }
    },
  };
}
