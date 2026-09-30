// scripts/outbox-deferred-consumers.ts — the F-043 (#103) register of DECLARED-BUT-UNBOUND outbox
// consumers.
//
// `declaredConsumers` on a catalog entry states that a module consumes that event. For most of the
// catalog that statement is not true, and until this register existed nothing said which: an event
// declaring `["m33", "m36"]` with zero consumers satisfied every rule
// `check-outbox-bindings.ts` had, because all three ran binding -> catalog and none ran
// catalog -> binding. That is the same unasked-direction defect as F-025/#59 (the live-suite gate
// checked package.json -> CI and never CI -> package.json, hiding 29 suite files), and the same fix
// applies: ask both directions, and NAME every exception.
//
// WHAT THE ABSENCE ACTUALLY COSTS AT RUNTIME. Not silence. `resolveRouting`
// (bootstrap/outbox-dispatcher.ts) marks an event `deferred` when any declared consumer module is
// not live, and the relay then finalizes each row `status: "pending"`, `attemptCount - 1`,
// `nextAttemptAt: now + deferredRetryMs` with `lastError: "deferred: one or more declared consumers
// are not live"`. Because the attempt count is DECREMENTED the row never reaches `maxAttempts` and
// never dead-letters, and the retention purge touches only `dispatched` rows — so every emission of
// a declared-but-unbound event is a row that stays pending forever and is re-claimed every 30
// minutes for the life of the deployment. `outbox-dispatcher.live.test.ts` ("deferred: a
// declared-but-not-landed type stays 'pending' with no attempt burn") is that behaviour's proof.
//
// WHAT THIS REGISTER IS AFTER #103's SECOND PASS. It held 1165 pairs; 623 of them were not deferrals
// at all. M4 captures at the DATABASE layer (write-audit triggers, in the producer's own
// transaction), M36 alerts through the `AlertEmitter` seam, and M33 pulls over `report_mv.*` — none
// of the three was ever going to bind an outbox consumer, so "deferred" described them wrongly and
// the declaration itself was what deferred 252 events forever. Those pairs moved to `seamConsumers`
// on the catalog entry, a field the dispatcher ignores by construction. What is left, 542 pairs, is
// the honest list: consumers that ARE meant to bind and do not yet.
//
// EACH ENTRY IS THE (module, event) PAIR, ENUMERATED. Grouping is by consumer module because that is
// where the reason lives — m22 is declared on 85 events for one reason, not 85 reasons — but the
// event lists are exact, so the count cannot drift and a pair that gains a binding fails the gate
// (`the deferral has outlived its reason`). Regenerate the lists with
// `bun run arch:outbox-bindings --update`; the reasons are hand-written and are never regenerated.
//
// `kind` is documentation, not a machine-checked claim; the machine-checked facts are that the pair
// is in the boot catalog and is currently unbound. `unclassified` means no reason has been
// established yet — the gate prints those loudly on every run. They are a work list, not a passing
// state.

/**
 * Why no live binding exists for this module's declared events.
 *
 * `"seam"` was the fourth kind and is deliberately gone (#103). It described 623 pairs whose consumer
 * never intended an outbox subscription at all — M4 captures at the DATABASE layer via write-audit
 * triggers, M36 alerts through the `AlertEmitter` seam, M33 pulls over `report_mv.*`. Those are not
 * deferrals waiting on work; they were the catalog using one word for two delivery mechanisms, and the
 * cost was 252 events deferred forever by a subscription nobody meant to declare. They now live in
 * `seamConsumers` on the catalog entry, which the dispatcher ignores by construction. A deferral is
 * now only ever a consumer that IS meant to bind and does not yet.
 */
export type DeferralKind =
  /** The module has consumer handler code that no `OutboxConsumerBinding` reaches. */
  | "handlers-unbound"
  /** The module has no consumer directory at all — a forward declaration against nothing. */
  | "no-consumer-surface"
  /** No reason established. Printed on every gate run; not a resting state. */
  | "unclassified";

export interface DeferredConsumerGroup {
  /** The module token named in the events' `declaredConsumers`. */
  readonly module: string;
  readonly kind: DeferralKind;
  /** Why. Must be non-empty — an unexplained deferral is the thing this register exists to end. */
  readonly reason: string;
  /** Every catalogued event that declares `module` and has no live binding from it. Exact, sorted. */
  readonly events: readonly string[];
}

export const DEFERRED_CONSUMERS: readonly DeferredConsumerGroup[] = [
  // F-205 (#248) — the m30 `handlers-unbound` group is GONE, not merely emptied. `m18.evv.visit_verified`
  // was bound earlier by F-194 (M18's check-out write path never called the `recordEvent` decider that
  // declared this event's effect; fixed by emitting it inline, then binding M30's pre-existing
  // `hvldl_near_death_recompute` handler). `m12.medication.error_reported`, the group's last remaining
  // pair, is now bound too. F-165/F-174 had found this event's real blocker was "no producer anywhere"
  // (the actor-identity half F-150 originally blamed was wrong — the catalogued payload already carries a
  // real `reportedByMembershipId`). The user has since decided the missing producer: a new explicit
  // clinician-initiated "report error" action on the medication order (M12), not an auto-derived one.
  // Built: `POST /api/v1/medication-orders/:id/report-error` (`reportMedicationError`), and
  // `buildM30MedicationErrorReportedConsumer` binding the pre-existing pure
  // `handleMedicationErrorReported`/`createIncidentDraft` handler (real since F-185), resolving
  // `providerEntityId`/`locationId` via a new M12→M6 seam chain (`medicationOrderScheduleContextForOrg` →
  // `admissionSchedulingContextForOrg`), the F-166 M13 dose-materializer precedent.
  // F-215 (#248) — the LAST m30 pair (`m15.volunteer.ratio_recomputed`) is dropped at the producing catalog
  // entry (misdeclared: numerator-only event, M30 names only `volunteer_compliance_gate_rate` from M15, read-time
  // seam pull), and the m30 group is deleted outright (the F-115/F-164/F-198 "group empties -> delete" precedent).
  {
    module: "m22",
    kind: "handlers-unbound",
    reason:
      "M22 renders on REQUEST. Its live binding consumes `M22_DOCUMENT_REQUEST_EVENTS`, and a module that wants a document emits a render request which M22 answers with `m22.document.rendered`. NOTE (F-099): a reason written for the whole group was WRONG for six of its members (the REQUEST spelling itself, unconsumed); those are bound. M6's six CoP documents were then bound directly (F-100) per the M22 spec's own §4.11 table, which routes those SOURCE events to the renderer with no `document_requested` needed. F-117 (#248) re-checked the ORIGINAL claim that 'for M11/M12/M13/M21/M23/M33 the request half IS wired, so the source declaration is redundant' PER EVENT rather than per module — it was right for exactly 4 of the ~20 events across those six modules (the ones actually co-emitted with a `document_requested` sibling in the SAME transition: `m11.order.signed`/`.standing_spawned`, `m12.medication_order.signed`, `m13.reconciliation.completed` — all now dropped from `declaredConsumers`, no `seamConsumers` replacement, since the artifact is delivered via the other event) and WRONG for the rest, which are separate order/claim/billing lifecycle events on the SAME modules with no such sibling and stay genuinely declared. Two more were dropped as never needing a render at all, not merely redundant: `m37.body_release.completed` (the PRIOR transition's own guard already requires the document to exist — `releaseBody` refuses without a signed `body_release_authorization`) and `m27.cost_report.reopened` (resets to `draft`; no job, no request, nothing to render until the next `submitted`). `m27.cost_report.submitted` was dropped on the F-108 precedent — it enqueues the `ecr-generation` job rather than emitting a request itself, and that job's own `m27.artifact.render_requested` is the real, already-bound handshake. `m37.body_release.funeral_home_identified` was dropped the ordinary way: `identifyFuneralHome` co-emits `m37.body_release.document_requested` in the same transition. F-142 (#248) added a genuinely misdeclared arrival from the (now-deleted) m32 group: `m19.triage.summary_requested` had been wrongly declared to m32 (a documentation error in `events-by-m19.ts`'s own inline comment), corrected at the source once M19's own locked spec — cited three separate ways — and `packages/types/src/oncall.ts`'s own payload doc comment both settled the real consumer as M22, for a caregiver/attending PDF render request. Genuinely unbuilt on both sides (no producer emits it yet either). F-144 (#248) finally ran the F-101 per-event sweep the group's own prior reason had flagged as outstanding on 38 events spread across eleven producing modules — checked in six parallel producer-clustered forks against M22's own §4.11 consumer table and each producing module's spec/code. **28 of 38 were genuinely misdeclared and dropped at the source**: all five remaining M11 order events (`corrected`, `discontinued`, `level_of_care_change_signed`, `recertification_signed`, `supply_fulfillment_requested` — the last three either redundant with a co-emitted/downstream sibling M22 already renders off, or with no support in M22's table at all — `level_of_care_change_signed`'s own 'M22 renders the LOC-change form' claim was checked against the real `PLATFORM_TEMPLATE_TABLE` and confirmed to name no such template, matching the standing F-101 finding on its own downstream `m6.loc.changed` sibling); `m8.encounter.voided` (structurally impossible — `ENCOUNTER_GRAPH` legalizes `void` only from `draft`, so a voided encounter can never have had a PDF rendered to suppress); `m14.meeting.adjourned` (redundant — co-emitted alongside `m14.minutes.signed`, M22's real trigger, in the same transition); both remaining M15 events (`discipline_assessment.amended`, `plan.discharged` — M15's own Lock-status section names only `plan.version_signed` as the M22 trigger); all four remaining M16 bereavement-plan events (`plan_opened` redundant with its co-emitted `outreach_artifact_requested` sibling; `plan_closed_completed`/`.declined`/`.early` unsupported — M22's own table names only `outreach_artifact_requested`/`bereavement.anniversary_due` for M16, and none of the three closure deciders emit a render-request sibling); `m37.ipu_admission.death_recorded` (M22's own spec never mentions a magic-link surface at all; F-147 (#248) ran down the 'internally inconsistent' M37 citation this entry flagged and confirmed it as one imprecise summary-table row against 15+ decisive citations elsewhere in M37's own spec naming the LATER `m37.body_release.funeral_home_identified` as the real magic-link trigger, and M22 — never M2 — as its architecture-§7.8-named consumer; that event's own magic-link half stays genuinely unbuilt, see the m37 group); five of six M23 billing events (`claim.acknowledged`/`.rejected`/`.submitted`, `noe.submitted`, `notr.submitted` — each redundant with the one real trigger, `m23.billing.document_render_requested`, which M23's own §4.10 table names explicitly as the sole M22 handshake point, confirmed against `consumers/document-render.ts`'s four builder functions and their exact payload shapes); three of four M24 events (`medicaid_claim.acknowledged`/`.rejected`/`.submitted` — the identical M23 shape one module over, redundant with `medicaid_billing.document_render_requested`); `m25.appeal.submitted` (redundant — co-emitted alongside the already-live-bound `m25.appeal_packet.render_requested` in the same transition, confirmed in `write-service-drizzle.ts`); all three M30 events (`incident.submitted`, `qapi.project_chartered`, `qapi.pip_closed` — each catalog description's own 'renders ... on request' phrasing describes a route-triggered mechanism, not a push, and M30's spec names five dedicated `*.render_requested` events for this purpose that were never catalogued or emitted anywhere — a producer-side gap reported, not fixed); and both remaining M5 events (`privacy_flag_changed`, redundant with the identical F-115/M28 shape — SUD redaction applied fresh per read via M3's `sud_consent_present` predicate, not a cached flag; `unmerged` — M5's own locked D8 states merge re-points FK references through a live resolver with no destructive UPDATE, so there is nothing for a push event to correct). **10 of 38 confirmed genuine**, no catalog change needed: `m14.minutes.amended` and `m7.care_plan.version_signed` (both decisively named in their producing module's own outbox table); `m17.caregiver_reminder_due`, `m21.supply_request.delivered`, and all three `m39.consent.{expired,recipient_added,recipient_removed}` events (each decisively named in the producing module's own outbox table, the F-131 'kept, not dropped' asymmetry since none of these appear in M22's own §4.11 table either); and three already-correctly-declared 'document_render_requested'-shaped events that anchor the M23/M24/M25 redundant-sibling drops above (`m23.billing.document_render_requested`, `m24.medicaid_billing.document_render_requested`, `m25.denial_resolution_letter.render_requested`) — all three confirmed genuinely unbuilt on the PRODUCER side too (no emit site anywhere for any of them), a real gap in M22's own request-list maintenance separate from the catalog-declaration question this sweep answers. What remains below (31 events) is the same three-way split the group's reason previously described, now fully swept: real named gaps from M22's own §4.11 table with no consumer built, one stale cross-reference already corrected, and the 10 confirmed-genuine events above plus the two version-append/transfer-variant M6 events untouched since F-099. **F-160 (#248) built the 4 events F-144 flagged as unbuilt on the PRODUCER side too — all 4 now render live.** `m13.administration_record.document_requested`: the pure `@wardenx/emar` machine had declared this as a `commit`-time effect on `perAdministrationPdfRequired` since M13-T03, but the production DB write service reimplements `commit` inline and never called it — fixed by reading `administration_policy.emar_per_administration_pdf_enabled` directly in `recordAdministration`'s transaction. `m23.billing.document_render_requested`: co-emitted in the same transaction as the underlying fact for all four of M23's typed builders — `noe_confirmation_receipt`/`notr_confirmation_receipt` at `submit` (`noe-notr-state-service.ts`), `claim_acknowledgment_letter` at `ack_277ca_accepted` and `denial_appeal_cover_letter` at `ack_277ca_rejected`/`ack_999_rejected` (both `claim-state-service.ts`). `m24.medicaid_billing.document_render_requested`: co-emitted at ACK_ACCEPTED for the one M24 document kind with a real producer transition (`medicaid_claim_acknowledgment_letter`) — the other three kinds M24's spec names (R&B contract summary, remittance summary, a second denial-appeal letter) have no producer transition anywhere in the codebase and stay unbuilt, no template published for them on purpose. Building this surfaced an independent, pre-existing production bug in the same file: `terminalizeSubmissionAndTransition`'s history INSERT passed the `withOrgContext` `\"\"` GUC sentinel as `actorMembershipId` — a nullable uuid column, not a GUC — so every worker-driven claim-state transition threw Postgres `22P02` on its very first tick, in every environment, forever (this worker had no test coverage anywhere in the repo before this pass); fixed to the honest `null`. `m25.denial_resolution_letter.render_requested`: co-emitted at `resolveDenial` (the manual no-appeal path); `denial_case` has no `patient_id` column, so the chart target is resolved via a direct `ClaimRepository.findById` read (legal — M25's `dependsOn` includes 23) and left honestly `null` when `claim_id` itself is null (the 277CA-pre-835/EVV-seeded shapes). Six new `document_aggregate_type` enum values were needed (migration 0251, the F-099/migration-0239 additive-only precedent) — each of M23's four kinds, M24's one, and M25's one is its own distinct type rather than a shared bucket, since a shared type would make one kind's render read as an idempotent redelivery of a different kind's under the same `(sourceEvent, aggregateId)` key. Proven by `f144-m13-m23-m24-m25-render-requests.live.test.ts`: all 4 producers, the real catalog-validating publisher, the real dispatcher, and the real M22 render consumer/renderer into real `document`/`document_version` rows under RLS, plus cross-tenant isolation — 10/10 passing. **F-161 (#248) built 2 of the 10 'confirmed genuine' events, the two with the most decisive producer-side evidence.** `m7.care_plan.version_signed` (M7's own catalog comment: 'drives the M8 encounter gate + M22 PDF') needed a brand-new `document_aggregate_type` — no care-plan PDF template existed at all — added via migration 0252 (the additive-only ALTER TYPE precedent). `m17.caregiver_reminder_due` (M17's own catalog comment: 'M22 renders the reminder, M36 delivers') reuses the `visit_confirmation` aggregate type, published since the enum's base definition with no descriptor and no consumer until now. Both proven live end-to-end in `f161-m7-m17-render-requests.live.test.ts` — M7 through the real `createDbCarePlanRouteService` bootstrap→author→finalize→quorum→emit→render chain (plus a no-quorum negative case), M17 by publishing the real catalogued payload directly through the real catalog-validating publisher, since **no producer exists anywhere in `17-scheduling/` for this event** — `jobs/cron-workers.ts` registers only `recurringMaterialize`/`visitAttention`, no caregiver-reminder cron; the M22-side binding is real and tested against the real payload shape, but nothing in production currently emits it (a producer-side gap in a different module, reported not fixed). The other 8 of the 10 stay exactly as confirmed-genuine-but-unbuilt: `m14.minutes.amended` needs the W2 append/re-render path (`decideDocumentRequest`'s idempotency is keyed `(aggregateType, aggregateId)` only, so a second request against an already-rendered aggregate silently no-ops — the identical gap already documented for `m6.discharge.cosigned` two paragraphs up); `m21.supply_request.delivered` is an e-signature CAPTURE workflow (D7's optional caregiver signature off an already-existing evidence photo), not a render-from-typed-payload, and needs a whole new FormFill-style capability M22 does not have; all three `m39.consent.{expired,recipient_added,recipient_removed}` events describe a signed-URL-revoke/cache-invalidation mechanism that does not exist — M22 resolves M39's `ConsentEvaluator` FRESH on every signed-URL mint (the identical F-115/F-144 seam-pull shape), so there is no persistent grant state for any of the three to revoke or invalidate, and all three catalog descriptions are stale relative to the seam-pull design actually built; the three `*.document_render_requested`-shaped anchors stay unbuilt on the producer side as already stated. **F-162 (#248) re-checked `m14.minutes.amended` once more, attempting the build, and found the premise itself was wrong plus a sharper root cause than 'the W2 path needs building'.** `m14.minutes.signed` — cited elsewhere in this corpus as M22's 'real trigger' this event would piggyback on — is NOT actually bound either: `M22_DOCUMENT_REQUEST_EVENTS` (`decide-document-request.ts`) contains neither `.signed` nor `.amended`, confirmed never present at any point in `git log -p` history, and `PLATFORM_TEMPLATE_TABLE` has no template descriptor for `idg_minutes`/`idg_patient_packet` at all despite both being real `document_aggregate_type` enum values — so even a first-ever render would hit `unknown_template` today. Positive finding: the W2 genesis-vs-append machinery ITSELF is fully built at the store layer (`DocumentSeamStore.upsertRenderedDocument`, `seams/drizzle-seam-store.ts` — `SELECT ... FOR UPDATE`, insert a new `document_version` + flip `active_version_id` if a document exists, else genesis) and called unconditionally by the renderer whenever the decider returns `\"render\"` — this part is NOT missing, correcting the framing above. **The real blocker is the idempotency-key GRANULARITY** in the shared pure decider (`decideDocumentRequest`): `facts.alreadyRendered` is resolved by `store.renderedDocumentForAggregate({aggregateType, aggregateId, organizationId})` — 'does ANY document exist for this aggregate' — never by `(sourceEvent, aggregateId)` as the file's own header comment says is the INTENDED design; the real call site never passes `sourceEvent` into the lookup. This is necessary today for crash-safety (traced `outbox-dispatcher.ts`: the delivery receipt is written in a SEPARATE transaction AFTER `handle()` returns, so a genuine redelivery must re-hit `alreadyRendered` and no-op, or a crash-and-retry would double-render), but it also means EVERY subsequent render request for an aggregate that already has a document — not just a stale redelivery — silently no-ops, which is exactly backwards for `.amended` (which needs a NEW version, not a skip). Fixing this needs either a schema migration (a request-identity column on `document_version`, or a small dedup table keyed by outbox event id) or a decider redesign — shared infrastructure used by every one of the ~40 events M22 currently renders, not an M14-scoped narrow extension, and explicitly the same shape already on record for `m6.discharge.cosigned`. `m14.minutes.amended`'s own emitted payload is also thin either way — `{amendmentId, minutesId, requestedByMembershipId, approvedByMembershipId, amendmentReasonHash}`, no render content (the amendment's real `amendmentDiff` is never put on the wire) — a second, smaller gap once the idempotency question is resolved. No files changed." +
      "**F-166 (#248) ran a survey-then-build pass over the group's remaining ~25 events, built 5 GENESIS-only" +
      " render requests, dropped 1 vapor duplicate, and sharpened the rest with real, checked reasons rather" +
      " than re-asserting them.** All five builds share the F-162 boundary exactly: a FIRST document per" +
      " aggregate id, never a second request against one `decideDocumentRequest`'s `(aggregateType," +
      " aggregateId)`-only idempotency already answers `idempotent_skip` for. **Built**: `m8.encounter.signed`" +
      " (template `encounter`, published since the platform-floor table with no producer wired to it — the" +
      " LOCKED payload's `documentRenderPayload: {final, addenda}` has carried the renderable content since" +
      " the event existed, unconsumed); `m18.evv.aggregator_accepted` (template `evv_verification`, the" +
      " F-100 'event NAME is the template' shape — its declared sibling `verification_pdf_requested` turned" +
      " out to be VAPOR, see the drop below); `m14.packet.render_requested`/`m14.minutes.signed` (templates" +
      " `idg_patient_packet`/`idg_minutes` — both real `document_aggregate_type` values since migration 0048" +
      " with no descriptor and no subscription until now, exactly the wall F-162 found); and" +
      " `m15.plan.version_signed` (templates `aide_poc`/`msw_plan`/`spiritual_plan`/`volunteer_plan` by" +
      " `kind`, all four also real since migration 0048 — the event's own payload had no `patientId`, widened" +
      " at the source, the F-099 'the fact was already in scope at the one emit site' precedent). No" +
      " migration was needed for any of the five — every aggregate type these five real, catalogued events" +
      " need already existed; the gap was purely the missing TemplateDescriptor + REQUEST_SHAPES/event-list" +
      " entry. **Dropped**: `m18.evv.verification_pdf_requested` — its own description duplicates" +
      " `aggregator_accepted`'s ('triggers the M22 verification-PDF render (D11)') for the SAME D11 artifact," +
      " and checked against the real code rather than either description, it is the vapor one: no file under" +
      " `18-evv/` ever publishes it, only `aggregator-submission.ts`'s pure decider emits" +
      " `aggregator_accepted`. Now record-only at the source. **The rest were investigated and sharpened," +
      " not rebuilt on guesswork.** `m11.order.results_received` looked like a sixth clean win (template" +
      " `lab_results_pdf` already exists) until the render-variants directory was checked: it is NOT part of" +
      " this generic framework at all — a dedicated, already-written `lab-backref-consumer.ts`/" +
      " `lab-backref-bindings.ts` pipeline exists for it, explicitly deferred pending M29's" +
      " `LabObservationReader`. That reader IS now registered at boot (`registerM29PublishedSeams`), which" +
      " the pipeline's own header does not yet reflect — but the REAL registered interface" +
      " (`getById`/`listByPatient`) does not match the port M22 forward-declared" +
      " (`resolveLabResultsPayload`), so `getSeam(...).resolveLabResultsPayload` is `undefined` and the" +
      " deny-stub still fires; fixing the name mismatch would not be enough regardless, because" +
      " `LabObservationSeamDTO.values` carries no per-value SUD-class flag, and §7.16 requires one before" +
      " any render — the identical Part-2-disclosure risk F-035 already refused for a different DTO pair." +
      " Building the generic REQUEST_SHAPES entry I first drafted would ALSO have been wrong on its own" +
      " terms: keying the render on `orderId` with `aggregateType: 'order_record'` collides with the" +
      " order-form document `m11.order.document_requested` already renders for that same order at sign" +
      " time, so the lab result would silently `idempotent_skip` forever once an order had ever been" +
      " signed. `m5.patient.merged` is a genuinely different mechanism from the already-dropped `.unmerged`" +
      " — its own description names a real per-document `UPDATE document SET patient_id = ...` M22 would" +
      " have to perform, not a render — but grepping the whole of `05-patient/` outside the catalog and its" +
      " own tests found NO producer anywhere: the D8 merge write path itself does not exist yet, so this is" +
      " unbuilt on BOTH sides, not merely the M22 side the group's framing implied. `m5.patient" +
      " .draft_created_from_extraction` and `m12.medication_order.draft_created_from_extraction` are the" +
      " same class as each other: the whole DocLens extraction/commit pipeline that would produce either is" +
      " 'BUILT-NOT-ACTIVE' (`pipeline-service.ts`'s own header) behind the `documents.doclens` flag, OFF for" +
      " every tenant, with its own outbox dispatch explicitly forward-declared pending M32 — no real event" +
      " can fire from either side today." +
      " **F-171 (#248) ran this pair down fully — built two SIBLING seed rows the investigation found" +
      " genuinely ready, and found `media_release` itself is blocked on more than a missing seed row.**" +
      ' The standing note above ("the seed catalog publishes only 3... no `media_release` type is' +
      ' registered") undersold the gap: `22-documents/` has NO `m39.consent.revoked` consumer file of ANY' +
      " kind (grepped) — not merely unseeded, unbuilt — and a from-scratch build has no non-guessed way to" +
      ' satisfy the spec\'s own "locate prior-rendered media artifacts for the patient" step (§4.11).' +
      " `document`'s `aggregate_type`/`source_kind` enums (`packages/db/src/enums.ts`) carry no photo/" +
      " video/media concept distinct from any other upload — a wound-care photo captured via" +
      " `DOC.Mobile.UploadPhotoToChart` is stored identically to a marketing photo — and `consent_document" +
      " _link` (M39-owned) links a consent record only to ITS OWN rendered PDF (D15/§1.2), never to media" +
      " released under its authority. A `document_version.mime_type LIKE 'image/%'` heuristic was" +
      " considered and rejected: it would misclassify ordinary clinical photos as media-release content —" +
      ' the "guessed provider entity is a mis-stated cost report" mistake (F-102) applied to PHI photos.' +
      " Seeding `media_release` anyway (its own type data is otherwise well-specified per D2/D7/D8) was" +
      " rejected too, per this pass's own conservative instruction: it would make `cascadeKind` resolve" +
      ' correctly with STILL no consumer to read it — moving the blocker from "no seed row" to "seed row,' +
      ' still nothing consumes it", the exact "looks fixed, isn\'t" shape this arc exists to avoid. Stays' +
      " unseeded and unbuilt; the real M22-side gap (a document→media classification mechanism) is reported" +
      " here, not fixed. **Two SIBLING types ARE now seeded**, each checked against its OWN D7 cascade" +
      " consumer rather than assumed from the spec's prose: `portal_access` (M2" +
      " `buildM2ConsentRevokedConsumer`, F-142, filters exactly this `typeKey`, deletes the patient's" +
      " `patient_portal` sessions — real and bound — + M31 `buildM31ConsentRevokedGrantCascadeConsumer`," +
      " revokes the matching `portal_access_grant` row by `source_consent_record_id` — real and bound) and" +
      " `bereavement_outreach_consent` (M16 `buildM16ConsentRevokedConsumer`, F-151, the §2.6 per-" +
      " bereaved-contact opt-out cascade — real and bound — + the same M31 grant-revoke consumer). Seeding" +
      " the second row is also what makes `createBereavementOutreachDraft`'s `consent_record.type_key` FK" +
      " satisfiable for the first time in any deployment — the D14 post-mortem consent flow was" +
      " unreachable before this, independent of the cascade question. Proven live end to end (real M39" +
      " `createDraft`/`createBereavementOutreachDraft` → `signConsent` → `revokeConsent`, the real" +
      " catalog-validating outbox publish, the ACTUAL delivered payload read back from `outbox_event` and" +
      " handed to the real M2/M16/M31 consumers, under RLS) by" +
      " `f171-consent-type-seed.live.test.ts` (3/3). The other 7 of the 9 previously-unseeded types" +
      " (`dpoa_financial`, `family_caregiver_access`, `research_participation`, `telehealth_consent`," +
      " `advance_directive_acknowledgment`, plus `media_release` above) stay unseeded — each checked and" +
      " found to have no live-bound `m39.consent.revoked` consumer for the cascade the D7 table names it" +
      " (`family_caregiver_access` additionally carries a REPORTED, unresolved over-termination risk on" +
      " its M2 half per that consumer's own file header — a real correctness hazard, not merely an" +
      " absence — so it stays out even though its M31 grant-cascade half would work) — reasons recorded in" +
      " `scripts/db/seed-consent-types.ts`'s own header rather than restated here. `m12.medication_order.list_changed` and" +
      " `.transmitted` are both the F-162 granularity collision one module over: `.document_requested`" +
      " already renders `medication_order` for the same `orderId` at sign, so a later `.transmitted` (or any" +
      " `.list_changed` after the first) would find `alreadyRendered: true` and silently no-op — not a" +
      " missing binding, a binding that would do nothing if built naively. `m8.encounter.addendum_signed` is" +
      " now genuinely the SAME collision against the `encounter` render this pass just bound at `.signed` —" +
      " confirmed rather than merely re-asserted, since before this pass there was no genesis render to" +
      " collide with. `m9.assessment.summary_requested` has no per-request aggregate identity at all" +
      " (`{patientId, asOfDate, scales, lang}`, no assessment/request id) — unlike its M10 HOPE-summary" +
      " sibling (keyed on a specific `assessmentId`), using `patientId` as the aggregate id would mean the" +
      " FIRST summary request for a patient renders and every later one (a summary asked for on a later" +
      " date) silently no-ops forever under the same `(aggregateType, patientId)` key; genuinely blocked by" +
      " the same idempotency-granularity design gap `m14.minutes.amended` already names, not merely" +
      " unbuilt. `m11.order.draft_created` ('M22 preps the order form') and `m12.medication_order" +
      " .signature_requested` ('M22 preps the PDF') both use pre-signature 'prep' language with no evidence" +
      " anywhere in `11-orders/`/`12-dosespot/` of a distinct draft-preview artifact or route, and the real" +
      " signed artifact is already delivered by each module's `.document_requested`/`.signed` sibling — the" +
      " F-101 redundant-sibling shape looks likely, but kept declared rather than dropped absent a decisive" +
      " corroborating citation (the F-131 caution), for a future pass to settle. `m14.minutes.amended`," +
      " `m19.triage.summary_requested`, `m21.supply_request.delivered`," +
      " `m39.consent.{expired,recipient_added,recipient_removed}`, `m6.discharge.cosigned`, and" +
      " `m6.transfer.created` were re-checked against the current code and are unchanged from F-161/F-162/" +
      "F-144/F-099's own findings." +
      " **F-168 (#248) fixed the idempotency-key-granularity infrastructure gap F-162/F-166 had traced but" +
      " left unbuilt, and bound the three clearest instances.** `decideDocumentRequest`'s `alreadyRendered`" +
      " fact was resolved from `store.renderedDocumentForAggregate({aggregateType, aggregateId})` —" +
      " checked directly against `outbox-dispatcher.ts` first, not assumed: the dispatcher's" +
      " `(event_id, consumer_name)` receipt (§4.11) already dedupes a FULLY completed delivery, but a crash" +
      " between `handle()` succeeding and that receipt being written (an inherent gap — they are two" +
      " separate writes) means a genuine redelivery of the identical outbox row CAN still reach `handle()`" +
      " a second time, so `decideDocumentRequest` still needs its own idempotency floor; it just had the" +
      " wrong granularity. Fixed by keying `alreadyRendered` on the SPECIFIC delivered outbox event id" +
      " (`DispatchableOutboxEvent.id`, not the event TYPE string the header comment's old" +
      " `(sourceEvent, aggregateId)` framing actually meant) via a new `document_version.source_event_id`" +
      " column (migration 0261, plain uuid, NULLS-DISTINCT unique on `(organization_id, source_event_id)`," +
      " no FK — `outbox_event` rows are purged past retention) written in the SAME insert as the version" +
      " row, so the redelivery-dedup and the artifact it protects are atomic (no separate receipt table" +
      " with its own lost-write crash window). A NEW store method" +
      " (`DocumentSeamStore.documentVersionForSourceEvent`) resolves the fact; `renderer.ts`'s shared" +
      " `RenderPayloadCore` gained an optional `sourceEventId` field so the change reaches every render" +
      " WITHOUT widening the leaf-typed `DocumentRenderer.render(scope, templateKey, payload)` seam other" +
      " callers (DSAR/tenant-export jobs, the M39 consent render, the lab-backref/statement-of-disagreement" +
      " variants) share — they simply never set it, which the store already wrote as NULL. **Bound the" +
      " three clearest 'same aggregate, genuinely new content' cases**: `m8.encounter.addendum_signed`" +
      " (appends onto `.signed`'s `encounter` aggregate; payload widened at the source with" +
      " `documentRenderPayload`, the same PHI-safe empty-string stand-in `.signed` already sends — no new" +
      " disclosure, `reason` was already on the wire in the clear before this change) and" +
      " `m14.minutes.amended` (appends onto `.signed`'s `idg_minutes` aggregate; payload widened with the" +
      " same three snapshot columns `.signed` already publishes — deliberately NOT the DENYLISTED" +
      " `amendmentReason` plaintext, only its hash was ever on the wire and stays that way; a first draft of" +
      " this fix put the plaintext on the wire and was corrected before landing). `m12.medication_order" +
      " .transmitted` is ALSO bound on the consumer side (appends onto `.document_requested`'s" +
      " `medication_order` aggregate) but is honestly reported, not a working end-to-end fix: exhaustively" +
      " grepped, this event is catalogued with NO PRODUCER anywhere in `12-dosespot/` — the" +
      " `dosespot.transmit_newrx` worker its own catalog description names does not exist in this codebase" +
      " (no DoseSpot vendor credential is configured anywhere either), the `m18.evv.visit_verified`/" +
      " `m17.caregiver_reminder_due` (F-150/F-161) shape a third time — the binding is real and tested" +
      " against the real catalogued payload, but nothing emits the event yet. **`m12.medication_order" +
      ".list_changed` was checked and found NOT to be the same collision at all**, correcting a stale" +
      " framing from F-166: its aggregate is the PATIENT (`patientId`, no `orderId` field on the payload —" +
      " a med-LIST render, not a per-order one), a genuinely different aggregate from `.document_requested`" +
      "'s `order_record`/`orderId`, so the granularity fix does not unblock it; it would need a brand-new" +
      " aggregate type + template (a 'medication list' document keyed on patient), real feature scope beyond" +
      " an idempotency-key fix, and stays declared with this corrected reason. `m6.discharge.cosigned` is" +
      " now a real, technically-unblocked candidate this pass did NOT build — deliberately, since binding it" +
      " needs its own review (a for-cause discharge cosign is a materially different kind of 'new version'" +
      " than an amendment or a re-transmission: does the surveyor-facing discharge summary need to visibly" +
      " change on cosign, or does the cosign only need recording on the `discharge_event` row itself?), left" +
      " for a future pass rather than a drive-by add. `m6.transfer.created` is unrelated to the granularity" +
      " fix (it wants a template VARIANT that does not exist, not a second version of the base template) and" +
      " stays unchanged. **`m9.assessment.summary_requested` was checked against the fix and deliberately" +
      " left unbound, on a real product-design question rather than a remaining technical blocker**: its" +
      " payload (`{patientId, asOfDate, scales, lang}`) has no assessment/request id, so the only candidate" +
      " aggregate id is `patientId` — and with the granularity fix, that would make every distinct summary" +
      " request correctly render (never silently no-op), but as a NEW VERSION of one ongoing" +
      " 'hope_summary' document per patient, where each version is really an independent point-in-time" +
      " snapshot (`asOfDate`), not a correction/amendment of the previous one the way an addendum or an" +
      " amendment is. Filing successive dated snapshots as document VERSIONS would make" +
      " `document.active_version_id` surface only the LATEST as if it superseded the earlier ones — which" +
      " it does not; each was independently valid on its own `asOfDate`. That is a real decision about" +
      " what 'the HOPE summary document' means (one evolving record vs. one document per snapshot date," +
      " the latter needing a per-request aggregate id this event's payload does not carry), not something" +
      " this pass decides unilaterally." +
      " **F-170 (#248) re-checked all sixteen remaining events' specific stated blockers fresh (2026-09-29," +
      " one round after F-168) and found fifteen unchanged, plus one factual correction that does not" +
      " change the outcome.** `m11.order.results_received`: both facts unchanged — the real registered" +
      " `LabObservationReader` interface (`published.ts`) is still exactly `getById`/`listByPatient`, M22's" +
      " `lab-backref-bindings.ts` still calls a `resolveLabResultsPayload` method that interface does not" +
      " have, and `LabObservationSeamDTO`/`LabObservationSeamValue` still carry no SUD-class field anywhere" +
      " (checked the full struct, not just the top level). `m5.patient.merged`: still no D8 merge write" +
      " path anywhere in `05-patient/` (grepped the whole directory outside tests; only `matching/` patient-" +
      " match-candidate code exists, a different mechanism) and still no emit site for this event anywhere" +
      ' in the repo (`declaredConsumers: ["m22","m35"]`, `isOutboxOnly: true`, zero producers).' +
      " `m5.patient.draft_created_from_extraction`/`m12.medication_order.draft_created_from_extraction`:" +
      " `documents.doclens` is still default OFF everywhere it's read (`feature-flag.ts`," +
      ' `pipeline-service.ts`, the extraction routes), still described as "BUILT-NOT-ACTIVE"/"Phase 1" at' +
      " every call site, no seed or migration flips it, and grepping `22-documents/` finds zero emit sites" +
      " for either `draft_created_from_extraction` event under any spelling — unchanged. `m39.consent" +
      ".revoked`'s `media_release` branch: `scripts/db/seed-consent-types.ts` still seeds exactly 3 of the" +
      " spec's 12 canonical types (`hipaa_release`, `42_cfr_part_2_release`, `dpoa_healthcare`), all three" +
      ' `revocationCascadeKind: "immediate"`, no `media_release` type registered anywhere — unchanged as' +
      " of this round; F-171 (#248, the next round) found the gap is deeper than the seed row (no M22" +
      ' consumer file exists at all, and no schema mechanism can locate "media" documents without' +
      " guessing) and left it unseeded/unbuilt for that reason — see this group's own F-171 paragraph" +
      " above, which also seeded the two SIBLING types (`portal_access`," +
      " `bereavement_outreach_consent`) whose own cascades ARE real. The" +
      " other three `m39.consent.*` events and M22's own consent-render pipeline still resolve" +
      " `ConsentEvaluator` fresh per signed-URL mint with no persistent grant/share table on the M22 side to" +
      " invalidate (checked `packages/db/src/schema/consent/` for a new table — none added) — unchanged." +
      " `m9.assessment.summary_requested` and `m6.discharge.cosigned`: both catalogued payloads are" +
      " byte-identical to what F-168 reviewed (`events-by-m9.ts`/`events-by-m6.ts` re-read directly) and" +
      " F-168's own deliberate deferrals (a real per-artifact versioning-semantics decision in each case)" +
      " are respected rather than reversed unilaterally, per this pass's own instruction to be conservative" +
      " here. `m11.order.draft_created`, `m12.medication_order.signature_requested`," +
      " `m19.triage.summary_requested`, `m21.supply_request.delivered`, `m6.transfer.created`: all" +
      " re-checked against current code and unchanged from F-161/F-166's own findings (no draft-preview" +
      " artifact, no FormFill capability, no discharge-summary transfer variant, no producer for the M19" +
      " event anywhere in `19-oncall/`)." +
      " **The one correction: F-168's claim that `m12.medication_order.list_changed` \"would need a" +
      ' brand-new aggregate type + template" is factually wrong, though the practical conclusion' +
      " (stays unbound) still holds for a DIFFERENT reason.** `patient_medication_list` has been a real" +
      " `document_aggregate_type` enum value with a published `TemplateDescriptor`" +
      ' (`packages/forms/src/templates/registry.ts`, `key: "patient_medication_list"`, `patientFacing:' +
      " true`) since M22-T01 (commit `1c9f5e48`, 2026-06-23) — both existed the whole time F-166/F-168 were" +
      " investigating this event; neither needs building. **The real, still-genuine blocker is a content" +
      " gap, not a schema gap**: the event's payload (`{patientId, addedOrderIds, removedOrderIds}`) carries" +
      " only a DIFF, never the full active-medication list a `patient_medication_list` document needs to" +
      " render, and M22's generic `render-consumer.ts`/`REQUEST_SHAPES` pipeline only ever projects fields" +
      " already present on the delivered payload — it has no live seam-fetch step anywhere. The one place" +
      " M22 DOES fetch render content from a foreign seam is the dedicated `lab-backref-consumer.ts`/" +
      "`lab-backref-bindings.ts` pipeline (itself still blocked, see `m11.order.results_received` above) —" +
      " confirmed this is the ONLY such pattern in the module (`grep getSeam` across `outbox-consumers/` +" +
      " `render-variants/` returns exactly those two call sites). M12's `MedicationOrderProvider` seam DOES" +
      " publish `getActiveMedications(orgId, patientId)` (`packages/types/src/dosespot.ts`), which would" +
      " supply the right content — but wiring it means building a THIRD dedicated render-variant pipeline" +
      " (org-context resolution, a seam call, content shaping, its own live test), comparable in scope to" +
      " the lab-backref pipeline itself, not a REQUEST_SHAPES entry. Not built here — real feature scope, not" +
      " a wiring fix — but the reason is now accurate: a missing content-resolution pipeline, not a missing" +
      " aggregate type or template. **Net: 0 bound, 0 dropped, all 16 events remain, unchanged in substance" +
      " from F-166/F-168.**" +
      " **F-171 (#248) built the THIRD dedicated render-variant pipeline F-170 scoped but did not attempt," +
      " and `m12.medication_order.list_changed` is now bound.** `medication-list-consumer.ts` (pure decider," +
      " the `lab-backref-consumer.ts` shape) + `medication-list-bindings.ts` (the LIVE wiring — unlike" +
      " `lab-backref-bindings.ts`, genuinely live: M12's `MedicationOrderProvider` seam is real and" +
      " registered in production, M12-T07, not a Wave-H deny-stub) resolve the patient's CURRENT" +
      " active-medication set via `getActiveMedications(orgId, patientId)` at DELIVERY time — never from" +
      " the diff payload, which F-170 correctly identified cannot supply the content. **Checking" +
      " `PLATFORM_TEMPLATE_TABLE` (`renderer.ts`) directly, rather than trusting F-168/F-170's own" +
      " citation, found the 'template already exists' framing was checking the WRONG registry**: F-168's" +
      " `packages/forms/src/templates/registry.ts` row is a separate golden-template-diff/overlay" +
      " manifest never consulted by `render()`/`REQUEST_SHAPES`; the table `createDocumentRenderer`" +
      " actually resolves `templateKey` against had NO `patient_medication_list` entry at all — a first" +
      " render would have thrown `UnknownTemplateError` regardless of the forms-registry row's existence." +
      " Added (no migration — `document_aggregate_type` already carries the value, mig 0048)." +
      " **AMBIENT REQUEST CONTEXT REQUIRED, found writing this rather than assumed working**: the" +
      " F-118/F-153 M17/M18 shape a further time — M12's `DoseSpotSeamStore.medicationOrdersForPatient`" +
      " (the read behind `getActiveMedications`) opens `withOrgContextFromRequest`, which throws outside" +
      " an active `runWithRequestContext` scope, and a dispatcher tick is not a request; fixed the same" +
      " way (`runWithRequestContext({organizationId, userId: CONSUMER_USER_ID}, …)` wraps the seam call)." +
      " **Idempotency reuses F-168's per-request granularity directly, outside the generic pipeline**:" +
      " every genuinely new `.list_changed` event for a patient must produce a NEW `document_version` (the" +
      " task's own confirmation of F-170's `appends: true`-shaped reasoning), so `alreadyRendered` is" +
      " keyed on `documentVersionForSourceEvent(event.id)` alone, never `(aggregateType, aggregateId)`" +
      " (which would `idempotent_skip` every delivery after the first). **§7.16 SUD redaction was added" +
      " as a deliberate scope extension, reusing existing infrastructure rather than inventing new**:" +
      " `MedicationOrderDto.isSudTreatment` is already on every row `getActiveMedications` returns, and a" +
      " full active-medication list is exactly the kind of 42 CFR Part 2 disclosure risk" +
      " `planLabResultsRender`'s existing `redactSudValue` machinery exists to guard — a SUD-treatment" +
      " row's drug name/sig are redacted unless `resolveSudConsentPresent` (M39, already used by the" +
      " generic pipeline) confirms an active release; the seam call is skipped entirely when no resolved" +
      " medication needs it. **One pre-existing platform gap matched for consistency, not newly" +
      " introduced or fixed**: `DocumentRenderer.render()` inserts every document under the TEMPLATE'S OWN" +
      " `descriptor.retentionClass` — it takes no retention-class parameter at all, so neither this" +
      " consumer's nor `render-consumer.ts`'s own SUD `retentionClassOverride`" +
      " (`compliance_42cfr_part2`) is threaded into the persisted row; the row-level text redaction (the" +
      " actual disclosure protection) is unaffected. `m22.document.rendered` is emitted for parity with" +
      ' every other render (`sourceModule: "m12"`, `aggregateType: "patient_medication_list"`) — checked' +
      " against M12's own `m22-document-rendered.ts` back-ref consumer directly rather than assumed safe:" +
      ' it filters on `M12_AGGREGATE_TYPES = new Set(["medication_order"])`, so this aggregate type' +
      " no-ops there rather than mis-stamping `medication_order.document_id`. Proven by" +
      " `m22-medication-list-render.live.test.ts`: a real M12 medication order signed under RLS, a" +
      " published `.list_changed` event resolving the real current active set via the real seam and" +
      " rendering a real `patient_medication_list` document version; a redelivery of the identical outbox" +
      " event id re-announces without a second version; a genuinely later, different `.list_changed`" +
      " event for the same patient renders a second, distinct version; a SUD-treatment order redacts its" +
      " drug name/sig with no active Part 2 consent and renders plaintext with one; and cross-tenant" +
      " isolation holds (org B's seam call for org A's patient resolves nothing, never leaks org A's" +
      " medications). Net: 16 → 15 events remain in this group." +
      " **F-171 (#248) — `m5.patient.merged` is dropped from this group entirely, corrected in BOTH" +
      " directions at once, not merely bound.** This pass built the real §2.4/§4.3 merge write path" +
      " (`05-patient/merges.ts` + `merges-db.ts`, `POST /api/v1/patients/:id/merge`) — the D8 merge" +
      " mechanism ('re-points all FK references through the `patient_resolver`... no destructive UPDATE'" +
      " already committed for `.unmerged`) had NO execution path anywhere, matching this group's own prior" +
      ' finding exactly ("unbuilt on BOTH sides"). The producer side is now real: the source flips to' +
      " `status='merged'`/`merged_into_id`, the target absorbs any chosen field resolutions, `patient_merge`" +
      " records the audit diff, and `m5.patient.merged` publishes for real. **The M22 side was checked" +
      " against the actual code rather than re-built to the group's own prior description** — \"a real" +
      ' per-document `UPDATE document SET patient_id = ...` M22 would have to perform" is false, and' +
      " provably so: `22-documents/lifecycle/merge-redirect.ts` (M22-T03) is a complete, unit-tested pure" +
      ' core whose own header states the opposite design — "M22 does NOT mutate `document.patient_id`' +
      " eagerly on the merge event... on every fetch it resolves the document's stored `patient_id`" +
      ' through the merge chain to the surviving patient" — a SEAM PULL against live `patient' +
      " .merged_into_id` state (the M40 `followMerge` shape, applied to documents), never a push this" +
      " event could drive. `m5.patient.merged`'s catalog entry now declares `m22` as a `seamConsumers`" +
      " entry instead of `declaredConsumers` (events-by-m5.ts), which is what actually stops it deferring" +
      " forever — no consumer build was ever the right fix for this pair. **Not built**: the read-time" +
      " redirect itself is still unwired (`resolvePatientRedirect`/`applyPatientMergeCascade` have zero" +
      " real callers anywhere in `22-documents/` outside their own barrel export and unit test) — a real," +
      " separate M22-owned gap (a DB-backed `MergeFacts` implementation reading `patient.merged_into_id`," +
      " threaded through M22's document-fetch routes), reported rather than built here since it touches" +
      " M22's read surface broadly and needs its own review, the `m6.discharge.cosigned` precedent two" +
      " lines up. Proven live end to end (real Drizzle write, real RLS, real catalog-validating" +
      " publisher): `m5-patient-merge.live.test.ts` — the target absorbs a chosen field resolution while" +
      " every other target field is left alone, the source flips to `merged` with `merged_into_id` set" +
      ' and every OTHER row it owns is left completely untouched (the "no destructive UPDATE on' +
      ' satellite tables" proof), `patient_merge.merged_field_diff` records the full per-field audit,' +
      " `m5.patient.merged` publishes with `patientId`=target/`sourcePatientId`=source, a self-merge/" +
      " already-merged-source/already-merged-target/unmergeable-status/unknown-field attempt each refuse" +
      " with its own typed error, and cross-tenant isolation holds (org B cannot merge org A's patients," +
      " in either direction — both resolve 404 under RLS). Net: 15 → 14 events remain in this group." +
      " **F-171 (#248) built the DEDICATED `lab-backref-consumer.ts`/`lab-backref-bindings.ts` pipeline" +
      " this group's own text had named as the reason `m11.order.results_received` could not use the" +
      " generic REQUEST_SHAPES pipeline, and it is now bound — the group's last M11 event.** Two real" +
      " defects, checked against the code rather than re-asserted from the prior framing. (1) The name" +
      " mismatch: the real registered `LabObservationReader` (`29-external-interfaces/seams/published.ts`)" +
      " has always been exactly `getById`/`listByPatient`; `lab-backref-bindings.ts` called a" +
      " `resolveLabResultsPayload` method that interface never had, so the deny-stub fired even once M29's" +
      " seam registered at boot. Fixed by ADDING a method rather than renaming the call to `getById`:" +
      " `getById` REQUIRES a `patientId`, and the real catalogued `m11.order.results_received` payload" +
      " (`events-by-m11.ts`) carries NO `patientId` at all (checked directly, not assumed — M11 owns the" +
      " order, not the patient binding a lab result resolves to), so no rename could have worked regardless." +
      " A new `getByObservationId(organizationId, observationId)` (additive; `getById` untouched for the" +
      " M28 FHIR caller that already has a patientId in hand) is the real fix. (2) The SUD-class flag:" +
      " `LabObservationSeamValue` carried none, and it is now a REAL, non-fabricated per-value field —" +
      " `isSudClass` projects the parent `lab_observation.sud_redacted_at_ingest` column onto every value" +
      " row of that observation, matching how ingest actually redacts (`lab-attach-planner.ts`'s" +
      " `buildValueRows` applies ONE boolean per MESSAGE, uniformly across every OBX row — never an" +
      " invented per-row classifier); `loincDisplayText` was added alongside it (present on the real row," +
      " simply never projected). **Deliberately NOT wired into the generic `render-consumer.ts`" +
      " `REQUEST_SHAPES` table**, confirming the group's own prior citation: `lab_results_pdf` publishes" +
      " the SAME `aggregateType` (`order_record`) the order-FORM render already occupies at sign time, and" +
      " that pipeline's idempotency is genesis-only (`renderedDocumentForAggregate`) — it would read \"this" +
      ' order already has a document" the instant an order was signed and silently `idempotent_skip` the' +
      " lab result forever. The dedicated consumer instead reuses the F-168 per-delivered-event dedup" +
      " (`document_version.source_event_id`) directly, so a genuinely new lab result always renders as a" +
      " NEW VERSION of the order's `order_record` document trail — exactly what M11's own, already-bound" +
      " `buildM11DocumentBackrefConsumer` expects (it stamps `order_record.document_id` by matching" +
      " `aggregateId === order.id`, agnostic to which artifact produced the version). **Building it" +
      " surfaced a THIRD, independent, pre-existing production defect**: `createDocumentRenderer`'s" +
      " `render()` always inserted a document under the TEMPLATE's static `descriptor.retentionClass`," +
      " with no channel for a per-call override — so `planLabResultsRender`'s own `retentionClassOverride`" +
      " (the D23 SUD-redaction retention promotion, computed correctly by the pure decider since M22-T09)" +
      " had nowhere to go, and `packages/forms/src/templates/registry.ts`'s own comment (\"the D23 SUD" +
      ' auto-tag promotes ... at the render layer, not here") named a mechanism that did not exist' +
      " anywhere in the codebase. Fixed the same way F-168 widened the identical seam for `sourceEventId`:" +
      " `RenderPayloadCore` gained an optional `retentionClassOverride` field (`renderer.ts`) that `render()`" +
      " now prefers over the template default; every other caller leaves it unset and is unaffected. **This" +
      " is the same defect a SIBLING dedicated pipeline (`medication-list-bindings.ts`, F-171, two" +
      ' paragraphs up) had already found and explicitly left unfixed** ("one pre-existing platform gap' +
      ' matched for consistency, not newly introduced or fixed") — this pass fixed it instead of matching' +
      " it, since leaving a documented compliance mechanism (42 CFR Part 2 retention) silently inert was" +
      " worse than the small, additive widening. `m11.order.results_received` itself has NO production" +
      " emitter anywhere in this codebase (`LabResultsApplier`, named in the event's own catalog" +
      " description, does not exist — exhaustively grepped), the `m17.caregiver_reminder_due` (F-161)" +
      " shape; likewise M29's own ingest worker (`planLabAttach`) has no production caller, so" +
      " `lab_observation`/`lab_observation_value` rows are seeded directly in the live proof, simulating" +
      ' "M29 has already matched and stored this result" — the real state this consumer reads regardless' +
      " of how the row got there. Proven by `f171-m22-lab-backref.live.test.ts`: a non-SUD result renders" +
      " and stamps `order_record.document_id`; a SUD-class result with no M39 consent redacts and forces" +
      " `compliance_42cfr_part2` retention (now for real, per the renderer fix above); the same SUD-class" +
      " result WITH an active M39 consent does not force that retention; a lab result for an order whose" +
      " FORM had already rendered appends a genuinely new document_version onto the SAME document rather" +
      " than colliding or idempotent-skipping forever; a redelivery of the identical outbox event never" +
      " produces a second version; an observation M29 has not yet resolved defers (retries, never renders)" +
      " rather than dead-lettering on the first miss; and cross-tenant isolation holds. Net: 14 → 13 events" +
      " remain in this group. **F-176 (#248) resolved 6 of the remaining 13 (13 → 7).** `m6.discharge.cosigned` is BOUND: M22 spec §4.11/§7.17 names it, the payload was widened with `admissionId`/`patientId`/`dischargeDate`/`reason`, and a `RequestShape` with `appends: true` renders a new `discharge_summary` version on the SAME `dischargeEventId` (F-168's per-request key; the M6 back-ref stamps only while NULL so v2 never overwrites the v1 link; if `.created` is still undispatched the cosign render becomes v1 and `.created` idempotent-skips, benign). Five were dropped as misdeclared: `m11.order.draft_created` and `m12.medication_order.signature_requested` (the payload carries no form content, and a render here would take the genesis-only key and make the signed `.document_requested` render an `idempotent_skip`), and `m39.consent.expired`/`.recipient_added`/`.recipient_removed` (M22 keeps no signed-URL/subsetter state a push could act on; the real gap — no consent re-check at signed-URL mint — belongs in M22's mint path, not an outbox consumer). Still blocked, unchanged: `m6.transfer.created` (no transfer variant, needs a migration + design call), `m9.assessment.summary_requested` and `m19.triage.summary_requested` (no producer), `m39.consent.revoked` (`media_release` unseeded — superseded below, F-197), and both `*.draft_created_from_extraction` events (DocLens unbuilt). **F-191 (#248) — `m21.supply_request.delivered` is GONE from this group, dropped at the source, not merely re-confirmed.** A scoping-only pass (not a build) checked whether M22's disclaimed 'caregiver-signature flow' was real, buildable infrastructure — and found it was a catalog error instead: M22's own locked spec explicitly disclaims owning signature capture (line 126, \"M22 does not capture signatures — the source module does\"; line 2383 lists it as a non-goal even for M39 consent, the nearest structural analog), no capture route/seam/FormFill consumer exists anywhere in `22-documents/`, and every real signature flow in this codebase (M11/M12 orders, M7/M8/M15 attestations, M39's `ConsentCaptureEvidence`) is captured synchronously inside its OWNING module, never via an M22 outbox consumer. `declaredConsumers` corrected at the source (`events-by-m21.ts`); see that file's own comment for the full citation trail. The underlying gap this surfaced — M21 has no caregiver-signature capture of its own at all, despite a dangling `caregiverSignatureRequestId` column in its own spec (line 1749) that nothing ever wired — stays a real, scoped-but-undecided feature proposal (mirror M39's `captureMethod`/`captureEvidence` shape, ~1 migration + 1 route), not an outbox binding question. **F-192 (#248) — `m6.transfer.created` is GONE from this group too, BOUND, not merely re-confirmed.** The wall every prior pass (F-161/F-162/F-166/F-176) hit was real but narrow: the M22 spec calls the wanted artifact \"discharge_summary (transfer variant)\", and no variant existed. Migration 0267 adds `discharge_summary_transfer` (the F-099/F-144/F-161 additive-enum precedent, a fourth time); a published `PLATFORM_TEMPLATE_TABLE` descriptor and a `REQUEST_SHAPES`/`M22_DOCUMENT_REQUEST_EVENTS` entry follow the identical F-161 M6-CoP/`m7.care_plan.version_signed` SOURCE-event shape (no separate `*.document_requested` sibling — the event name is the template). The payload is widened with `patientId` at both real emit sites (`transferOut`/`transferIn`, `admission-route-service-db.ts`), which already resolve the admission's patient in the same transaction — the F-100 \"every one of these artifacts is patient-scoped by definition\" reasoning, one event over. `transfer_event.document_id` (\"(M22) transfer summary\", unread since M6's schema landed) is now stamped by a new `M6_BACKREF_TARGETS` row. Fires from BOTH directions under the one event/template; content is payload-driven only (`direction`/`effectiveAt`/`otherHospiceCcn`), nothing invented beyond what the catalogued payload carries." +
      " **F-197 (#248) — `m39.consent.revoked` is GONE from this group, corrected not merely re-confirmed.**" +
      ' The prior "`media_release` unseeded" note was stale/unclear; the real gap, found and fixed this' +
      " round, is that M22's §7.16 SUD-consent gate (`consent-gate.ts`'s `resolveSudConsentPresent`) only" +
      " ever ran ONCE, at document RENDER time — nothing re-checked consent at any LATER signed-URL MINT," +
      " so a document rendered while consent was active stayed freely downloadable after a later" +
      " revocation, on both the staff mint path (`signed-url-service.ts`, zero consent check of any kind)" +
      " and the portal mint path (`mintPortalDownloadUrl`'s own SUD gate was coded but wired to always" +
      " short-circuit false, and the production `portalConsent` port fell back to an in-memory stub even" +
      " with a real database configured). Fixed as a mint-time PULL, not a push reaction to `.revoked` —" +
      " the identical reasoning already used to drop this event's siblings `.expired`/`.recipient_added`/" +
      "`.recipient_removed` in F-176. `declaredConsumers` corrected at the source (`events-by-m39.ts`);" +
      " `m5`/`m16`/`m2`/`m31` are unaffected. **F-208 (#248) — `m9.assessment.summary_requested` is BOUND," +
      " GONE from this group.** Both user-decided triggers built: chart-open auto-refresh (freshness-" +
      " throttled, not a new dedup table) and an explicit" +
      " `POST /api/v1/patients/:patientId/assessments/summary/document` download/print action. Both emit" +
      " the real event; M22 renders a new `assessment_summary` document type (migration 0277) as one" +
      " evolving per-patient document — `patientId` is the aggregate, no per-request id on the payload —" +
      " appending a new version per request via F-168's `document_version.source_event_id` idempotency-key" +
      " mechanism, which is what makes the evolving-document interpretation (vs. one-per-snapshot) safe:" +
      " repeated/successive render requests against the same aggregate correctly produce new versions" +
      " instead of silently no-opping. `m12.medication_order.draft_created_from_extraction`," +
      " and `m5.patient.draft_created_from_extraction` stay deferred, unchanged — no producer." +
      " **F-224 (#248) — `m19.triage.summary_requested` is BOUND, GONE from this group.** The user decided its" +
      " producer is an EXPLICIT staff action (not a policy/disposition trigger): `POST" +
      " /api/v1/triage-calls/:triageCallId/request-summary` (`requestSummary`, a new `triage.request_summary`" +
      " permission, Idempotency-Key, the D13 AI-block, per-call ABAC), which emits the event through the real" +
      " catalog-validating publisher with the payload FIXED to carry `recipientKind` (caregiver | attending)" +
      " plus an allowlist of enumerated call facts — never a free-text field, answer or medication." +
      " M22 renders it as `triage_summary_caregiver` / `triage_summary_attending` (migration 0290, two" +
      " additive `document_aggregate_type` values; one document per call per audience, a new version per" +
      " explicit re-request via F-168's source-event-id mechanism) with a real PDF builder" +
      " (`render-pdf/triage-summary-doc.ts`).",
    events: [
      "m12.medication_order.draft_created_from_extraction",
      "m5.patient.draft_created_from_extraction",
    ],
  },
  {
    module: "m14",
    kind: "handlers-unbound",
    reason:
      "M14 has a `consumers/` surface (consumers/index.ts) whose handler code exists and whose dispatcher binding does not reach it. F-104 removed the six §4.5 D8 AUTO-CLOSE events from this group by binding them (`consumers/bindings.ts`) — and by fixing the defect underneath, `idg_action_item.linked_artifact_id` being written by no code path, without which a live handler would have matched nothing forever. " +
      "F-129 (#248) checked every remaining event against M14's own authoritative statement of what it consumes — its §4.5 spec table (mirrored exactly by `consumers/index.ts`'s `M14_OUTBOX_SUBSCRIPTIONS`) and `packages/idg/src/packet/builder.ts`'s typed build-input structs — rather than trusting the producing modules' `declaredConsumers` at face value (the F-101/F-108 precedent, at larger scale). Two results. " +
      "FIRST, 22 pairs were dropped as genuinely misdeclared: M7's 9 problem/goal/intervention/care-plan-version events and M39's 2 DPOA events are redundant with a documented build-time SEAM PULL (`CarePlanSummaryInput`/`PacketCoverInput` in the builder read M7's `CarePlanReader` and M5/M6/M7/M39 fresh per packet, never a push cache); M10's `timepoint_scheduled`/`timepoint_signed` are the same shape for `HopeContextInput`/`HopeTimepointProvider`; M6's `cti.drafted`/`.late_flagged`/`.voided` and `f2f.scheduled`/`.window_missed`/`.window_overridden` are the same shape for `PacketCoverInput`'s `nextRecertDueAt`/`f2fWindowState` (M6 owns CTI/F2F enforcement outright — M14 only ever reads it); `m6.discharge.created` is redundant with `m6.admission.discharged`, M14's own real D9 inclusion-cache subscription on the SAME discharge transaction, carrying every fact D9's effect needs. Fixed at the source in each producing module's `events-by-mNN.ts`, not here. " +
      "SECOND, one real, spec-matching gap the catalog had simply never declared: `m11.order.discontinued` is named by M14's own §4.5 table and `M14_OUTBOX_SUBSCRIPTIONS` for the 'since last IDG' projection cache, and M11's catalog omitted `m14` from `declaredConsumers` entirely — a real subscription a live binding would have had refused by `assertBindableAgainstCatalog`. Added at the source. " +
      "What remains here is the REAL 'since last IDG'/inclusion-cache/M22-back-ref shape M14's own spec names and has not built (9 events: the two M6 inclusion-cache events, M9's `recorded`/`significant_change`, M10's `j2051_trigger_fired`/`sfv_created`, M11's `order.discontinued`, M12's `medication_order.discontinued`, and F-142's `m19.triage_call.care_plan_change_indicated` — the M22 back-ref additionally has no producer, since `m14.packet.document_requested` is catalogued by nobody); plus 5 events F-145 confirmed genuine on decisive producer-module evidence after the originally-ambiguous 22 were finally checked against each producing module's OWN spec rather than left 'kept absent stronger evidence.' " +
      "F-145 (#248) ran that check on all 22, split across five producer-clustered forks. **17 of 22 were genuinely misdeclared, all a single shape repeated at scale — the seam-vs-push trap, the identical F-129 finding for M7/M9/M10 now extended to M6 and all twelve M13 eMAR events**: M13's own D16 publishes `MedicationAdministrationProvider`/`ReconciliationProvider` with M14 named as a read-path consumer for BOTH, and M14's own exhaustive 'Done means' build walkthrough (the eleven seam reads + four Valkey-projected outbox topics) never names a single M13 event — confirmed against M13's own primary 'Consumed by 14' line ('IDG packets show administrations since last IDG via M13's `getAdministrationsSince` seam and missed-dose count since last IDG via the same seam's aggregation projection'), which directly contradicts M13's own looser §4.10 per-event table listing M14 as a consumer on all twelve — the F-101 rule applied to a module's OWN two self-contradicting statements, trusting the decisive one. **This reverses the group's own PRIOR framing**, which had called `m13.scheduled_dose.missed` 'the strongest candidate to eventually bind' on a payload-shape resemblance to `PacketFlaggedEventDigest`'s `missed_dose` kind — a weaker signal than M13's own decisive seam-publication text, now correctly moved to `seamConsumers` alongside its eleven siblings (all twelve, never dropped bare — the seam relationship is real, just not outbox-shaped). Four M6 events (`admission.on_hold`/`.resumed`, `compliance.window.opened`/`.overdue`) had no support in M14's own build-description at all, and `compliance.window.overdue` was contradicted outright by M6's own text assigning the real consumer to M36's escalation chain, not M14 — the strongest form of counter-evidence, not mere silence. `m9.assessment.amended` is a redundant sibling: emitted in the SAME transaction as the correcting row's `m9.assessment.recorded`, M14's own real, live-bound subscription — the corrected value arrives via `.recorded` regardless. **5 of 22 confirmed genuine, no catalog change needed**: `m12.medication_history_pulled` (M12's own spec, twice: 'M14 (IDG packet)' / 'M14 (IDG packet refresh)') and `m39.consent.expiring_soon` (M39's own outbox table: 'M36 (alert), M14 (compliance tile)') — both the F-131 'kept, not dropped' asymmetry; and all three M15 events (`idg_decision.applied`, `plan.bootstrapped`, `plan.version_signed`) — M15's own real §4.10-style outbox table names M14 decisively for all three, the most decisive evidence type this series recognizes. `m15.idg_decision.applied` was checked specifically for the wrong-direction trap (is it just an echo of M14's own outbound `idg.decision_recorded`?) and confirmed genuinely distinct — M15's own inbound acknowledgment that it applied M14's decision, the identical shape M7's own `care_plan.idg_decision_applied` audit event already establishes for the M7/M14 pair. " +
      "F-142 (#248) added a ninth 'since last IDG'-shaped gap, found triaging the (now-deleted) m7 group: `m19.triage_call.care_plan_change_indicated` was declared for m7, but M19's own D8-cascade text (§11) names the real consumer as M14's IDG packet builder — corrected at the source (M19's `declaredConsumers` m7→m14). " +
      "**F-164 (#248) built the six real 'since last IDG' events on a shared per-patient Valkey cache** (`consumers/since-last-idg-cache.ts`, one JSON object per patient, `wardenx:m14:idg:since-last-idg:<patientId>`, 30-day TTL, deduped by the delivering outbox event's own id). M9's two write straight from the payload (`patientId` is present on the wire despite the declared schema omitting it on `.significant_change` — confirmed against the real emit site, not the schema). M10's/M11's/M12's three needed a cross-module fact neither payload carries (`patientId`, plus `orderKind`/`drugName` for the latter two) — resolved via three NEW org-explicit seam functions (`hopeAssessmentPatientIdForOrg`/`orderPatientAndKindForOrg`/`medicationOrderPatientAndDrugForOrg`, the `encounterIdsForVisitsForOrg` (M8) precedent applied to three more modules), injected as ports rather than read off each owning module's schema directly — M14's `dependsOn` is `[1, 7, 8, 36]`, no edge to 9/10/11/12, so a direct Drizzle import would (and, in the build's first draft, briefly did) fail `arch:tables`. **M11's/M12's two `.discontinued` events are a deliberate departure from the seam-vs-push rule this arc otherwise applies**: `PacketOrderChangeDigest`/`PacketMedicationChangeDigest` doc-comment themselves as seam-pull projections (`OrderProvider.getOrdersSince`/`MedicationOrderProvider.getMedicationsSince`), the opposite framing from M9/M10's push-cache comments on the same two files — but the seam AS IMPLEMENTED anchors its filter on a timestamp fixed at order creation/activation and never revisited, so an order created before the packet-build cursor and discontinued after it is invisible to the seam pull regardless of how the read side joins it; the push cache is the only place that fact can come from until the seam's own filter is widened (a separate M11/M12-side gap, reported not fixed). " +
      "**M6's `admission.activated`/`.discharged` and the M15 trio (`idg_decision.applied`/`plan.bootstrapped`/`plan.version_signed`) were investigated fresh and found genuinely AMBIGUOUS, not confidently misdeclared or confidently genuine — left exactly as-is rather than guessed on.** For M6: D9's own rationale table says inclusion is 'computed at build time … via M5's `CaseloadProvider`' (a seam pull) and in the same breath cites '§4.5 (`m6-admission-discharged`)' as consistent with that — but §4.5's own table describes a PUSH mechanism ('mark patient with `discharge_grace_until` … in the inclusion cache') for the identical two events, tracking the 7-day post-discharge wrap-up window `CaseloadProvider`'s 'active caseload right now' answer cannot express on its own (a discharged patient is, by definition, off the active caseload). Two internally-consistent readings of the same module's own spec, not a case where one side is decisively right. For M15: the Lock-status section's one-line 'M14 IDG-packet integration consumes `DisciplinePlanReader` when M14 locks' describes the packet builder's CROSS-DISCIPLINE VIEW mechanism (§1's own text: 'cross-discipline view via `DisciplinePlanReader` for M14 IDG packet') — a different, narrower claim than whether the SAME builder also needs these three push events for a 'since last IDG' delta, which M15's own decisive §2.4/§4.5 event-catalog table names by event with real payloads (`{planId, versionId, idgDecisionId, mutationsApplied}` etc.) and explicit M14 consumers. Both need a dedicated future pass that reads the packet builder's actual read-side requirements rather than either spec fragment in isolation, not a snap drop on the strength of one ambiguous citation. " +
      "**F-167 (#248) ran that dedicated future pass on all 8 remaining events, found none buildable, and resolved the standing AMBIGUITY by finding both of its readings share one root blocker.** Confirmed first that F-164's `consumers/since-last-idg-cache.ts` is the one and only 'since last IDG' cache mechanism in this module — no second, competing cache exists or was built here; every finding below is about whether a REAL READER exists for a write into it, or into any other M14 surface, not about which cache to use. **`m6.admission.activated`/`.discharged` (inclusion cache): confirmed blocked, the ambiguity resolved rather than left open.** Checked whether the M14 packet-BUILD worker D9's 'computed at build time' language depends on actually exists in production: it does not. `apps/backend/src/modules/14-idg/jobs/index.ts`'s own header states M14 ships exactly ONE cron (`idg.review-clock-sweep`) and explicitly documents the T-24h packet-build cron as absent; `idg-route-service-db.ts`'s own header says `idg_patient_packet` 'is built by the §2.4 packet WORKER, not the route lifecycle' and its `buildPackets` handler (read directly) only flips the meeting's status and counts pre-existing packet rows — it builds nothing; a repo-wide grep for `.insert(PKT)`/`.insert(schema.idgPatientPacket)` under `14-idg/` returns zero hits outside test fixtures. So EITHER reading of D9/§4.5 needs the same nonexistent foundation: the PUSH reading (an inclusion cache) has no worker to ever read it, and the PULL reading (a build-time seam call) has no seam to call either — `CaseloadProvider` (`packages/types/src/seams.ts`, checked directly) is `isInCaseload`/`caseloadPatientIds`, both keyed on a CLINICIAN's `userId` and answering only 'right now,' with no location or as-of-date parameter D9's 'active caseload of the meeting's location at scheduled date' needs. Building either a cache-write consumer or a new location/date-scoped seam here would be inventing infrastructure for a worker that has never been written — a whole-module build (the GAP-092 packet-worker gap this same directory's `jobs/index.ts` already documents), not a two-event wiring task, and out of scope. **`m12.medication_history_pulled`: confirmed blocked.** M12's own catalog description (`12-dosespot/events-by-m12.ts`) is 'M14 refreshes the IDG packet' — an invalidation/rebuild trigger shape, not a content-append fact, and there is no packet-build mechanism anywhere to trigger. Checked `SinceLastIdgInput`/`PacketSnapshot` (`packages/idg/src/packet/builder.ts`, `packages/types/src/idg.ts`) directly for a matching slot: none exists — medication HISTORY (an external DoseSpot pull, pre-reconciliation) is a distinct fact from medication ORDER changes (`medicationsChanged`/`PacketMedicationChangeDigest`, already fed by `.discontinued` via F-164's cache and by seam pull for `.signed`/`.active`), and the payload itself (`rowsCreated` count + `sourceJobId`, no drug-level detail) doesn't fit that digest shape regardless. **The M15 trio: confirmed blocked, on a THIRD, sharper reason beyond the push/pull ambiguity.** Checked `idg_decision`'s real schema (`packages/db/src/schema/idg/idg-decisions.ts`) directly: `status` runs `open → emitted → superseded` only — no 'applied'/downstream-application column or table exists anywhere on the M14 side. By contrast M7, M11 and M12 each own THEIR OWN `*_idg_decision_applications` tracking table (`care-plan/idg-decision-applications.ts`, `orders/order-idg-decision-applications.ts`, `dosespot/medication-order-idg-decision-applications.ts`) — M14 has no equivalent, and no M15-owned one exists either (checked `packages/db/src/schema/discipline-plans/`, confirmed absent). None of the sibling M7/M11/M12 'applied' acknowledgment events (e.g. `m7.care_plan.idg_decision_applied`) are consumed by M14 anywhere either — F-145's own 'M7 precedent' citation was evidence the RELATIONSHIP SHAPE is real (a genuine inbound ack, not an echo of M14's own outbound event), not evidence that an M14-side consumption mechanism already exists to extend; no such mechanism exists for any of the four candidate source modules. `plan.bootstrapped`/`.version_signed` were checked against both readings this group's own text left open (a D9-style push cache, or a `DisciplinePlanReader` seam-pull at packet-build time) and both need the same nonexistent packet-build worker the M6 finding above establishes; no PacketSnapshot/SinceLastIdgInput field exists for any discipline-plan fact either (checked `packages/types/src/idg.ts` in full — no M15 field anywhere). The push-vs-pull ambiguity this group's text left open for the M15 trio is therefore moot: neither mechanism exists today, independent of which one D9/M15's spec actually intends. **`m19.triage_call.care_plan_change_indicated`: confirmed blocked**, matching a finding F-164 had already reached but only recorded in a code comment rather than in this registry — `since-last-idg-cache.ts`'s own header names this exact event as 'the exact no builder input slot gap' it declined to invent a fix for. Verified directly: M19's own catalog (`19-oncall/events-by-m19.ts`) describes the consumer as 'M14's IDG packet builder so the next IDG agenda includes it,' and the one structurally similar existing slot, `PacketFlaggedEventDigest.kind`, is a closed union (`'hospitalisation'|'er_visit'|'missed_dose'|'fall'|'infection'`) that does not admit the event's free-form `changeKind` — writing it in would mean widening a shared packet-contract type, a builder-contract design change out of scope for a consumer bind. **`m39.consent.expiring_soon`: confirmed blocked**, and unlike the F-131 'kept, not dropped' asymmetry this group has otherwise relied on, here there is no code-level target of ANY kind on the consuming side to bind to. M39's own outbox table names M14 as '(compliance tile)', but M14's own spec — grepped in full for 'consent', 'expir' and 'compliance tile' — never once mentions a compliance tile, consent-expiry tracking, or any UI/data concept it would populate, and no such column, table, cache key or frontend screen exists anywhere in the built M14 surface (checked `packages/db/src/schema/idg/` and the design corpus). A bare aspirational table-cell citation with nothing on the receiving side to extend is not enough to build against without inventing a new feature. **Net: 0 bound, 0 dropped — all 8 events remain, unchanged, with their blockers now precise rather than ambiguous.** The residual set collapses to two shared root causes: (1) the M14 §2.4 T-24h packet-build worker has never been written in production (only the pure `builder.ts` contract + F-164's cache-WRITING consumers exist; nothing ever reads the cache, resolves inclusion, or calls the pure builder) — a whole-module build, correctly out of scope here; and (2) for the facts that would not fit even once a worker exists (M19's free-form `changeKind`, M12's history-pull metadata, M39's undefined 'compliance tile'), no typed packet-contract slot exists, and this pass declines to invent one unilaterally — the same restraint F-164 itself already exercised for `m9.assessment.recorded`'s own borderline case. " +
      "**F-169 (#248) re-checked all five underlying facts fresh (2026-09-29), one round later, nothing shifted.** `jobs/index.ts` still ships exactly the one `idg.review-clock-sweep` cron; `buildPackets` still only flips meeting status and counts pre-existing packet rows, no INSERT into `idg_patient_packet` anywhere under `14-idg/` outside test fixtures; `CaseloadProvider` (`packages/types/src/seams.ts`) is still `isInCaseload`/`caseloadPatientIds`, clinician-keyed, no location/as-of-date parameter. `packages/types/src/idg.ts` still has no medication-history slot (`PacketMedicationChangeDigest` unchanged) and no M15 field of any kind. `idg_decision.status` (`packages/db/src/schema/idg/idg-decisions.ts`) is still `open → emitted → superseded`, no 'applied' state; `packages/db/src/schema/discipline-plans/` still has no `*_idg_decision_applications` table (M7/M11/M12 each still own theirs, M14/M15 still own neither). `PacketFlaggedEventDigest.kind` (`packages/types/src/idg.ts`) is still the same closed 5-member union, no `changeKind` slot. M14's own spec still has zero hits for 'compliance tile'/'consent'/'expir'. The one commit to land in this module since F-167 (F-168, `a5290539`) touched `idg-route-service-db.ts` and `events-by-m14.ts` only to widen M14's OWN `minutes.amended` render-request payload (M14 as document-request PRODUCER for M22) — unrelated to M14 as CONSUMER of these 8 events; no packet-build worker, no packet-contract slot, no schema change touched any of the five facts above. Net: 0 bound, 0 dropped, all 8 events remain exactly as F-167 left them. " +
      "**F-171 (#248) built the T-24h packet-build worker for real, and — checked directly, not assumed — its existence does not unblock any of the 8, for two different (and now precisely dated) reasons.** `apps/backend/src/modules/14-idg/jobs/{schedule-materialise,packet-build}.ts` are new: `runScheduleMaterialiseCron` (§7.1 W-SCH-01) materializes real `idg_meeting` rows from `idg_recurring_policy` (idempotent re-run), and `runPacketBuildCron` (§7.2 W-PKT-01 / §4.9.1 `tminus-24h-build`) finds every meeting due within the T-24h lookahead, resolves the §2.3 D9 inclusion set, and INSERTs a real `idg_patient_packet` row per included patient from real M5 (patient identity)/M6 (siting + current LOC)/M7 (care-plan summary + terminal diagnosis + SUD flag)/M8 (signed encounters since cursor) facts plus the F-164 cache, transitioning the meeting `scheduled → packets_building → packets_ready` and emitting `m14.packets.build_started`/`.packet.render_requested`/`.packets.ready` — proven end to end against a real, RLS-enforced Postgres (`m14-packet-build.live.test.ts`, 5/5: real materialization, a real built packet with real cover facts, the §2.3 D9 wrap-up-window boundary, per-patient failure isolation via `m14.packets.build_failed_for_patient`, and cross-tenant isolation). **This resolves F-167's own standing ambiguity for `m6.admission.activated`/`.discharged` decisively, in favor of PULL — and closing that ambiguity is why the pair stays unbound, not a reason to bind it.** D9 inclusion is answered by a NEW M6 org-explicit seam (`idgPacketInclusionForOrg`, `06-admission/seams/drizzle-store.ts`) that reads `admission.location_id`/`.status`/`.discharged_at` directly at build time — never `CaseloadProvider` (confirmed, again, to have no location/date parameter) and never a push cache. The worker needs no per-admission-lifecycle cache to invalidate, so there is nothing for these two events to write into; F-167's 'either reading needs infrastructure that doesn't exist' is now half resolved (the PULL half, built) and half moot (the PUSH half, never needed). **The other 5 stay blocked, unchanged in substance, because building the worker deliberately never touched the one thing each of them needs**: no field was added to `PacketFlaggedEventDigest.kind` (`m19.triage_call.care_plan_change_indicated`), no medication-history slot was added to `SinceLastIdgInput`/`PacketSnapshot` (`m12.medication_history_pulled`), no 'applied' state or tracking table was added anywhere M14/M15-side (`m15.idg_decision.applied`/`.plan.bootstrapped`/`.plan.version_signed`), and no compliance-tile concept was invented (`m39.consent.expiring_soon`) — each is exactly the 'do NOT invent a slot the spec doesn't describe' restraint this pass was explicitly held to, re-confirmed by re-reading `packages/types/src/idg.ts` and `packages/db/src/schema/idg/idg-decisions.ts` after the build landed: byte-identical to F-169's own citations. Net: 0 bound, 0 dropped — all 8 events remain, but the group's reason is now a closed case on the worker question (it exists, it does not help) rather than an open one. **F-176 (#248) resolved 4 of the 8 (8 → 4).** `m6.admission.activated`/`.discharged` dropped: F-171's packet-build worker answers §2.3 D9 inclusion by PULL (`idgPacketInclusionForOrg`), so no inclusion cache exists for the push to update (also removed from `M14_OUTBOX_SUBSCRIPTIONS`); `m15.plan.bootstrapped`/`.version_signed` moved to `seamConsumers` (M14's spec never names M15; M15's own spec makes the packet integration a `DisciplinePlanReader` pull). Remaining 4 stay blocked: `m15.idg_decision.applied` (no M15 intake consumer, no M14 'applied' state), `m12.medication_history_pulled` and `m39.consent.expiring_soon` (no producer), `m19.triage_call.care_plan_change_indicated` (emitted, but consuming it needs a new packet-input slot — a contract decision)." +
      "**F-218 (#248) — `m19.triage_call.care_plan_change_indicated` is RESOLVED as a seam pull and LEFT this group.** The user decided the 'contract decision' above: `PacketFlaggedEventDigest.kind` is widened with `triage_care_plan_change`, and the packet worker pulls it through a fourth `flaggedEventSources` entry (`idgTriageCarePlanChangesForOrg`, M19 org-explicit published read, wired in `apps/backend/src/index.ts` and `scripts/db/run-idg-packet-build.ts`). M19's catalog moved `m14` from `declaredConsumers` to `seamConsumers`; 3 events remain here, unchanged." +
      " **F-230 (#248) — `m12.medication_history_pulled` is RESOLVED as a seam pull and LEFT this group (3 → 2 left after F-218; now `m15.idg_decision.applied` and `m39.consent.expiring_soon` only).** F-167/F-171's two blockers are both gone: the packet-build worker exists (F-171) and a typed medication-history slot now exists — `PacketSnapshot.medicationHistory` (`packages/types/src/idg.ts`, `PacketMedicationHistory`: `not_pulled | none_available | available` + a count + the pull instant, never a drug name), folded through `buildPacketSnapshot`, redacted (count zeroed) on the Part 2 read path, projected on the packet read model (`externalMedicationHistory`) and the PDF. The F-101 rule decided push-vs-pull: M14's OWN spec builds the packet by seam reads at build time and never names this event (its §4.5 table lists only `m12.medication_order.signed/active/discontinued`), while M12's producer text ('M14 refreshes the IDG packet') is the weaker, producer-side guess — so the binding is a PULL: M12 publishes the org-explicit batched `idgMedicationHistoryForOrg` seam (reads only the `medication_history_pull` ledger), wired in `apps/backend/src/index.ts` as the packet worker's `medicationHistory` port. M12's catalog moved `m14` from `declaredConsumers` to `seamConsumers`. The producer side is real but vendor-gated: `ingestPullResult` (`12-dosespot/history/ingest.ts`) is folded into the MedHx-fetch worker and emits this event only from a real `DoseSpotClient.pullMedicationHistory` result; with the production client still the unbound deny-stub no pull is ever ingested, so every packet honestly reads `not_pulled` (never 'no external history'). A packet frozen before the next rebuild does not reflect a pull that lands later — the same staleness every seam-pulled slot has; a pre-meeting rebuild picks it up.",
    events: ["m15.idg_decision.applied"],
  },
  // F-115 (#248) — the `m28` group (52 pairs) is GONE, not merely emptied. M28's FHIR gateway resolves
  // every seam it reads (M5/M6/M7/M8/M11/M12/M13) fresh at REQUEST time (§164.528 D3, F-035) and holds no
  // cached/derived state any of these events would ever need to invalidate — it never subscribes to
  // anything, on any topic, and the "no consumer directory … forward declarations against a subscriber
  // that does not exist" reason was correct about the SURFACE and wrong about the CONCLUSION: the
  // declarations were not future work, they were never going to be true. All 52 `m28` entries on the
  // `declaredConsumers` catalog have been removed (each event's own `events-by-mNN.ts`), leaving nothing
  // to defer.
  // F-164 (#248) — the `m23` group is GONE, not merely emptied. `m25.taxonomy.unmapped_code_observed`,
  // the group's last remaining pair (M23's own §11.A/D13 30-day-rolling-occurrence / 50-threshold alert),
  // is now bound: a new per-row `unmapped_taxonomy_occurrence` table (migration 0255 — one row per
  // delivered occurrence rather than a maintained counter, since a rolling window needs individual rows to
  // age OUT, which a counter can never express), idempotent on `(organization_id, source_event_id)`, and a
  // new consumer that inserts the occurrence then dispatches the existing `WorkerAlertPort` → M36
  // `AlertEmitter` seam (the same mechanism M23's own cron alerts already use — no new alert-delivery
  // mechanism invented) once the org's rolling 30-day count for that CARC code exceeds 50.
  // F-207 (#248) — the `m27` group is GONE, not merely emptied. `m21.supply_request.invoice_accrued`/
  // `.invoice_reconciled`, the group's last remaining pair, are now bound. F-130/F-167/F-174 sharpened the
  // real blocker over three passes: M27's expense-input model is GL-account-level and period-aggregated
  // (`trial_balance_import`/`cost_center_mapping`/Worksheet A), with no per-transaction accrual precedent
  // except `bad_debt_record` (scoped to one already-created cost report) and no fiscal-year field on
  // either M21 payload. The user has since decided this as a 4th cost-basis precedence tier, additive to
  // D17's M13 administration -> M12 ordered -> manual entry chain (M27 spec D17), not a replacement of the
  // GL-mapped Worksheet A figure. Built: a new `vendor_invoice_line` table (migration 0276) and
  // `buildM27VendorInvoiceConsumer`, which resolves the fiscal-year `cost_report` by
  // `(providerEntityId, factDate)`, inserts an idempotent accrual row (`ON CONFLICT DO NOTHING`), and
  // updates the same row on reconciliation guarded on `status = 'accrued'` — dead-lettering (not guessing)
  // when a fact falls outside every open report's window.
  // F-164 (#248) — the `m26` group is GONE, not merely emptied. `m25.remittance.claim_recouped`, the
  // group's last remaining pair, is now bound. The real blocker was three missing facts, not the two the
  // prior reason named: `patientId` was genuinely absent from the payload; `priorPaidAmountCents` was
  // never the right field to blame (`handleClaimReversed`'s `cents()` helper is a passthrough, not a
  // dollars→cents conversion, so the real fix is a payload field ALREADY in cents, not a smarter reader);
  // and `cap_beneficiary_accrual_line.service_from`/`.service_to` (NOT NULL) were also missing, found only
  // by tracing the real insert path. Fixed by widening `m25.remittance.claim_recouped`'s payload at its one
  // real emit site (`patientId` via the already-in-scope M23 `ClaimMatchCandidateProvider` seam —
  // `postAdjustments`'s own PR-ledger seed already reads it two functions up in the same file —
  // `recoupedAmountCents` computed directly from the same float dollars the existing `recoupedAmount`
  // string already carries, `serviceFrom`/`serviceTo` from the 835's own optional DTM claim-service-period
  // dates, honestly `null` when the payer's 835 omits them) and routing it to the SAME `record-reversal-line`
  // action `m23.claim.replaced`/`.voided` already use. `m23.claim.replaced`/`.voided` themselves stay a
  // documented, pre-existing no-op independent of this fix — neither of THEIR payloads carries `patientId`
  // or any amount field under any of the names `handleClaimReversed` reads; a future pass could widen them
  // the same way, using M23's own claim row (already in hand at their emit site, no cross-module seam call
  // needed).
  // F-215 (#248) — the m17 group's last pair (`m20.safety.high_risk_area_entered`) is dropped at the producing
  // catalog entry (M17's spec never mentions it; no producer); the group is deleted outright.
  {
    module: "m16",
    kind: "handlers-unbound",
    reason:
      'F-159 (#248) built two of the four F-153 left blocked, after checking both prior findings against the actual code rather than re-asserting them. `m39.consent.signed` is now a live consumer (`outbox-consumers/m39-consent-signed.ts`, the §4.5 "post-death-grant handler"): two of the three prior blockers didn\'t hold up — `appendScore`\'s membership restriction is a TS-parameter-type restriction on that one private closure, not a mechanism requirement (`scoreBereavementRisk` itself takes a nullable `assessedByUserId`, and the score table\'s own schema comment says "NULL for the cron/system scorer"), and the M38 relationship check the effect list needs is already performed at contact PROPOSAL time, not confirm time — only the SUD-disclosure gate (an M15 seam read) was real, fixed by wrapping the handler in `runWithRequestContext` (the F-158 M25 precedent) since that seam\'s Drizzle backing throws outside a request scope. **Verifying this build found a real, pre-existing production bug it had faithfully copied from the private `appendScore` it reimplements**: `BereavementRosterEvidence`\'s real fields are `isPrimaryCaregiver`/`enrolledSurvivorCount`, and both the new consumer and the ALREADY-SHIPPED `appendScore` (`routes/write-service-drizzle.ts`) were constructing `{activeContactCount, relationshipCode}` under an `as never` cast — so `deriveRiskFactors` read `undefined` for both fields, always resolving `primaryCaregiverRole` as a definite non-caregiver (never falling back to the MSW-derived value its own `!== null` check exists to permit) and always resolving the roster half of `socialIsolation` as `false` (`undefined < number` is always false in JS) on every score ever appended through the real HTTP route. Fixed in both places: `enrolledSurvivorCount` is the same already-computed roster count under its correct name, and `isPrimaryCaregiver` is honestly `null` (no bound seam resolves M5\'s `patient_caregiver.is_primary`, the extract.ts header\'s own "KNOWN GAP" pattern) rather than guessed. `m5.patient.bereavement_opt_out_changed` is now a live consumer (`outbox-consumers/m5-patient-opt-out-changed.ts`, the §2.6/D9 patient-level opt-out cascade): the prior finding ("the skip branch has no route case to mirror, the close_early branch needs two private closures") was factually accurate but didn\'t block a build — both closures are small, self-contained SQL with no seam call and no membership requirement, reimplemented locally exactly mirroring the real production queries field-for-field. **2 stay genuinely blocked, both re-checked and found deeper than previously stated**: `m37.ipu_admission.death_recorded` — the prior "no bridging seam" framing was solvable on inspection (`ipu_admission` carries both `patient_id` and `admission_id` as plain columns), but that doesn\'t matter because the event has NO PRODUCER anywhere in the codebase — `transitionAdmission(..., {type: "recordDeath"})` is called nowhere outside its own unit test, and the M6-side consumer that would drive it (`m6-discharge-death.ts`, named in M37\'s own §4.5 table) was never built either; also functionally redundant even if built, since M16 already receives the IPU death fact through two already-built paths (`m6.discharge.death` primary intake, `m6.admission.discharged` reason=death secondary verifier). `m6.discharge.cosigned` — confirmed exactly as previously stated: the REAL catalogued payload (`{dischargeEventId, medicalDirectorCosignedAt}`) is a completely different event from what `decideCosignReceipt` needs (`{sourceProposalId, cosignedAt, medicalDirectorMembershipId}`) — this is the route-40 for-cause discharge cosign, not an external-source-death cosign release, and `discharge_event` genuinely has no source/cosign columns to ever populate the latter.' +
      ' **F-167 (#248) re-verified both events fresh against current code rather than re-asserting F-159\'s findings, and both hold unchanged.** `m37.ipu_admission.death_recorded`: `transitionAdmission(..., {type: "recordDeath"})` (`packages/inpatient/src/machines/ipu-admission.ts`) is still called nowhere outside its own unit test (`packages/inpatient/__tests__/ipu-admission.test.ts`) — the M6-side consumer that would drive it, `37-ipu/consumers/m6-discharge-death.ts` (named in M37\'s own §4.5 table, and in its already-built sibling `37-ipu/consumers/m6-admission-discharged.ts`\'s own header as "the SEPARATE (still catalog-unbindable...) consumer"), does not exist, and `m6.discharge.death`\'s own catalog entry (`06-admission/events-by-m6.ts`) still declares only `["m5"]` — m37 is not a declared consumer. Building that M37-side producer is out of scope for binding an M16 consumer and would not change the outcome regardless: M16 already receives every IPU death through two live-bound paths, confirmed by direct read of both files — `16-bereavement/outbox-consumers/m6-bereavement-eligible.ts` (the primary `m6.bereavement.eligible` intake) and `m6-admission-discharged-death.ts` (the documented "secondary verifier (redundant safety net)" on `m6.admission.discharged` reason=\'death\') — so a third path off `death_recorded` would be strictly redundant even once built. `m6.discharge.cosigned`: the real catalogued payload is still exactly `{dischargeEventId, medicalDirectorCosignedAt}`, emitted from `cosignDischarge` (`06-admission/admission-route-service-db.ts:5019`, the route-40 for-cause-discharge medical-director cosign), while `decideCosignReceipt` (`16-bereavement/consumers/m6-eligibility.ts`) still requires `{sourceProposalId, cosignedAt, medicalDirectorMembershipId}` for its D18 external-source-plan gate release — confirmed `discharge_event`\'s real schema (`packages/db/src/schema/admission/discharge-events.ts`) carries no source/proposal/cosign columns of any kind. No files changed; both stay genuinely blocked exactly as previously stated.' +
      " **F-172 (#248) — `m37.ipu_admission.death_recorded` is GONE from this group, not merely bound.** The real gap was the missing M6-side producer this reason has named since F-159: `transitionAdmission(..., {type: \"recordDeath\"})` now has its first real caller, `37-ipu/consumers/m6-discharge-death.ts`, bound live on `m6.discharge.death` (widened at the source with `deathCertifierId` — M37's `ipu_body_release.pronouncing_physician_id`, NOT NULL — already a required fact at that event's one real emit site, no new seam needed). But the redundancy half of this group's own long-standing finding was RIGHT, checked a third time by direct read rather than re-asserted: M16's `m6-bereavement-eligible.ts`/`m6-admission-discharged-death.ts` are both keyed off the M6 admission, not M37's IPU admission, and both already fire from the identical `m6.discharge.death` transaction this new M37 consumer itself reacts to — so `death_recorded` would arrive no earlier and carry no fact M16 doesn't already have. `m16` is dropped from `death_recorded`'s `declaredConsumers` at the source (`events-by-m37.ts`), the F-100/F-117/F-134 redundant-sibling shape, rather than bound to a consumer that would always no-op; `m30` stays declared there (F-149's finding, unrelated to this build). No M16 consumer was written for this event, and none should be.",
    events: ["m6.discharge.cosigned"],
  },
  // F-158 (#248) — the `m25` group is GONE, not merely emptied. Both remaining pairs are now BUILT:
  // `m23.claim.rejected` and `m18.evv.aggregator_rejected` each seed a real `denial_case` row via
  // `buildM23ClaimRejectedConsumer`/`buildM18EvvAggregatorRejectedConsumer`
  // (`25-remittance/outbox-consumers/`). The two schema gaps F-153 found (no unique index backing
  // either idempotency key shape; `DenialSeedStore.seedDenial` had no `taxonomyStatus` field) are
  // fixed: migration 0249 adds `denial_case.source_idempotency_key` + a plain
  // `UNIQUE(organization_id, source_idempotency_key)` constraint (Postgres's NULL-distinctness lets
  // the pre-existing `remittance_adjustment`-sourced rows, which never set the column, coexist with no
  // partial `WHERE` needed), and both handlers now resolve `taxonomyStatus` through a new
  // `resolveDenialCategory` helper that reuses the existing `effectiveCategory` CARC-category
  // resolution rather than re-deriving it. Building it surfaced a third, undocumented blocker: neither
  // catalogued payload carries `providerEntityId`, which `denial_case` requires NOT NULL — resolved
  // per event: M23's via a direct `@wardenx/billing` `ClaimRepository.findById` read (legal — M25's
  // `dependsOn` includes 23); M18's via M17's `VisitReader` seam, wrapped in `runWithRequestContext`
  // since `SchedulingSeamStore.visitById` opens `withOrgContextFromRequest` and a dispatcher tick is
  // not a request (the same F-118 fix `19-oncall`/`20-field-safety` already apply for this identical
  // M17 dependency). `denial_case` itself has no document-reference column at all (checked directly,
  // not assumed), so `handlers.ts`'s header claim of a "resolution_letter ref" back-ref stays
  // aspirational — reported, not built, since neither target event needed it.
  // F-225 (#248) — the `m31` group is GONE, not merely emptied (the F-198 `m11` / F-115 `m28` shape). Its last
  // pair, `m22.document.rendered`, is DROPPED at the source (events-by-m22.ts): M31 answers "what can this
  // account see" by SEAM PULL (`PortalDocumentReader.documentsForPatient`), and the approved drop's
  // accounting premise — that M4/M22 audit covers portal document disclosures — was made TRUE by F-225
  // (the portal mint now appends a `document_access_log` row; the route's M4 read-audit carries the document
  // id and fires only on an actual mint). Full per-pair history of this group (F-139..F-176, F-220..F-225):
  // docs/history/m31-portal-deferrals.md + docs/history/outbox-bindings-*.md.
  // F-198 (#248) — the `m11` group is GONE, not merely emptied (the F-115/F-164 m28/m23 shape). Its last
  // two pairs, `m39.consent.dpoa.agent_appointed`/`.agent_removed`, are DROPPED — the last holdout of the
  // M7/M14 pattern already established (F-129/F-142 dropped both of those on the strength of a real,
  // documented pull alternative each module had built: M7's write-time `acting_consent_id` attribution,
  // M14's build-time packet read). M11 has neither: every order in M11's own catalog (`events-by-m11.ts`)
  // carries only `orderingPhysicianMdmId`/`certifyingPhysicianMdmId` — every order is physician-signed,
  // never patient/representative-signed — and an exhaustive grep of `11-orders/` and `packages/orders/`
  // for any consent/authorization/decision-making concept returns nothing. There is no mechanism, at
  // write time or read time, for "DPOA attribution refresh" to attach to. `declaredConsumers` corrected
  // at the source (`events-by-m39.ts`). The group's own long history (F-137 through F-177) — the M21
  // supply-cancellation split, the M7 intervention-linkage drop, the M29 lab-transmission-applier build —
  // stays in `git log`/`docs/history/outbox-248-builds.md` rather than repeated here now that nothing in
  // this group remains open.
  // F-216 (#248) — the m5 group (its last pair, `m39.consent.expired`) is GONE: M39 now has a real producer (the
  // hourly `m39.consent_expiration` cron, `39-consent/jobs/`) and M5's `m39-consent-privacy` consumer binds the event
  // (a lapsed Part-2 consent re-restricts the persisted `sud` flag; see the consumer header for the renewal-safety rule).
  // F-166 (#248) — the m13 group (4 pairs, all M21 comfort-kit events) is now FULLY RESOLVED and
  // deleted from this registry outright, the F-132/F-155(#m35)/etc. "group empties → delete, don't leave
  // a hollow entry" precedent. Both real blockers this group's own text had accumulated across F-140/
  // F-159/F-166 are fixed, not merely re-scoped a fourth time:
  //   1. `m21.comfort_kit.returned` double-emission (`21-supplies/routes/write-service-drizzle.ts`'s
  //      `createReturn`, which published this event at return-REQUEST time with placeholder empty-string
  //      `disposalMethod`/`reconciledByMembershipId`) is DELETED at the source — checked against M21's
  //      own spec (WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md:48) first, which is
  //      unambiguous that `.returned` fires only at reconciliation; no `.return_requested` (or any other
  //      spelling) event was invented in its place, because no consumer anywhere needs a "return was
  //      requested" signal (`comfort_kit_deployment.disposal_status` has no state between
  //      `return_required` and `returned` to carry one) — inventing an unconsumed event would have been
  //      the identical mistake being fixed, restated. `.returned`'s only real emission is now
  //      `reconcileReturn`'s own `{ kind: "outbox", event: "m21.comfort_kit.returned" }` effect
  //      (`21-supplies/lifecycle/return.ts`), which fires once a return actually reaches `reconciled`.
  //   2. The nullable-`medicationOrderId` gap (`ComfortKitDispatchedContentPayload.medicationOrderId`,
  //      null for an IPU-stock-kit-on-room line with no per-patient order — a real, documented M21
  //      business concept, `WARDENX_MODULE_21...md:58`) was investigated fresh rather than re-asserted:
  //      confirmed, by reading every M13 table (`administration_record`, `comfort_kit_drawdown`) and the
  //      whole pure `@wardenx/emar` comfort-kit core, that NO precedent anywhere represents an order-less
  //      drawdown/administration — inventing one now would be deciding unreviewed DEA-adjacent
  //      controlled-substance-accounting semantics on the fly (the F-102 "a guessed provider entity is a
  //      mis-stated cost report" lesson one module over). Resolved by SCOPING rather than guessing: the
  //      four new consumers (`13-emar/outbox-consumers/m21-comfort-kit-{deployed,replenished,returned,
  //      return-reconciliation}.ts`) track every ORDER-LINKED line for real — the documented "typical
  //      case" per M21's own spec, a comfort-kit-deploy with the platform-floor medications prescribed at
  //      admission — and DELIBERATELY, VISIBLY skip a null-order line (reported via
  //      `skippedFloorStockLineCount` on the `m13.comfort_kit.deployed` ack, never silently dropped) — a
  //      real, honestly-reported gap (per-line floor-stock tracking), not a fabricated schema fix.
  // All four events are now live-bound: `m13.comfort_kit.deployed` completes a handshake M21's own
  // `buildM21ComfortKitDeploymentAckConsumer` (F-153) had sat waiting on, unreachable, since it was
  // built — nothing had ever published the event it subscribes to. A new pure `applyKitReplenishment`
  // (`@wardenx/emar`) fills the one genuine gap in the domain core (no function existed for "apply a
  // physically-arrived replenishment to a drawdown"), capped at `expected_quantity` rather than allowed
  // to overshoot. Migration 0259 adds `comfort_kit_deployment`'s first-ever idempotency key
  // (`(organization_id, m21_supply_dispatch_id)`, NULLS DISTINCT) — the table had no live writer before
  // this pass, so no redelivery guard had ever been needed. `M13_OUTBOX_SUBSCRIPTIONS`
  // (`13-emar/consumers/index.ts`) previously named only two of the four M21 events at all — corrected
  // in the same change, the two missing entries (`.replenished`/`.return_reconciliation`) were simply
  // never listed, not merely unbound. Proven by `m13-comfort-kit-deployment.live.test.ts` against a real
  // disposable Postgres: an order-linked deployment creates the deployment + drawdown rows and acks
  // M21's dispatch link for real end to end; a floor-stock-only line is skipped and reported, never
  // fabricated; a redelivery of `.deployed_at_patient` is a true no-op; a replenishment tops up capped at
  // `expected_quantity`; a reconciled return flips disposal status via `.returned` alone (never at
  // request time — `createReturn` no longer emits it); `.return_reconciliation` closes each drawdown's
  // `final_remaining_quantity_at_return`, flags a ≥5% controlled-substance delta via
  // `m13.comfort_kit.controlled_substance_discrepancy`, and emits the aggregate `m13.comfort_kit.returned`
  // ack; and cross-tenant isolation holds throughout.
  {
    module: "m21",
    kind: "handlers-unbound",
    reason:
      "F-153 (#248) built live bindings for 2 of the 4 `consumers/m13-comfort-kit.ts` deciders: `m13.comfort_kit.deployed` (§2.5 deployment-ack, resolved by patient+admission — the whole point of the ack is that the M13 deploymentId link does not exist yet) and `.return_required` (§2.6 chain-of-custody return open) are now live in `outbox-consumers/m13-comfort-kit-cascade.ts`. **`m11.order.signed` is removed outright, not bound**: it was misdeclared, not merely unbound — redundant with the co-emitted, more specific `m11.order.supply_fulfillment_requested` sibling (same transaction, `emitDownstreamSignedEvent`), the F-117/F-101 co-emission shape; dropped from `events-by-m11.ts`'s `declaredConsumers` at the source. **F-161 (#248) built `m13.comfort_kit.replenishment_needed` (§2.1 intake)**: extracted the shared `insertRequest` write path (`write-service-drizzle.ts`'s `createDirect` seam call) to module scope as `insertSupplyRequest`, taking an explicit `outbox` port parameter instead of closing over one — the F-102 `patchSupplyRequest` precedent applied to the create side. The consumer resolves both the per-line pharmacy identity (from the original `comfort_kit_dispatched_content` dispatch row) and the delivery address (reused verbatim from the dispatch's originating `supply_request.data.deliveryAddress`) from M21's own tables, since M13's payload carries neither the full `ComfortKitReplenishRequestDataSchema` per-line pharmacy identity nor a delivery-address snapshot. An IPU-room-deployed kit's originating request carries no delivery address at all (optional/omitted for `ipu_room`) while the replenish schema requires one unconditionally — the consumer refuses (`M21_REPLENISHMENT_ADDRESS_UNRESOLVED`) rather than fabricate a street address on a DEA-perpetual-log-adjacent record, a real narrow schema gap flagged for a future scoped fix. **3 pairs remain genuinely blocked**: `m11.order.supply_fulfillment_requested` — still blocked, not misdeclared — its own IO resolver (`consumers/order-context.ts`) states no platform seam answers 'which Location serves this patient'; `m13.comfort_kit.controlled_substance_discrepancy` (§4.5.1) is payload-BLOCKED — the catalogued `m21.controlled_substance.discrepancy_detected` schema requires a non-nullable `returnId` + full custody chain, the shape a RECONCILIATION-time discrepancy carries, while M13's bedside re-emit fires at drug ADMINISTRATION time before any `comfort_kit_return` row exists; `m12.medication_order.dispensed_at_pharmacy` has no decider built anywhere in M21 (only referenced by spec line 66) — needs new DoseSpot-dispensed business logic, a correlation mechanism linking a pending `supply_request` to a specific M12 transmission id (none exists), and a dispatch-creation write path that bypasses `createDispatch`'s hub-fulfillment-only PAR-stock/dispatcher-eligibility logic. **F-166 (#248) re-checked all 3 against the current code rather than the prior finding, and found the `m11.order.supply_fulfillment_requested` serving-Location claim was stale — but fixing it surfaced a deeper, previously-undiscovered blocker that keeps the pair unbound anyway.** `AdmissionSummary.locationId` (task-11's M6 activation-siting anchor — the SAME fact `05-patient/outbox-consumers/m6-admission-activated.ts` denormalizes onto `patient.location_id`, F-152) has been on the `getAdmissionStatusReader().getAdmissionSummary` return type this file's own `resolveSupplyOrderContext` already calls for `admission`, unread — `order-context.ts`'s `resolveServingLocation` port (and its 'no platform seam answers this' header) is now GONE, not merely fixed in place: `toAdmissionContext` projects `summary.locationId` directly and `servingLocationId` reads `admission.locationId`, no second read, no port. **That resolves the location half honestly, but checking whether a consumer could actually be BOUND on top of it found the payload assembly was blocked at a level deeper than location for all three M11 sub-kinds, checked against each kind's real D1 TypeBox** (`packages/supplies/src/kinds/{dme,supply,comfort-kit-deploy}/typebox.ts`) **and each kind's real M11 order-data contract** (`packages/orders/src/kinds.ts`, `ORDER_KIND_CONTRACT_STATUS`): `dme`'s `DmeRequestDataSchema` requires `skuId` (an M21 `supply_item` uuid), `hcpcs` (an M38-resolved code) and `deliveryAddress: PatientAddressSnapshotSchema` (`line1`/`city`/`state`/`postalCode`/`capturedAt`) all NON-OPTIONAL, while M11's `dme` order kind is `contract_not_published` — a genuinely unconstrained `additionalProperties: true` blob with no guaranteed shape at all, confirmed by direct read rather than inferred from the contract-status label; `supply`'s schema is equally strict (`deliveryAddress` required, no optional escape) over the same unpublished `contract_not_published` M11 shape; `comfort_kit`'s M11 canonical schema (`canonical_contract_found`, so genuinely the full shape — `order_record.data` is validated against it at draft time, per `emitDownstreamSignedEvent`'s own comment) is exactly `{kitSku, deploymentSite, preferredDeliveryWindow?, notes?}`, while M21's `ComfortKitDeployRequestDataSchema` requires `contents: Type.Array(ComfortKitMedicationContentSchema, {minItems:…})` (a real per-medication line list) and `pharmacyDispatchMode` — fields the M11 side has never captured. No published M5 seam closes the gap either: `PatientAddressReader` (checked against its real interface, and against M12's own already-documented finding for the identical need in `12-dosespot/jobs/vendor-boundary.ts`) exposes only a 2-letter state code or a kind/facilityId/postalCode triple, never a full street address. So a bound consumer would throw `ValidationError` at `insertSupplyRequest`'s D1 gate on essentially every real `dme`/`supply`/`comfort_kit` delivery — dead-lettering by construction rather than filling a request — which is not a working binding, it is the F-150 'wiring a line to a house that was never built' shape restated at the SCHEMA level instead of the seam level. Not bound; the location-resolver fix is kept as real, verified, isolated progress (`consumers/order-context.ts`, `consumers/m11-orders.ts`) because it is independently correct and narrows the pair's true remaining gap precisely, but the pair itself stays deferred. `m12.medication_order.dispensed_at_pharmacy` and `m13.comfort_kit.controlled_substance_discrepancy` were re-verified unchanged: no DoseSpot webhook handler or credential resolver exists anywhere in the repository (`createUnboundDoseSpotClient` is a confirmed fail-closed stub, no `DOSESPOT_*` env var anywhere) so the first event has no producer and no M21 decider either; the second event's catalogued schema (`returnId` + full `returnedContent` reconciliation-math array) still cannot be satisfied by `decideControlledSubstanceReemit`'s own pure output (`ReemittedDiscrepantLine`, no `returnId`, no reconciliation quantities), confirmed by direct comparison of both TypeBox shapes. **F-168 (#248) re-checked fresh on 2026-09-28, all 3 specific blocking facts confirmed unchanged.** `dme`/`supply` M11 order-kind contract status: `packages/orders/src/kinds.ts`'s `ORDER_KIND_CONTRACT_STATUS` still lists both `\"contract_not_published\"`. `PatientAddressReader`: `packages/types/src/patient.ts` still exposes only `primaryResidenceState` (2-letter state code) and `residenceAt` (returns `PatientResidenceSnapshot`, whose only fields are `kind`/`facilityId`/`postalCode`) — no street-address field anywhere. DoseSpot infrastructure: `createUnboundDoseSpotClient` (`packages/dosespot/src/client/unbound.ts`) is still the Phase-1 deny-stub every call site resolves to, and no `DOSESPOT_*` credential/webhook handler exists outside test doubles. On the controlled-substance-discrepancy pair specifically: F-166 landed a real new M13 emitter for `m13.comfort_kit.controlled_substance_discrepancy` (`13-emar/outbox-consumers/m21-comfort-kit-return-reconciliation.ts`, triggered at true RECONCILIATION time via `m21.comfort_kit.return_reconciliation` rather than the old bedside-admin-time re-emit) — checked directly rather than assumed unchanged, since this looked like the one fact most likely to have moved. Its actual published payload is `{deploymentId, medicationOrderId, deltaQuantity, deltaPercent}` — still no `returnId`, still no `custodyChain` — and the file's own header says so explicitly: 'a pre-existing, separately-documented M21-side blocker this pass does not touch... stays deferred at the dispatcher until M21's side is fixed.' M21's own `decideControlledSubstanceReemit` (`21-supplies/consumers/m13-comfort-kit.ts`) and its non-binding rationale (`21-supplies/outbox-consumers/m13-comfort-kit-cascade.ts`'s header) are untouched. Not built; all 3 pairs stay deferred on the identical, freshly-confirmed reason." +
      " **F-172 (#248) built `m13.comfort_kit.controlled_substance_discrepancy` — 1 of the group's 3 remaining pairs, group now 2.** F-168's own blocker text named the exact fix: `returnId` was missing from M13's wire payload despite already being in scope at the ONE emit site (`13-emar/outbox-consumers/m21-comfort-kit-return-reconciliation.ts` — that handler IS the `m21.comfort_kit.return_reconciliation` consumer, so `payload.returnId` on the INCOMING M21 event is the outgoing M13 event's own aggregate). Widened additively (`events-by-m13.ts`'s payloadSchema + the emit site), no new cross-module read invented. The `custodyChain` half was NOT a payload gap the same way — `decideControlledSubstanceReemit` is now widened to accept the REAL, already-persisted `comfort_kit_returned_content` row (via a new `returnId`-keyed join, resolved in the new live consumer `buildM21ComfortKitControlledSubstanceReemitConsumer`) plus the `comfort_kit_return` row's own `assigned_retrieving_membership_id`/`disposal_witness_membership_id`/`reconciled_by_membership_id` columns — both rows are guaranteed to already exist by the time M13's re-emit can ever fire, because M21's OWN `reconcileReturn` transaction writes them in the SAME commit that (via the outbox) triggers the M13 consumer this event is re-emitted from. Nothing is fabricated: the old `ReemittedDiscrepantLine`/`DispatchedLineIdentity` shapes (a synthesized partial line) are replaced outright by the real `ComfortKitReturnedContentPayload` — the exact type M21's OWN native `reconcileReturn`-driven `detectionSource: \"return_reconciliation\"` emission of the SAME event already uses, so both detection sources now share one shape. **Genuinely NOT redundant with that native emission**: M13's bedside administration-tracked accounting and M21's dispatched-vs-returned accounting are two independent discrepancy checks that can disagree (see the decider's own doc comment) — this is a second, real detection path, not a duplicate. **Re-checking the other two pairs found both blockers unchanged, fresh as of 2026-09-29**: `packages/orders/src/kinds.ts`'s `ORDER_KIND_CONTRACT_STATUS` still lists `dme`/`supply` as `contract_not_published`; `packages/types/src/patient.ts`'s `PatientAddressReader` still exposes no street-address field (`primaryResidenceState`/`residenceAt` only); `packages/dosespot/src/client/unbound.ts`'s `createUnboundDoseSpotClient` is still the only implementation anywhere and no `DOSESPOT_*` credential exists in the repository. Neither forced." +
      " **F-230 (#248) built the PRODUCER half of `m12.medication_order.dispensed_at_pharmacy` for real and stopped at the consumer, on a spec gap M21's own text cannot close.** M12 now has the public `POST /webhooks/dosespot` route (HMAC-SHA256 over the raw body + ±5 min timestamp + `(org, dosespot_event_id)` dedup + DEK-encrypted receipt; `apps/backend/src/modules/12-dosespot/webhooks/`), a `medication_order_dispense` table (migration 0303) and the emit on a `Dispensed`/`PickedUp` ScriptStatusUpdate — fail-closed (503) until per-tenant `DOSESPOT_WEBHOOK_SECRETS` are bound, and never emitting without a signature-verified, persisted, parsed delivery. The event therefore now HAS a producer (the prior 'no producer' reason is obsolete). What stays blocked is the M21 decider: M21 §2.5/line 66 says the consumer 'creates the `comfort_kit_dispatch` row with `dispatch_source=pharmacy_partner` referencing the M12 transmission event', but that table's NOT NULL chain-of-custody columns — `kit_serial_number`, `dispatched_by_membership_id`, `controlled_substance_handling_policy_digest`, and (for controlled substances) per-line `lot_number`/`expiration_date` in `comfort_kit_dispatched_content` — are facts about a PHYSICAL kit that a pharmacy-dispense signal `{orderId, dosespotPrescriptionId, dispensedAt, dispensingPharmacyMdmId, fillNumber}` does not carry, and M21 names no other source for them. Inventing a serial/dispatcher/lot on a DEA 21 CFR §1304 record is the exact fabrication this pass may not do. The spec also defines no correlation key from the event to a `supply_request` (the only link is the OPTIONAL `data.contents[].medicationOrderId` on the request, null for the IPU-stock case). Options for a human decision (none built): (A) amend M21 §3.1/D6 so a `dosespot_pharmacy`-sourced dispatch may carry a pending/unknown serial+dispatcher until the partner pharmacy's assembly/courier ack supplies them (a chain-of-custody schema change — compliance sign-off); (B) a narrower consumer that only correlates by `contents[].medicationOrderId` and records 'pharmacy dispensed at T' on the `supply_request` (needs a new column/state semantics on the `vendor_assigned → ordered` path), leaving dispatch creation to the real courier-leg capture; (C) wait until real DoseSpot/partner-pharmacy samples show what the dispense callback actually carries. Not bound; deferral kept with this precise reason.",
    events: [
      "m11.order.supply_fulfillment_requested",
      "m12.medication_order.dispensed_at_pharmacy",
    ],
  },
  // F-175 (#248) — the m29 group (1 pair, `m11.order.hl7_orm_requested`) is now FULLY RESOLVED and deleted
  // from this registry outright, the F-166 (m13 group) / F-176 (m11 group, m7.intervention.* trio)
  // "group empties → delete, don't leave a hollow entry" precedent. `apps/backend/src/modules/
  // 29-external-interfaces/outbound/dispatch-worker.ts` is the real T08 worker `dispatch-planner.ts`'s own
  // header named and F-165/F-167 both confirmed still uncalled: it binds live on this event, resolves the
  // feed + D16 BAA gate, envelope-encrypts under M34's tenant DEK, dispatches over the injected
  // `MllpTransport`, and acts on every ack/retry/DLQ outcome — see the two NEW pairs this pass adds to the
  // `m11` group instead (`m29.lab_order.transmitted`/`.transmission_failed`, M29's own new outbound
  // production, declared-but-unbound on M11's *consuming* side; that gap is real and distinct from this one).
  // F-223 (#248) — the m6 group (1 pair, `m11.order.recertification_signed`) is now FULLY RESOLVED and deleted
  // outright (the F-175 "group empties -> delete" precedent). The user decided a signed recert order
  // auto-opens the next PENDING election period: `outbox-consumers/m11-recertification-signed.ts` (migration
  // 0297 `election_period.source_order_id` + UNIQUE(organization_id, source_order_id)) reuses the route's own
  // `openNextElectionPeriodInTx`; F2F/CTI adequacy stays gated at activation (F-217).
  // F-142 (#248) — the `m7` group is GONE, not merely emptied. All 5 pairs were checked against M7's own
  // authoritative surface: `m39.consent.dpoa.agent_appointed`/`.agent_removed` and both `m9.assessment.*`
  // events are redundant with documented build-time SEAM PULLS (M7's own D7 — a single ABAC seam to M39
  // for DPOA attribution; M7's own spec — the registered `LatestAssessmentProvider` seam for M9 scores),
  // dropped at the source with no m7 replacement. `m19.triage_call.care_plan_change_indicated` was a
  // genuine misdeclaration, not merely unsupported: M19's own D8-cascade text (§11) names the real
  // consumer as M14's IDG packet builder, not M7 — corrected at the source (declaredConsumers m7→m14) and
  // the pair now lives in the m14 group below.
  // F-172 (#248) — the `m35` group is GONE, not merely emptied. Two prior passes (F-142, F-167) declined
  // to build `PseudonymKeyProvider.activeKey()`, reasoning M34's per-tenant DEK-wrap mechanism
  // (`bootstrap/tenant-kek.ts`) "does not transfer" to a platform-singleton secret and that building one
  // was "genuinely new security-critical infrastructure, not a wiring task." Re-investigated rather than
  // re-asserted: it is the SAME already-ratified pattern (ADR-0038 app-layer AES-256-GCM envelope
  // encryption, KEK custody as a fail-closed env-sourced port) applied a fifth time — the identical
  // custody model `TWO_FACTOR_ENCRYPTION_KEY`/`M24_CREDENTIAL_ENCRYPTION_KEY`/`MESSAGING_ENCRYPTION_KEY`/
  // `M34_TENANT_KEK` already use, and the module's OWN spec (§4.11 D15/§14.3) independently commits to
  // "the standard WardenX KMS-wrapped DEK pattern" for this exact table. No real cloud KMS credential or
  // new security decision was needed: the KEY MATERIAL is a CSPRNG mint (`randomBytes(32)`, the identical
  // mechanism every DEK/KEK mint on this platform already uses — no human chooses or reviews the bytes),
  // and the only operator-configured secret is the wrapping KEK, following the established shape exactly.
  // Built: `packages/subscription-billing/src/pseudonym/key-envelope.ts` (the pure AES-256-GCM
  // seal/open, AAD-bound to `(kekId, keyEpoch)` rather than an org id — the platform-singleton analogue of
  // `tenant-kek.ts`'s tenant-binding AAD) + `35-subscription/pseudonym-key-provider.ts` (the real
  // `PseudonymKeyProvider`, driven over the PLATFORM pool `DATABASE_PLATFORM_URL` already grants
  // `patient_pseudonym_key` to — mint-on-first-use, race-safe via the table's own
  // `patient_pseudonym_key_one_active_uq` partial index rather than an app-level lock) + a new
  // `M35_PSEUDONYM_KEY_KEK` required-in-production env var (`bootstrap/env.ts`, the `M34_TENANT_KEK` rule
  // verbatim, a SEPARATE secret never interchangeable with it). `m2.session.created`'s
  // userId→membershipId gap F-142/F-167 both flagged is resolved the same way M5's own
  // `membershipUserIdForOrg` already resolves the reverse direction one module over: `membership` is
  // M1-owned (`architecture/module-manifest.ts`), M35 `dependsOn: [1]`, so M35 reads `schema.memberships`
  // directly rather than needing a new cross-module seam. `m5.patient.merged`'s "re-pseudonymize on merge
  // target" (§4.12) is the merge SURVIVOR's own raw patientId fed through the existing
  // `recordPatientActive` shape; `m5.patient.deceased`'s "mark inactive with reason='died'" is a new,
  // narrowly-scoped `markPatientInactiveForOrg` capability (NOT added to the pure `ActivePeriodStore`
  // port — an extra Drizzle-store capability beyond the minimal port, the `CaseloadStore` shape) that
  // deliberately leaves `was_active` untouched (a patient who died mid-period WAS active for part of it;
  // see that function's own header). `m5.patient.created`/`.status_changed` — D21's other two
  // `patient-active-period-aggregator` triggers — are OUT OF SCOPE: neither declares `m35` on its catalog
  // entry today (only `.deceased`/`.merged` do), a separate, unscoped catalog question this pass does not
  // answer. Proven live end to end (`m35-pseudonym-key-provider.live.test.ts`): mint-on-first-use is
  // race-safe under two concurrent callers (exactly one epoch minted), the wrapped ciphertext at rest is
  // never the plaintext, an unknown KEK id refuses with a stated reason, rotation retires the old epoch
  // and historic rows keep their original epoch tag (never rewritten), `patient_pseudonym_key` is
  // unreadable on the tenant `wardenx_app` credential (42501, the `tenant_key_ring`/M34-F02 shape), and
  // all three consumers write real `patient_active_period`/`user_active_period` rows under RLS with
  // cross-tenant isolation (org B's rows are untouched by an org A delivery).
  // F-158 (#248) — the `m2` group is GONE, not merely emptied. `m39.consent.revoked` is now BUILT:
  // `buildM2ConsentRevokedConsumer` terminates the patient's own `patient_portal` sessions when their
  // `portal_access` consent is revoked — the exact mechanism M39's spec names, deliberately scoped to
  // that ONE consent type. `family_caregiver_access` (also named in M39's per-type cascade table) is
  // NOT handled: the spec's own worked walkthrough assumes a session model migration 0219/0220 already
  // split into three classes, and — the real blocker — two independent, concurrently-active
  // `family_caregiver_access` consent records can legitimately name different caregivers for the same
  // patient with nothing in `consent-store-db.ts#createDraft` preventing it, so a blanket
  // "every `caregiver_portal` session for this patientId" sweep would terminate an unrelated
  // caregiver's still-valid session. The only disambiguating fact
  // (`portal_access_grant.source_consent_record_id`) is M31-owned and not exposed by either of M31's
  // published read seams, nor is `PortalAccessGrantReader` in the platform's `SeamName` union at all —
  // a genuine missing cross-module read surface (a new M31 seam method + `SeamName`/`REQUIRED_SEAMS`
  // registration), reported rather than guessed at.
  // F-142 (#248) — the `m32` group is GONE, not merely emptied. `m16.bereavement.risk_score_computed`
  // and `m8.hearthnote.layer2_enhanced` were both dropped on the identical shape: M32's own spec states
  // the relationship runs the OPPOSITE direction — M16/M8 each call INTO M32's registered seam
  // (`BereavementRiskNarrativeProvider.augment`/`NarrativeEnhancementProvider.enhance`) SYNCHRONOUSLY,
  // and M32 already returns everything these events' payloads carry during that call; consuming its own
  // announcement afterward would be redundant. `m19.triage.summary_requested` was a genuine
  // misdeclaration, not merely unsupported: `events-by-m19.ts`'s own inline comment ("reserved for an
  // M32 AI call-summary request") directly contradicted M19's own LOCKED spec, cited three separate ways
  // (the "Consumed by" table, the §4.10 outbox table, and the Lock-status section, all naming M22 for a
  // caregiver/attending PDF render) plus `packages/types/src/oncall.ts`'s own payload doc comment ("→ M22
  // renders the caregiver/attending summary document"). Corrected at the source (declaredConsumers
  // m32→m22) and the pair now lives in the m22 group above.
  // F-219 (#248) — the `m37` group is GONE, not merely emptied. Its last pair,
  // `m19.triage_call.gip_admission_proposed`, is resolved as a SEAM PULL, the user-decided path: M37's
  // intake worklist reads M19's org-explicit published `gipProposalsForOrg`
  // (`19-oncall/seams/gip-proposals-for-org.ts`) through `GET /api/v1/ipu-intake/gip-proposals`, wired in
  // the composition root (`apps/backend/src/index.ts`, `gipProposals` port on the M37 route service). M37
  // gains NO table: no `ipu_admission` row can exist at proposal time (`admission_id`/
  // `level_of_care_period_id`/`provider_entity_id` are NOT NULL and the LOC period is created later by M11's
  // order draft), so the worklist entry is a PROPOSAL READ, distinct from the durable M11 LOC order -> M6
  // `requires_ipu_bed` -> M37 path. M19's catalog moved `m37` from `declaredConsumers` to `seamConsumers`.
  // F-218 (#248) — the same M19 read also feeds M14: `m19.triage_call.care_plan_change_indicated` left the
  // `m14` group below (seam pull as a `triage_care_plan_change` flagged event, `flaggedEventSources`).
  // F-143 (#248) — the `m9` group is GONE, not merely emptied. All 3 pairs were checked against M9's
  // own spec: `m13.prn_administration_recorded` has no support anywhere in M9's "Depends on"/"Consumed
  // by" relationship inventory or its §2.4 outbox table; `m8.encounter.signed` is M8 calling INTO M9's
  // `recordAssessment` API synchronously (M9's own line 61), never a push M9 would subscribe to;
  // `m8.vitals.captured` is the seam-vs-push trap — M9's own spec (line 75) states trending "may read
  // the encounter vital series via M8's seam ... but M9 does not own vital signs," a documented pull
  // M9 would perform, never an outbox push. All 3 dropped at the source (`m8.vitals.captured` moved to
  // `seamConsumers` instead, recording the aspirational-but-unbuilt seam relationship).
  // F-164 (#248) — the `m12` `handlers-unbound` group is GONE, not merely emptied: all 8 remaining pairs
  // are now BUILT and live-bound. `m11.order.verbal_expired_unsigned` — all three stacked defects fixed:
  // M12's `recordVerbal` now writes M11's polymorphic `verbal_order` row through the real
  // `OrderSignatureProvider.recordVerbalOrder` seam (which itself gained a real per-org deadline read,
  // `verbalPolicyForOrg`, fixing a latent bug where every deadline used the 48h platform default); the
  // catalog payload gained the missing `targetKind` field; and M11's hourly `orders.verbal_timer` BullMQ
  // fan-out now calls the real `OrderRouteService.expireOverdueVerbals` scan, with M12's
  // `verbal-expired-binding.ts` consumer flipping the medication order to `expired_unsigned` on delivery.
  // `m13.reconciliation.draft_order_requested` — M13's real emit site now sends genuine drug content
  // (never the historical hardcoded `{}`), and M12's `draft-order-requested-binding.ts` mints a real
  // draft `medication_order`, siting/attributing it via M6's `activeAdmissionDraftContextForPatient` seam,
  // idempotent via a new non-partitioned ledger table (`medication_order_reconciliation_decision_
  // application`, migration 0254 — `medication_order` is partitioned, so a direct unique constraint on
  // the triggering decision id cannot exist). The 6 `sync-triggers.ts` events (`m5.patient.{created,
  // updated,address_changed,payer_changed}`, `m6.admission.activated`, `m6.cti.signed`) now have the full
  // job-queue tier this group's own reason said did not exist: a durable `dosespot_sync_queue` table
  // (migration 0253, `12-dosespot/jobs/schema.ts` — chosen over pure BullMQ because a Postgres
  // partial-unique index can debounce TWO DIFFERENT trigger events for the same patient close together,
  // atomically with the outbox delivery, which a BullMQ `jobId` dedupe cannot) drained by a scheduled
  // worker with an honest fail-closed `DoseSpotClient` boundary (no `DOSESPOT_*` credential exists
  // anywhere in this repo) and a real M5 demographic-snapshot read (`dosespotSyncDemographicsForOrg`,
  // M5's own org-explicit seam — `patient_address`/`patient_phone` are not in `check-table-ownership.ts`'s
  // cross-module-read exemption set, so this could not be a direct schema read despite M5 being a
  // declared dependency). `m6.cti.signed`'s missing `admissionId` resolves through M6's own org-explicit
  // `electionPeriodContextForOrg` seam, injected as a port (M12's manifest has no `dependsOn` edge to 6).
  // Two smaller gaps stay genuinely deferred, reported rather than fabricated: no RxBenefit cache exists
  // anywhere in this repository (the `invalidateRxBenefitCache` flag is preserved on the queue row for a
  // future cache layer to act on), and no table maps a WardenX patient to its DoseSpot-side id
  // (`DosespotPatientIdResolver` stays an honest deny-stub — a MedHx fetch cannot name which vendor
  // patient to pull history for until a successful patient-sync upsert has somewhere to record its
  // response, and the vendor client itself is unbound regardless).
  // F-143 (#248) — the `m10` group is GONE, not merely emptied. `m8.encounter.signed` was the sole
  // member, and M10's own spec is decisive the relationship runs the OPPOSITE direction — line 9's
  // "Consumed by" table and the spec's own re-lock note (explicitly correcting a prior encoding that
  // "inverted the M8↔M10 dep direction") both state M8 CALLS M10's `recordHopeTimepoint` API
  // synchronously; M10's two real outbox consumers (`apps/backend/src/modules/10-hope/outbox-consumers/`)
  // are both M6-only. Dropped at the source with no `seamConsumers` replacement — the relationship is a
  // synchronous API call, not a seam read either.
  // F-143 (#248) — the `m3` group is GONE, not merely emptied. `m39.consent.supersedes` was the sole
  // member; M3's own spec (line 74) states it consumes a consent attribute only via the boot-registered
  // `ConsentEvaluator` seam PULL, consulted fresh per ABAC evaluation, never an outbox subscription — M3
  // has no `consumers/` directory and no consent-keyed cache to rebind (its one cache invalidates only
  // on role/permission changes). Dropped at the source; no `seamConsumers` replacement needed since the
  // relationship the event's own description gestured at ("cache rebind") is already covered by the
  // live `ConsentEvaluator` seam regardless of this declaration.
];
