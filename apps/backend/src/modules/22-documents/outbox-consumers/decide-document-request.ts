// apps/backend/src/modules/22-documents/outbox-consumers/decide-document-request.ts — M22-T06 the §4.11
// outbox-subscription decision core. PHASE-1 PURE DECISION CORE (M6-T11 / M7-T08 precedent).
//
// M22 subscribes to the `*.document_requested` render-handshake events every source module emits when it
// wants a PDF materialized (§4.11 table): M6 (election/cti/f2f/nor/revocation/discharge), M9 (assessment
// record), M11 (order record), M12 (medication order), M13 (eMAR / reconciliation worksheet), M14 (IDG
// packet / minutes), M16 (bereavement / anniversary letters), and M23 (ABN, forward-seam). Each event
// names ONE template key + carries a typed payload; M22 resolves the template descriptor, plans a render
// (the T04 `DocumentRenderer` logic), and — once the bytes land — emits `m22.document.rendered` so the
// requesting module's own `m22-document-backref` consumer can apply `document_id` (the W2 §7.2 handshake's
// downstream half). This file ships the PURE, fully-tested {@link decideDocumentRequest}; the LIVE consumer
// that resolves the facts and executes the returned action through the T04 renderer is ./render-consumer.ts
// (GAP-023/024/038 — it was forward-declared and unbuilt until then). The `m22.document.rendered` emit that
// closes the downstream half still does not exist: M22 has no event catalog, so every source module's
// `m22-document-backref` consumer remains unfed and no `document_id` is stamped back onto the source row.
// The rendered document is still discoverable from the source aggregate — `document.(aggregate_type,
// aggregate_id)` IS the back-ref — so a render is useful without the stamp, but the stamp is not done.
//
// Why local types, no producer imports: M22 `dependsOn` is `[1, 5]` (§ manifest). M22 reads every source
// module SOLELY through the foundation outbox event STRING — never a `dependsOn` edge or a producer-package
// import. So the consumed event names are STRING literals and the consumed payload is a locally-declared
// structural minimum (the source module owns the canonical wire payload). This directory is NOT scanned by
// arch:gaps' event-catalog / seam-registry gates, so consuming `m6.*`/`m11.*`/… here adds no M22-produced
// event and no edge. Idempotency follows the M6-T11 D14 rail: a prior `m22.document.rendered` for the same
// `(sourceEvent, aggregateId)` → `idempotent_skip` (re-delivery never double-renders).
import type { DocumentAggregateType, DocumentRetentionClass } from "@wardenx/types";

// ── The §4.11 `*.document_requested` events M22 renders (string literals — no producer import) ──────────

/** The source-module render-request event names M22 LIVE-subscribes to (§4.11) — every one of which some
 * module's event catalog actually declares, so a row can genuinely arrive. One template per event.
 *
 * GAP-023/024/038 rewrote this list. It previously held eight names, five of which
 * (`m6.document_requested`, `m9.assessment.document_requested`, `m14.packet.document_requested`,
 * `m16.bereavement.document_requested`, `m23.abn.document_requested`) are declared by NO module's event
 * catalog — see {@link M22_ANTICIPATED_DOCUMENT_REQUEST_EVENTS}. The boot dispatcher routes off the catalog,
 * so those names could never be delivered: subscribing to them read as coverage while covering nothing, and
 * it is what made the M23 ABN mismatch (M23 declares `m23.abn.required`) invisible for a whole audit cycle. */
export const M22_DOCUMENT_REQUEST_EVENTS = [
  "m11.order.document_requested", // order_record (M11 §4.4, mirror of m11.order.signed)
  "m12.medication_order.document_requested", // medication_order (M12 §4.4, mirror of signed)
  "m13.reconciliation.document_requested", // medication_reconciliation_worksheet
  "m21.supply_request.document_requested", // supply_bill_of_lading | comfort_kit_return_receipt
  "m23.abn.required", // abn — CMS-R-131 (GAP-038: M23's declared name, not `m23.abn.document_requested`)
  // GAP-051 — M33's PDF/XLSX render handshake. Its name says `scheduled_report`, but ONE wire name serves
  // BOTH producers (the cron path and the ad-hoc "export now" route), discriminated by `aggregateType`.
  // M33 has declared `declaredConsumers: ["m22"]` on it since it landed; with nothing bound, every render
  // request — including the scheduled path, which genuinely emits — sat `pending` forever.
  "m33.scheduled_report.render_requested", // report_export | scheduled_report
  // ── F-099 — six requests that were LIVE-emitted from production write paths and consumed by nothing.
  // Every one of them is the REQUEST spelling, which is what makes this different from the ~70 SOURCE
  // clinical events that also declare `m22`: those are the handshake spelled a second way and the request
  // half is wired; these ARE the request half, and nothing drained them. Each emit site's own comment says
  // M22 renders it, and M37's back-ref column names the template.
  "m10.hope.summary_requested", // hope_summary
  "m16.bereavement.outreach_artifact_requested", // bereavement_welcome_packet (payload names the key)
  "m20.safety.incident_report_requested", // safety_incident_report
  "m25.appeal_packet.render_requested", // appeal_packet
  "m27.artifact.render_requested", // cost_report_ecr | cost_report_pi | cost_report_supporting_doc
  "m37.body_release.document_requested", // body_release_authorization
  // ── F-100 — M6's six CoP compliance documents. Unlike every other source module, M6 emits NO
  // `*.document_requested`: the M22 spec's own consumer table routes the SOURCE events here, one template
  // each, and M6's catalog has declared `m22` on exactly these six since it landed. All six templates have
  // been published in PLATFORM_TEMPLATE_TABLE the whole time, and seven `document_id` columns on the M6
  // tables — each commented "M22 document" — were waiting for the back-ref. Nothing consumed any of them.
  "m6.election.signed", // election_statement
  "m6.cti.signed", // cti
  "m6.f2f.attested", // f2f
  "m6.nor.acknowledged", // nor
  "m6.revocation.created", // revocation
  "m6.discharge.created", // discharge_summary
  // ── F-144 (#248) — four render requests M22's own §4.11 sweep confirmed were catalogued, named by
  // their producing module's own document-request table, and STILL never emitted (the producer-side
  // half of the gap, distinct from every event above this line, which was a catalog-declaration
  // problem). Each is now genuinely emitted, in the SAME transaction as the fact it announces:
  // `m13.administration_record.document_requested` — the pure `@wardenx/emar` machine has declared this
  // as a `commit`-time effect on `perAdministrationPdfRequired` since M13-T03; the DB write service
  // never read the effect list (it reimplements `commit` inline rather than calling
  // `transitionAdministration`) and now checks the same tenant policy flag directly.
  // `m23.billing.document_render_requested` — M23's own §4.10 table names this as the SOLE M22
  // handshake for all four of its document kinds; co-emitted at NOE/NOTR `submit` and at claim
  // `ack_277ca_accepted`/`ack_277ca_rejected`/`ack_999_rejected` (`services/claim-state-service.ts` +
  // `services/noe-notr-state-service.ts`).
  // `m24.medicaid_billing.document_render_requested` — the identical shape one module over; co-emitted
  // at the Medicaid claim's `ACK_ACCEPTED` transition (`jobs/submission-jobs.ts`), the one trigger
  // M24's own transition table names as document-relevant today (R&B activation / remittance posting
  // are real, still-unbuilt M24 triggers for the OTHER three kinds the spec names — not built here).
  // `m25.denial_resolution_letter.render_requested` — co-emitted at `resolveDenial` (the manual,
  // no-appeal resolution transition; `routes/write-service-drizzle.ts`).
  "m13.administration_record.document_requested", // medication_administration_record
  "m23.billing.document_render_requested", // noe_confirmation_receipt | notr_confirmation_receipt | claim_acknowledgment_letter | denial_appeal_cover_letter
  "m24.medicaid_billing.document_render_requested", // medicaid_claim_acknowledgment_letter
  "m25.denial_resolution_letter.render_requested", // denial_resolution_letter
  // ── F-161 (#248) — two of M22's own `handlers-unbound` group's seven "decisively named by the
  // producing module's own outbox table" events that checked out as genuine, buildable SOURCE-event
  // renders, the F-100 M6-CoP-documents shape (no separate `*.document_requested` event — the event
  // NAME is the template, per the source module's own catalog comment). The other five in that group of
  // seven were checked and found NOT to be document renders at all — see render-consumer.ts's
  // REQUEST_SHAPES comment above `"m17.caregiver_reminder_due"` and `"m7.care_plan.version_signed"` for
  // why each of those five stays unconsumed.
  "m17.caregiver_reminder_due", // visit_confirmation — M17's own catalog: "M22 renders the reminder"
  "m7.care_plan.version_signed", // care_plan — M7's own catalog: "drives … M22 PDF"
  // ── F-166 (#248) — M22's own `handlers-unbound` group's survey-then-build pass: five SOURCE-event
  // GENESIS renders (a first document per aggregate, never a re-render of one that already exists —
  // the exact distinction that keeps `m6.discharge.cosigned`/`m8.encounter.addendum_signed`/
  // `m14.minutes.amended`/`m12.medication_order.{transmitted,list_changed}` NOT here: each of those
  // asks for a SECOND document against an aggregate id M22 has already rendered, which
  // `decideDocumentRequest`'s idempotency (keyed `(aggregateType, aggregateId)` only, never
  // `(sourceEvent, aggregateId)`) answers `idempotent_skip` for, silently, forever).
  //
  // M8 §2 — the signed encounter note. `documentRenderPayload: {final, addenda}` has been ON THE LOCKED
  // PAYLOAD since the event existed — the content M22 renders was always in hand, unconsumed.
  // `aggregateType: "encounter"` has published a descriptor since the platform-floor template table;
  // nothing else renders under it, so this is the aggregate's FIRST document, not a collision with
  // `.addendum_signed`'s later append (which correctly stays unbound, two paragraphs up).
  "m8.encounter.signed", // encounter
  // M18 §4.11 D11 — the EVV verification PDF. `m18.evv.verification_pdf_requested` is the request-
  // shaped SIBLING this event's own description claims to duplicate ("triggers the M22
  // verification-PDF render (D11)") — checked and confirmed VAPOR: no emit site anywhere in
  // `18-evv/` (only `aggregator_accepted`'s pure decider ever actually publishes), so `aggregator_accepted`
  // is the real trigger, the F-100 "event NAME is the template" shape M6's six CoP documents already use.
  // `evv_verification` has published a descriptor since the platform-floor table with no producer wired
  // to it until now. `patientId` is honestly left unresolved (null): the payload carries only
  // `{submissionId, visitId, stateCode, aggregatorTransactionId, acceptedAt}`, no patient anywhere, and
  // resolving one would need a NEW M18/M17 visit→patient cross-module read out of this pass's scope —
  // reported, not guessed (`retentionClass: "operational"`, so the artifact is still reachable via
  // `document.(aggregate_type, aggregate_id)` without a chart link, same posture `m21.*` operational
  // artifacts already carry).
  "m18.evv.aggregator_accepted", // evv_verification
  // M14 §2.4/§4.4 — the two IDG render requests the group's own F-162 finding traced precisely:
  // `idg_patient_packet`/`idg_minutes` have been real `document_aggregate_type` enum values since the
  // platform-floor table (migration 0048) with NO published TemplateDescriptor and NO catalog
  // subscription — "even a first-ever render would hit `unknown_template` today" (F-162). Both are
  // GENESIS-only requests (one packet per `packetId`, one minutes doc per `minutesId`) — never the
  // `.amended` re-render, which stays correctly unbound above for the granularity reason.
  "m14.packet.render_requested", // idg_patient_packet
  "m14.minutes.signed", // idg_minutes — patientId is honestly null: minutes cover the whole IDG meeting,
  // not one patient (the payload carries none), matching `DocumentRequestPayload.patientId`'s documented
  // "or null for patient-independent renders" case.
  "m15.plan.version_signed", // aide_poc | msw_plan | spiritual_plan | volunteer_plan, by `kind`
] as const;

/** §4.11 render-request events the SPEC anticipates but no module's event catalog declares yet. Listed —
 * not subscribed — deliberately: a consumer bound to a name nothing can emit is indistinguishable from
 * working, whereas an undelivered row on a catalog-declared event sits visibly `pending` in the outbox.
 * Moving a name up into {@link M22_DOCUMENT_REQUEST_EVENTS} means: the producer declares AND emits it,
 * `REQUEST_SHAPES` in ./render-consumer.ts gains its payload adapter, and M22 publishes a template
 * descriptor for every artifact it can ask for (M21's move needed mig 0196 for the two aggregate types).
 *
 * Every name here is declared by no catalog under any spelling, EXCEPT where noted. This list used to
 * carry `m37.body_release.document_requested` as "declared but has no emitter and no published template" —
 * it is catalogued, M37's body-release machine emits it on `identifyFuneralHome`, and
 * `ipu_body_release.release_document_id` was built to hold the result. It is now consumed (F-099), and the
 * mistaken note is why it sat unconsumed: a wrong entry on a deferral list is indistinguishable from a
 * correct one, and reads as a decision rather than an oversight. */
export const M22_ANTICIPATED_DOCUMENT_REQUEST_EVENTS = [
  // `m6.document_requested` used to head this list. It is gone rather than promoted: it never existed in
  // any catalog, and M6 does not need it — the M22 spec routes M6's SOURCE events straight here (§4.11's
  // "the form template differs but the boundary protocol is one"), which is the shape `m23.abn.required`
  // already uses. Inventing a seventh spelling would have been a new event on the platform's busiest
  // clinical module to say what six existing events already say.
  "m9.assessment.document_requested", // assessment record PDF
  // `m13.administration_record.document_requested` used to sit here (GAP-025: catalogued and not
  // emitted, the effect-interpreter gap). It is now consumed (F-144, #248) — the DB write service reads
  // the tenant PDF-policy flag and emits it at `commit`, the fix the old note here anticipated.
  "m14.packet.document_requested", // idg_patient_packet / idg_minutes
  "m16.bereavement.document_requested", // bereavement_letter (letterKind discriminator)
] as const;

/** One of the §4.11 render-request event names M22 consumes. */
export type DocumentRequestEvent = (typeof M22_DOCUMENT_REQUEST_EVENTS)[number];

/** The §4.11 render-request payload, as the source module hands it on the outbox (structural minimum). The
 * source module owns the canonical superset; M22 reads only the fields it needs to resolve the template +
 * shape the row + the back-ref. `templateKey` selects the descriptor; `aggregateId` is the source artifact
 * the rendered document back-refs (the value M22 returns in `m22.document.rendered`). */
export interface DocumentRequestPayload {
  readonly organizationId: string;
  /** The published template key the source module is requesting (`cti`, `order_record`, `bereavement_letter`, …). */
  readonly templateKey: string;
  /** The source artifact id the rendered document materializes (back-ref target). */
  readonly aggregateId: string;
  /** The chart-target patient, or null for patient-independent renders (intake / batch). */
  readonly patientId?: string | null;
  /** The template content payload, passed straight to the byte renderer (template-specific). */
  readonly content?: Record<string, unknown>;
  /** True when the requested template is a 42 CFR Part 2 / SUD-class artifact (gates on M39 consent). */
  readonly isSudClass?: boolean;
  /** Present only on out-of-network disclosure paths — the M40 partner entity the render targets. */
  readonly externalRecipient?: ExternalRecipientRef;
  /** Optional override title for the rendered document. */
  readonly title?: string;
}

/** An out-of-network disclosure recipient (§4.12) — gated by the M40 `BaaStatusProvider` before presign. */
export interface ExternalRecipientRef {
  readonly kind: "facility" | "payer" | "referral_source" | "dme_vendor" | "funeral_home";
  readonly mdmEntityId: string;
}

// ── The facts the live consumer resolves before deciding (kept as data so the decider stays pure) ───────

/** Everything the §4.11 consumer reads before it can decide a render, surfaced as data so
 * {@link decideDocumentRequest} stays pure. The Wave-F/live consumer resolves these from the outbox-dedup
 * registry (idempotency), the T04 template table (`templateKnown`/`aggregateType`/`retentionClass`), the
 * M39 `ConsentEvaluator` seam (`sudConsentPresent`), and the M40 `BaaStatusProvider` seam (`externalBaaActive`). */
export interface DocumentRequestFacts {
  /** A prior `m22.document.rendered` already back-refs this `(sourceEvent, aggregateId)` (idempotency, D14). */
  readonly alreadyRendered: boolean;
  /** The requested `templateKey` resolves to a published template descriptor (T04 lookup). */
  readonly templateKnown: boolean;
  /** The `document.aggregate_type` the resolved template produces (from the T04 descriptor). */
  readonly aggregateType: DocumentAggregateType | null;
  /** The INSERT-time retention class the resolved template carries (D23; never updated). */
  readonly retentionClass: DocumentRetentionClass | null;
  /** For a SUD-class request: the M39 `ConsentEvaluator` returned an active `42_cfr_part_2_release` consent.
   * Resolved ONLY when `payload.isSudClass` (the consumer skips the seam call otherwise). */
  readonly sudConsentPresent?: boolean;
  /** For an external-disclosure request: the M40 `BaaStatusProvider` BAA gate is active as-of now (§4.12).
   * Resolved ONLY when `payload.externalRecipient` is present. */
  readonly externalBaaActive?: boolean;
}

// ── The action the decider returns (executed by the live consumer) ──────────────────────────────────────

/** A planned render — the live consumer calls the T04 `DocumentRenderer.render(scope, templateKey, payload)`
 * with exactly these args, then emits `m22.document.rendered` carrying the {@link DocumentBackRef}. */
export interface PlannedRender {
  readonly templateKey: string;
  readonly aggregateType: DocumentAggregateType;
  readonly retentionClass: DocumentRetentionClass;
  readonly aggregateId: string;
  readonly patientId: string | null;
  readonly title?: string;
  readonly content: Record<string, unknown>;
  /** True when the render payload was SUD-redacted at the gate (D20-style metadata flag on the document). */
  readonly sudRedacted: boolean;
}

/** The back-ref M22 emits on `m22.document.rendered` so the requesting module can apply `document_id`. The
 * live consumer fills `documentId` from the renderer return; the decider fixes the routing fields. */
export interface DocumentBackRef {
  readonly sourceEvent: DocumentRequestEvent;
  readonly aggregateType: DocumentAggregateType;
  readonly aggregateId: string;
  readonly retentionClass: DocumentRetentionClass;
}

/** The single effect the §4.11 decider resolves for one delivered `*.document_requested` event. */
export type DocumentRequestAction =
  /** A re-delivery of an already-rendered request — skip, no duplicate document (idempotency, D14). */
  | { readonly kind: "idempotent_skip" }
  /** The requested template key has no published descriptor — the worker retries-then-dead-letters (§7.2);
   * NO `document` row is created (matches T04 `UnknownTemplateError`). */
  | { readonly kind: "unknown_template"; readonly templateKey: string }
  /** A SUD-class render with no active M39 consent (§4.11 / §7.16) — refuse; do NOT render plaintext SUD. */
  | { readonly kind: "sud_consent_absent"; readonly templateKey: string }
  /** An external-disclosure render whose M40 BAA gate is not active (§4.12) — block; no presigned URL. */
  | { readonly kind: "baa_inactive"; readonly mdmEntityId: string }
  /** The happy path — render the template + emit `m22.document.rendered` with the back-ref. */
  | { readonly kind: "render"; readonly render: PlannedRender; readonly backRef: DocumentBackRef };

// ── The pure decision core (§4.11 / §4.12) ──────────────────────────────────────────────────────────────

/**
 * Decide the single effect to apply for one delivered `*.document_requested` event (§4.11, pure). The live
 * consumer resolves {@link DocumentRequestFacts} from the outbox-dedup registry + the T04 template table +
 * (when needed) the M39 `ConsentEvaluator` and M40 `BaaStatusProvider` seams, then this returns the
 * {@link DocumentRequestAction} to execute. Gate order mirrors the spec: idempotency → template-known →
 * §7.16 SUD-consent gate → §4.12 external-BAA gate → render.
 */
export function decideDocumentRequest(
  sourceEvent: DocumentRequestEvent,
  payload: DocumentRequestPayload,
  facts: DocumentRequestFacts,
): DocumentRequestAction {
  // 1. Idempotency (D14): a re-delivery never produces a second document for the same source artifact.
  if (facts.alreadyRendered) return { kind: "idempotent_skip" };

  // 2. Template resolution (§7.2): an unknown key is retried-then-dead-lettered; no document row is created.
  if (!facts.templateKnown || facts.aggregateType === null || facts.retentionClass === null) {
    return { kind: "unknown_template", templateKey: payload.templateKey };
  }

  // 3. §7.16 SUD-consent gate: a SUD-class artifact never renders plaintext SUD without an active M39 consent.
  if (payload.isSudClass === true && facts.sudConsentPresent !== true) {
    return { kind: "sud_consent_absent", templateKey: payload.templateKey };
  }

  // 4. §4.12 external-disclosure gate: an out-of-network render is blocked unless the M40 BAA gate is active.
  if (payload.externalRecipient && facts.externalBaaActive !== true) {
    return { kind: "baa_inactive", mdmEntityId: payload.externalRecipient.mdmEntityId };
  }

  // 5. Happy path — plan the render + the back-ref the requesting module links on.
  const render: PlannedRender = {
    templateKey: payload.templateKey,
    aggregateType: facts.aggregateType,
    retentionClass: facts.retentionClass,
    aggregateId: payload.aggregateId,
    patientId: payload.patientId ?? null,
    title: payload.title,
    content: payload.content ?? {},
    sudRedacted: payload.isSudClass === true, // consent present → render, flagged SUD for metadata
  };
  const backRef: DocumentBackRef = {
    sourceEvent,
    aggregateType: facts.aggregateType,
    aggregateId: payload.aggregateId,
    retentionClass: facts.retentionClass,
  };
  return { kind: "render", render, backRef };
}
