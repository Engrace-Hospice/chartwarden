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
  {
    module: "m30",
    kind: "handlers-unbound",
    reason:
      "F-115 (#248) split this group in two — the blanket 'M30 is a producer, not a subscriber; no consumer directory exists' reason (M30-T… original) was FALSE for these four: `packages/quality/src/consumers/` is a real, unit-tested consumer directory (`handlers.ts` + `subscription-map.ts`, the §4.10 upstream fan-out — recompute enqueues, the mortality-review auto-draft, the CAHPS candidate seed, the medication-error incident auto-draft) that RULE 3(d) ships pure with no boot-wired binding, the same shape M23/M25/M26/M27 were already correctly classified `handlers-unbound` under. Two of `M30_OUTBOX_SUBSCRIPTIONS`'s six topics (`m6.discharge.death`, `m6.election.signed`) were already carried as a `handler-unbound` entry in outbox-subscription-exceptions.ts because the catalog never declared m30 on them; these four are the mirror case — the catalog DOES declare m30, and it is the binding that is missing.",
    events: [
      "m10.hope.submission_accepted",
      "m12.medication.error_reported",
      "m18.evv.visit_verified",
      "m23.claim.adjudicated",
    ],
  },
  {
    module: "m30",
    kind: "no-consumer-surface",
    reason:
      "F-115 (#248) — the ORIGINAL blanket reason here ('M30 is a producer, not a subscriber … no consumer directory exists') was wrong about 27 of this group's members, checked individually rather than assumed: they are the exact facts M30's OWN nightly recompute seams already read (`apps/backend/src/modules/30-quality/jobs/m30-jobs.ts` — `AdmissionOnsetReader`/`DischargeReader`/`LevelOfCarePeriodReader` (M6), `CarePlanCycleCountsView` (M7), `SignedEncountersReader` (M8), the live M10 HOPE rollup, `VerbalTimelinessCountsView` (M11), `MedicationAdministrationProvider`'s PRN/missed-dose counts (M13), `IdgScheduleProvider` (M14), `DisciplineComplianceProvider`'s supervisory counts (M15), `BereavementComplianceProvider.copOutreachCounts` (M16), `VisitMetricsProvider` (M17), `QualityCostReportConsumer` (M27) — verified per event against the actual seam query, not inferred from module proximity (three initially-plausible candidates — `m16.bereavement.plan_closed_*`/`plan_skipped_per_patient_opt_out`, whose numerator/denominator membership `copOutreachCounts` does not establish, and `m13.administration.recorded`/`refused`/`corrected`/`voided`, whose measures scan `scheduled_dose`/PRN-specific rows rather than the general administration stream — were checked and are NOT among the 27, and stay in this list). Those 27 are now declared correctly (`seamConsumers`, dropped from `declaredConsumers`, on each event's own `events-by-mNN.ts` entry) and no longer appear below; a deferral was never the right shape for a relationship that already resolves by seam and will never bind an outbox consumer. `m30.infection.event_recorded`'s 'self-subscriber' declaration is also gone: `recordInfectionEvent` runs the §7.8 outbreak-window scan INLINE in the same transaction, and nothing has ever consumed this event via the outbox. What remains below is the honest count: M20/M21/M23(noe/notr)/M25/M26/M37/M39/M9 facts M30 has no current seam for at all, three M6 facts (`applier.refused`, `compliance.window.*`, `f2f.window_*`, `admission.on_hold`/`.resumed`) outside the four M6 readers' documented scope, `m8.hearthnote.layer2_enhanced` (no late-entry/signed-encounter relevance), and three bereavement facts whose seam METHOD exists (`BereavementComplianceProvider.planClosureCounts`/`riskScreeningCompletenessCounts`) but is not yet called by any of the eleven measures m30-jobs.ts currently registers — a dormant capability, not a bound one (`bound is not computing`, F-042).",
    events: [
      "m11.order.completed",
      "m11.order.discontinued",
      "m11.order.level_of_care_change_signed",
      "m11.order.results_overdue",
      "m11.order.signed",
      "m11.order.signed_on_behalf",
      "m11.order.transmission_status_changed",
      "m11.order.transmission_terminal_failed",
      "m12.medication_order.transmission_failed",
      "m13.administration.controlled_wasted",
      "m13.administration.controlled_witnessed",
      "m13.administration.corrected",
      "m13.administration.recorded",
      "m13.administration.refused",
      "m13.administration.voided",
      "m13.caregiver_administration.disputed",
      "m13.comfort_kit.controlled_substance_discrepancy",
      "m13.comfort_kit.return_overdue",
      "m13.policy.changed",
      "m13.reconciliation.completed",
      "m13.reconciliation.overdue",
      "m14.review_clock.escalated",
      "m14.review_floor.override_recorded",
      "m15.discipline_assessment.amended",
      "m15.plan.discharged",
      "m15.plan.version_signed",
      "m15.volunteer.ratio_recomputed",
      "m16.bereavement.contact_referred_external",
      "m16.bereavement.plan_closed_completed",
      "m16.bereavement.plan_closed_declined",
      "m16.bereavement.plan_closed_early",
      "m16.bereavement.plan_skipped_per_patient_opt_out",
      "m16.bereavement.risk_score_computed",
      "m20.safety.incident_closed_with_action",
      "m20.safety.incident_submitted",
      "m20.safety.osha_reportable_incident_filed",
      "m21.comfort_kit.return_overdue",
      "m21.comfort_kit.return_reconciliation",
      "m21.controlled_substance.discrepancy_detected",
      "m21.par.below_threshold",
      "m21.par.stockout_imminent",
      "m23.noe.window_breached",
      "m23.notr.window_breached",
      "m25.denial.opened",
      "m26.cap.projection_updated",
      "m26.cap.year_closed",
      "m37.ipu_admission.death_recorded",
      "m37.ipu_admission.discharged",
      "m37.restraint.applied",
      "m39.consent.signed",
      "m6.admission.on_hold",
      "m6.admission.resumed",
      "m6.applier.refused",
      "m6.compliance.window.closed",
      "m6.compliance.window.opened",
      "m6.compliance.window.overdue",
      "m6.compliance.window.overridden",
      "m6.f2f.window_missed",
      "m6.f2f.window_overridden",
      "m8.hearthnote.layer2_enhanced",
      "m9.assessment.recorded",
    ],
  },
  {
    module: "m22",
    kind: "handlers-unbound",
    reason:
      "M22 renders on REQUEST. Its live binding consumes `M22_DOCUMENT_REQUEST_EVENTS`, and a module that wants a document emits a render request which M22 answers with `m22.document.rendered`. NOTE (F-099): a reason written for the whole group was WRONG for six of its members (the REQUEST spelling itself, unconsumed); those are bound. M6's six CoP documents were then bound directly (F-100) per the M22 spec's own §4.11 table, which routes those SOURCE events to the renderer with no `document_requested` needed. F-117 (#248) re-checked the ORIGINAL claim that 'for M11/M12/M13/M21/M23/M33 the request half IS wired, so the source declaration is redundant' PER EVENT rather than per module — it was right for exactly 4 of the ~20 events across those six modules (the ones actually co-emitted with a `document_requested` sibling in the SAME transition: `m11.order.signed`/`.standing_spawned`, `m12.medication_order.signed`, `m13.reconciliation.completed` — all now dropped from `declaredConsumers`, no `seamConsumers` replacement, since the artifact is delivered via the other event) and WRONG for the rest, which are separate order/claim/billing lifecycle events on the SAME modules with no such sibling and stay genuinely declared. Two more were dropped as never needing a render at all, not merely redundant: `m37.body_release.completed` (the PRIOR transition's own guard already requires the document to exist — `releaseBody` refuses without a signed `body_release_authorization`) and `m27.cost_report.reopened` (resets to `draft`; no job, no request, nothing to render until the next `submitted`). `m27.cost_report.submitted` was dropped on the F-108 precedent — it enqueues the `ecr-generation` job rather than emitting a request itself, and that job's own `m27.artifact.render_requested` is the real, already-bound handshake. `m37.body_release.funeral_home_identified` was dropped the ordinary way: `identifyFuneralHome` co-emits `m37.body_release.document_requested` in the same transition. What remains (61 events) divides three ways, none of it a blanket call: events the M22 spec's §4.11 table explicitly names for a dedicated per-source consumer that was never built (`m11.order.results_received`, `m12.medication_order.{list_changed,draft_created_from_extraction}`, `m13.administration_record.document_requested` — catalogued-not-emitted, F-099's producer gap — `m14.{packet.render_requested,minutes.signed}`, `m15.plan.version_signed`, `m18.evv.aggregator_accepted` — whose OWN sibling `m18.evv.verification_pdf_requested` is catalogued and ALSO never emitted, so this is the only real signal — `m5.patient.{merged,draft_created_from_extraction}`, `m8.encounter.{signed,addendum_signed}`, `m39.consent.revoked`); one confirmed stale cross-reference, not yet fixed here (`m9.assessment.summary_requested` is real, catalogued, request-shaped, and declares m22 — `M22_ANTICIPATED_DOCUMENT_REQUEST_EVENTS`' comment calls the equivalent need `m9.assessment.document_requested` and says it is 'declared by no catalog under any spelling', which is now false; a live candidate for the next binding pass, the F-100 `m37.body_release.document_requested` shape); and events named by NO part of the M22 spec's §4.11 table with no redundant sibling found, kept declared rather than dropped absent stronger evidence — the F-101 sweep this needs has not been run on them (`m11.order.{corrected,discontinued,level_of_care_change_signed,recertification_signed,supply_fulfillment_requested}` — the latter two of which M11 does not even emit yet, a producer gap under this one; `draft_created` is the one exception with its own documented intent, 'M22 preps the order form'; `m14.{meeting.adjourned,minutes.amended}`; `m15.{discipline_assessment.amended,plan.discharged}`; `m16.bereavement.plan_{closed_completed,closed_declined,closed_early,opened}`; `m17.caregiver_reminder_due`; `m21.supply_request.delivered`; `m23.{billing.document_render_requested,claim.acknowledged,claim.rejected,claim.submitted,noe.submitted,notr.submitted}` — the first of which is already request-shaped and a strong candidate; `m24.medicaid_{billing.document_render_requested,claim.acknowledged,claim.rejected,claim.submitted}`; `m25.{appeal.submitted,denial_resolution_letter.render_requested}` — the second likewise request-shaped; `m30.{incident.submitted,qapi.pip_closed,qapi.project_chartered}`; `m37.ipu_admission.death_recorded`; `m39.consent.{expired,recipient_added,recipient_removed}`; `m5.patient.{privacy_flag_changed,unmerged}`; `m7.care_plan.version_signed`; `m8.encounter.voided`). `m6.discharge.cosigned` and `m6.transfer.created` are untouched by this pass — both genuinely deferred per F-099's original reasoning (version-append and transfer-variant gaps respectively).",
    events: [
      "m11.order.corrected",
      "m11.order.discontinued",
      "m11.order.draft_created",
      "m11.order.level_of_care_change_signed",
      "m11.order.recertification_signed",
      "m11.order.results_received",
      "m11.order.supply_fulfillment_requested",
      "m12.medication_order.draft_created_from_extraction",
      "m12.medication_order.list_changed",
      "m12.medication_order.signature_requested",
      "m12.medication_order.transmitted",
      "m13.administration_record.document_requested",
      "m14.meeting.adjourned",
      "m14.minutes.amended",
      "m14.minutes.signed",
      "m14.packet.render_requested",
      "m15.discipline_assessment.amended",
      "m15.plan.discharged",
      "m15.plan.version_signed",
      "m16.bereavement.plan_closed_completed",
      "m16.bereavement.plan_closed_declined",
      "m16.bereavement.plan_closed_early",
      "m16.bereavement.plan_opened",
      "m17.caregiver_reminder_due",
      "m18.evv.aggregator_accepted",
      "m18.evv.verification_pdf_requested",
      "m21.supply_request.delivered",
      "m23.billing.document_render_requested",
      "m23.claim.acknowledged",
      "m23.claim.rejected",
      "m23.claim.submitted",
      "m23.noe.submitted",
      "m23.notr.submitted",
      "m24.medicaid_billing.document_render_requested",
      "m24.medicaid_claim.acknowledged",
      "m24.medicaid_claim.rejected",
      "m24.medicaid_claim.submitted",
      "m25.appeal.submitted",
      "m25.denial_resolution_letter.render_requested",
      "m30.incident.submitted",
      "m30.qapi.pip_closed",
      "m30.qapi.project_chartered",
      "m37.ipu_admission.death_recorded",
      "m39.consent.expired",
      "m39.consent.recipient_added",
      "m39.consent.recipient_removed",
      "m39.consent.revoked",
      "m5.patient.draft_created_from_extraction",
      "m5.patient.merged",
      "m5.patient.privacy_flag_changed",
      "m5.patient.unmerged",
      "m6.discharge.cosigned",
      "m6.transfer.created",
      "m7.care_plan.version_signed",
      "m8.encounter.addendum_signed",
      "m8.encounter.signed",
      "m8.encounter.voided",
      "m9.assessment.summary_requested",
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
      "What remains here, unresolved, is two honest groups: the REAL 'since last IDG'/inclusion-cache/M22-back-ref shape M14's own spec names and has not built (8 events: the two M6 inclusion-cache events, M9's `recorded`/`significant_change`, M10's `j2051_trigger_fired`/`sfv_created`, M11's `order.discontinued`, M12's `medication_order.discontinued` — the M22 back-ref additionally has no producer, since `m14.packet.document_requested` is catalogued by nobody); and 22 pairs checked and found NEITHER clearly redundant NOR named anywhere in M14's own spec (M6 admission on_hold/resumed + compliance-window open/overdue, M9's `assessment.amended`, M12's `medication_history_pulled`, all 12 of M13's eMAR events, all 3 of M15's discipline-care-plan events, M39's `consent.expiring_soon`) — kept declared rather than dropped absent stronger evidence, per the F-101 precedent. Of those 22, `m13.scheduled_dose.missed` has the strongest textual support to eventually bind: M14's own §1 packet description names 'missed doses' as a `flaggedEvents` category and the M13 payload (`missedDoseId`, `dueAt`, controlled/comfort-kit flags) maps directly onto `PacketFlaggedEventDigest`'s `missed_dose` kind — the other 11 M13 events, all 3 M15 events and M39's `expiring_soon` have no such correlation and may be next pass's misdeclarations.",
    events: [
      "m10.hope.j2051_trigger_fired",
      "m10.hope.sfv_created",
      "m11.order.discontinued",
      "m12.medication_history_pulled",
      "m12.medication_order.discontinued",
      "m13.administration.recorded",
      "m13.administration.recorded_caregiver_attested",
      "m13.administration.refused",
      "m13.caregiver_administration.acknowledged",
      "m13.caregiver_administration.disputed",
      "m13.comfort_kit.deployed",
      "m13.missed_dose.reverted",
      "m13.prn_administration_recorded",
      "m13.reconciliation.completed",
      "m13.reconciliation.opened",
      "m13.scheduled_dose.intentionally_held",
      "m13.scheduled_dose.missed",
      "m15.idg_decision.applied",
      "m15.plan.bootstrapped",
      "m15.plan.version_signed",
      "m39.consent.expiring_soon",
      "m6.admission.activated",
      "m6.admission.discharged",
      "m6.admission.on_hold",
      "m6.admission.resumed",
      "m6.compliance.window.opened",
      "m6.compliance.window.overdue",
      "m9.assessment.amended",
      "m9.assessment.recorded",
      "m9.assessment.significant_change",
    ],
  },
  // F-115 (#248) — the `m28` group (52 pairs) is GONE, not merely emptied. M28's FHIR gateway resolves
  // every seam it reads (M5/M6/M7/M8/M11/M12/M13) fresh at REQUEST time (§164.528 D3, F-035) and holds no
  // cached/derived state any of these events would ever need to invalidate — it never subscribes to
  // anything, on any topic, and the "no consumer directory … forward declarations against a subscriber
  // that does not exist" reason was correct about the SURFACE and wrong about the CONCLUSION: the
  // declarations were not future work, they were never going to be true. All 52 `m28` entries on the
  // `declaredConsumers` catalog have been removed (each event's own `events-by-mNN.ts`), leaving nothing
  // to defer.
  {
    module: "m23",
    kind: "handlers-unbound",
    reason:
      "F-136 (#248) checked this group per-event against M23's own §4.4 spec text (the full M6 outbox-catalog subscription list, quoted by name in the dependsOn prose) and its real, frozen `consumers/subscription-map.ts` (7 live topics + 2 M25/M26 deny-stubs), rather than trusting seven producing modules' `declaredConsumers` guesses. M23 binds three real consumers today: remittance feedback, submission-request enqueue, and — since F-106/F-107 — the NOE draft on `m6.election.period_started` and the NOTR draft on `m6.revocation.created` / `m6.transfer.created` / `m6.discharge.created`. **8 of 20 pairs are genuine, real, still-unbound subscriptions**: the six already on the subscription map (`m6.cti.signed`, `m6.f2f.attested`, `m6.loc.changed`, `m8.encounter.cosigned`, `m5.patient.deceased`, `m18.evv.late_check_resolved`), plus two the map has not caught up to yet — `m6.election.period_ended`, named by the spec's own text (\"claim-period anchoring\") right beside the already-mapped `period_started`, and `m25.taxonomy.unmapped_code_observed`, kept on M25's own D13 text naming a specific, decided mechanism (\"generates outbox to M23... suggesting a new pre-submission validation rule\") despite M23's own spec being silent on it — the F-131 \"kept, not dropped\" caution. **12 of 20 were genuinely misdeclared and dropped at the source**: `m11.order.level_of_care_change_signed`/`.recertification_signed` are each redundant with M6's own resulting `loc.changed`/`cti.signed` (already bound) — the order-signed event is one hop upstream of the fact M23 actually reads; `m23.claim.draft_created` is M23 consuming its own event, contradicted by the spec's own state-transition table (\"M33, M22 — no render yet\"); `m25.denial.resolved_favorable_via_appeal` is redundant with the already-bound `m25.remittance.claim_paid` — M23's own claim state machine says the PAID transition is driven by the 835 RE-POST, not the appeal decision itself; all four `m37.*` events (`census.snapshot_taken`, `ipu_admission.bed_assigned`/`.discharged`/`.transferred`) have no support in M23's spec — the only M37↔M23 relationship runs the other way (M37 reads M23's `ClaimReader`), and `bed_assigned`'s specific \"M23 writes the place-of-service Q-code\" claim is directly contradicted by F-127's finding that `placeOfService` is genuinely unbound platform-wide; `m5.patient.payer_changed` is a seam-pull redundancy — M23's own spec says patient-payer status is CONSULTED fresh at every claim assembly, never pushed; `m6.admission.activated` and `m6.admission.discharged` were each part of that event's broad clinical fan-out with no billing-specific rationale (the F-134 shape already found for m16 on the same two events) and each is redundant with a narrower, already-bound sibling (`discharge.created` carries the fact `admission.discharged` does not); `m6.nor.acknowledged` (Notice of Rights) is never mentioned anywhere in M23's spec. All 12 dropped at the source (M5 ×1, M6 ×3, M11 ×2, M23 ×1 self, M25 ×1, M37 ×4).",
    events: [
      "m18.evv.late_check_resolved",
      "m25.taxonomy.unmapped_code_observed",
      "m5.patient.deceased",
      "m6.cti.signed",
      "m6.election.period_ended",
      "m6.f2f.attested",
      "m6.loc.changed",
      "m8.encounter.cosigned",
    ],
  },
  {
    module: "m27",
    kind: "handlers-unbound",
    reason:
      "F-130 (#248) finished the per-event verification the prior pass's reason called for, against M27's own §1.1 relationship inventory and its manifest-patch dependsOn list ([1,2,3,4,6,8,12,13,22,23,26,36,38,40] — 21/24/37 conspicuously absent) — the F-101 rule that the CONSUMING module's own spec decides who consumes it, applied here at full group scale. 21 of the 23 pairs were dropped as misdeclared, redundant with a documented seam PULL M27's spec names explicitly by method: M6's `LevelOfCarePeriodReader`/`AdmissionCensusReader` (all 5 M6 events: `admission.activated`/`.discharged`, `election.period_started`/`.period_ended`, `loc.changed` — the last IS the exact table the reader pulls), M23's `PatientDaysProvider`/`ClaimSettlementProvider` (the 3 `m23.claim.*` events — M27's own text: \"forward-seam-deny-stubs at M27 lock and wire to live at M23 lock\"), M26's `CapAccrualReader`/`CapPeriodReader` (all 6 `m26.cap.*` events, same forward-seam-deny-stub framing). Three more had NO support anywhere in M27's spec, not even under deny-stub framing: the 3 `m24.medicaid_claim.*` events (Medicaid's billed-day contribution to the S-3 census arrives entirely through M23's PatientDaysProvider, by M27's own account of what that provider covers — \"by program (Medicare / Medicaid / other)\" — M24 itself is never named), the 3 `m37.*` events (M37 is named ONLY in the opposite direction — M37 consumes M27's `CostReportProvider.getInpatientCapPositionAtFiscalDate`, M27 never reads M37; GIP/IPU level of care is already covered via M6's LOC-period pull regardless of physical site), and `m8.mileage.captured` (M27's spec never mentions mileage; the event's own \"payroll/AP\" phrasing is Gusto-side, pulled by M27's separate `wage-data-pull` job, not this event). All 21 dropped at the source in each producing module's `events-by-mNN.ts`, not here. **The remaining 2 are a genuine, real, still-open forward seam, not a misdeclaration**: M21's own locked spec (§1.1, D16 — \"Does M21 own vendor invoice reconciliation?\") explicitly commits M21 to emitting `m21.supply_request.invoice_accrued`/`.invoice_reconciled` for an M27-side accrual/GL-reconciliation consumer, citing the precedent \"the M11 D6 / M13 D5 forward-seam precedent until M27 locks\" — a real cross-module decision on the PRODUCING side that M27's own spec simply never corroborates or builds a consumer for (M27's spec is silent on M21 entirely, the same asymmetry as M24/M37 above, but backed here by an explicit committed decision rather than an unsupported guess) — kept declared as the honest open question this asymmetry actually is, not dropped on the strength of M27's silence alone.",
    events: ["m21.supply_request.invoice_accrued", "m21.supply_request.invoice_reconciled"],
  },
  {
    module: "m26",
    kind: "handlers-unbound",
    reason:
      "F-131 (#248) checked this group per-event against M26's own §4.4 consumer surface — `consumers/subscription-map.ts`'s `M26_SUBSCRIPTION_MAP` (the F-094/F-101 authoritative-consumer-list precedent) plus the module spec's exhaustive §3.1 file tree, which names exactly seven consumer files and no others — rather than trusting the six producing modules' `declaredConsumers` guesses. 15 of the 22 pairs were dropped as misdeclared. Two clusters are redundant with a documented seam PULL M26's own \"Depends on\" text names explicitly: all 6 `m6.*` events (`admission.activated`/`.discharged`, `discharge.created`, `election.period_started`/`.period_ended`, `loc.changed`) — M26's cap math is benefit-period-anchored via the `ElectionPeriodReader` PULL, and `loc.changed` additionally has no relevance at all to the INPATIENT cap either: D13 names M23 claim lines by revenue code (0655/0656) as that source, never M6 LOC periods; and 1 of 2 `m23.claim.paid` — M26's own text is explicit that \"M25 is the authoritative paid-amount source … every cent traces to an 835-derived remittance line\", so the claim-paid milestone itself carries no accrual fact the subscription-map keys on. `m23.claim.acknowledged` has no support anywhere in M26's consumer surface (an acknowledgment carries no paid amount, reversal, or inpatient-day fact). All 4 `m24.medicaid_claim.*` events have NO support of any kind — M26's own spec states outright: \"Medicaid payments are excluded from the Medicare aggregate cap (ADR-0017 D4)\" and \"M26's scope is strictly Medicare per 42 CFR §418.308\". All 3 `m37.*` events (`census.snapshot_taken`, `ipu_admission.discharged`/`.transferred`) have no support either — M37 is named nowhere in M26's \"Depends on\"/\"Consumed by\" text (M26's inpatient-day source is M23 revenue codes, physical-site-independent, the identical F-130 finding for M27 one module over). All 15 dropped at the source in each producing module's `events-by-mNN.ts`, not here. **The remaining 7 split into two kinds**: 5 are the real, confirmed §4.4 subscriptions M26's own map names — `m23.claim.line_finalized` (`record-inpatient-day-line`), `m23.claim.replaced`/`.voided` (`record-reversal-line`), `m25.remittance.advice_posted` (`record-accrual-line`), `m6.revocation.created`/`m6.transfer.created` (freeze / proportional-weight-init) — genuinely deferred behind the Drizzle `CapConsumerStore` bind (itself deferred behind the M5 MBI + M6 first-election readers), not misdeclared. The 7th, `m25.remittance.claim_recouped`, is a genuine gap rather than a misdeclaration in EITHER direction: M25's own locked §4.5 state-transition table names M26 outright — \"`remittance_line` reversed (CLP02 = 22) | Emit `m25.remittance.claim_recouped` (M23 consumer + M26 cap-reversal subscriber)\" (WARDENX_MODULE_25_REMITTANCE_SPEC §4.5) — but M26's own `M26_SUBSCRIPTION_MAP`/file tree never built the consumer, an honest oversight kept declared rather than dropped on the strength of M26's silence alone (the F-101 caution, same direction as F-130's M21 D16 exception). Checking it also surfaced a genuine, deeper, PRE-EXISTING defect this pass reports rather than fixes: `handleClaimReversed` (`consumers/handlers.ts`, the already-built `record-reversal-line` handler for `m23.claim.replaced`/`.voided`) reads `p.patientId`/`p.claimId`/`p.priorPaidAmountCents` off the payload, and NEITHER catalogued payload carries any of those fields (`{originalClaimId, replacementClaimId|voidClaimId, reason}` — no patient, no amount) — every real delivery would silently `recorded: false` forever, invisible because no test exercises this action with a catalog-shaped payload and the whole `CapConsumerStore` is unbound regardless. Wiring `claim_recouped` through the same handler would inherit the identical defect (its own payload has no `patientId` either). Fixing it needs either richer M23/M24/M25 payloads or a by-claim accrual-line lookup `CapConsumerStore` does not expose — new design, not a catalog fix, so left unbuilt and reported here.",
    events: [
      "m23.claim.line_finalized",
      "m23.claim.replaced",
      "m23.claim.voided",
      "m25.remittance.advice_posted",
      "m25.remittance.claim_recouped",
      "m6.revocation.created",
      "m6.transfer.created",
    ],
  },
  {
    module: "m17",
    kind: "handlers-unbound",
    reason:
      "F-133 (#248) checked this group per-event against M17's own §4.3/§4.4 spec text (the D3/D14 EVV-authoritative state machine, the `m17.reassignment_needed` cascade, the portal-scope consent gate, the D2 orphan-encounter reconciliation) rather than trusting the six producing modules' `declaredConsumers` guesses — the F-101 rule. 12 of the 14 pairs are genuine, real, still-unbuilt subscriptions, not misdeclarations: `consumers/index.ts`'s own header names this exact gap (\"the EVV `m18.evv.check_in/out_recorded` advance bindings land with M18\"), and `M17_OUTBOX_SUBSCRIPTIONS` currently carries none of them — the visit lifecycle's EVV-authoritative `published → en_route → in_visit → completed` transitions (D3/D14) are entirely unwired despite the spec calling EVV the authoritative driver. All 5 `m18.evv.*` events are explicit in M18's own catalog comments (\"drive M17's visit-state transitions (D14)\", \"the geofence-confirmation stream M17 Scheduling reads\", \"M8/M17 re-read the bracket\", \"flows to M17/M8/M23\"). `m15.volunteer.assignment_inactivated` is M15's own catalog comment (\"so M17 must drop the volunteer from the schedule\") feeding the day-view `m17.reassignment_needed` cascade (M17 spec D3) — no reassignment-scan cron exists in M17 at all yet, for PTO, credential, or volunteer-gate reasons alike. `m19.triage_call.visit_needed` is extensively documented on the M19 side (spec §1, §2.2, acceptance criteria at §7.1/§7.9, performance targets) as the trigger for M17's D5 proposal-worker path, even though M17's own spec (written first) never mentions the inbound direction — kept per the F-101 caution (a specific, cross-referenced, done-means-tested producing-side decision outweighs the consuming spec's silence, the same shape as F-131's `m25.remittance.claim_recouped`). `m20.safety.high_risk_area_entered` and `.visit_cancellation_requested` are both explicit in M20's own \"Consumed by 17\" text and §4.10 outbox table (\"M17 also consumes... to surface a visit-row warning badge\"; \"(M17 consumer cancels the visit)\"). Both `m39.consent.delegated_access.granted`/`.revoked` are explicit in M39's own §4.10/§4.7 tables (\"M17 (portal-upcoming scope check)\") — M17's `PortalVisitReader`/`ConsentEvaluator` caregiver-scope gate. `m8.encounter.orphan_recorded` is explicit in M17's own D2 decision row and §12 checklist (\"`m8.encounter.orphan_recorded` consumer present in M17 (deny-stub until M8 publisher exists)\"). **2 of the 14 were genuinely misdeclared and are dropped at the source, not here**: `m20.safety.check_in_recorded` — M20's own description says \"info severity, no fan-out\", and M20's own \"Consumed by 17\" text describes M17's day-view \"last check-in\" fact as a `SafetyDashboardProvider.clinicianStatusForLocation` seam PULL, never this push event (M20's §4.10 table also carries no \"(M17 consumer...)\" annotation on this row, unlike the two kept M20 events above); `m5.patient.address_changed` — M17's own spec (§7.10) states outright \"M17 NEVER geocodes; geocoding requests are M5's geocode job which runs on `patient.address_changed` outbox\" — M17 only ever reads the geocoded result afterward via the `PatientAddressReader` seam pull, never this push event; M5's own `jobs/index.ts` confirms the real consumer is M5's own `m5.geocode_address` job, not M17.",
    events: [
      "m15.volunteer.assignment_inactivated",
      "m18.evv.at_patient_address",
      "m18.evv.check_in_recorded",
      "m18.evv.check_out_recorded",
      "m18.evv.event_corrected",
      "m18.evv.late_check_resolved",
      "m19.triage_call.visit_needed",
      "m20.safety.high_risk_area_entered",
      "m20.safety.visit_cancellation_requested",
      "m39.consent.delegated_access.granted",
      "m39.consent.delegated_access.revoked",
      "m8.encounter.orphan_recorded",
    ],
  },
  {
    module: "m16",
    kind: "handlers-unbound",
    reason:
      "F-134 (#248) checked this group per-event against M16's own §4.5 \"Outbox Subscriptions (Consumers in M16)\" table and `lifecycle/cascades.ts`'s three pure deciders, rather than trusting five producing modules' `declaredConsumers` guesses — the F-101 rule, this time mostly confirming the group rather than overturning it. M16 now binds two live consumers: the IDG risk intake and, since F-105, the §4.3.1 bereavement intake on `m6.bereavement.eligible` — the only path by which a `bereavement_plan` row can exist. **6 of 12 pairs are genuine, real, still-unbuilt subscriptions**, matching M16's own §4.5 table or a documented producing-side decision: `m39.consent.revoked` (§2.6 opt-out cascade, backed by a real pure decider, `decideConsentRevocationCascade`) and `m39.consent.signed` (§4.5's \"post-death-grant handler\", under the spec's stale name `consent.created` — M39's own catalog description says outright \"the M16 post-mortem grant when bereavement\"); `m5.patient.bereavement_opt_out_changed` (§4.5 + D9, backed by the real pure decider `decidePatientOptOutFlip`); `m6.admission.discharged` (filtered to `reason='death'`) — explicitly named in §4.5 as a deliberate \"secondary verifier (redundant safety net)\" against M6 failing to emit `bereavement.eligible`, not an oversight; `m6.discharge.cosigned` — the one remaining WRITTEN decider (`decideCosignReceipt`, the D18 gate release), blocked producer-side twice over (M6's `discharge_event` models no external source, so its `DeathDischargeReader` returns `internal_clinician_recorded` for EVERY decedent and no plan can carry the `external_source_metadata` a receipt would release; and the payloads do not meet — M6 publishes `dischargeEventId` + `medicalDirectorCosignedAt`, the decider reads `sourceProposalId` + `cosignedAt` + `medicalDirectorMembershipId`); `m37.ipu_admission.death_recorded` — explicitly named three times in M37's own spec (its state-transition table, its outbox-catalog table, its §4.9 alert-payload table) as \"M16 (bereavement onboarding)\", kept on that asymmetric evidence despite M16's own spec being silent on M37 (the F-131 `m25.remittance.claim_recouped` \"kept, not dropped\" caution). **6 of 12 were genuinely misdeclared and dropped at the source, all variants of the same defect**: `m15.plan.discharged` and `m7.care_plan.discharged` each carried a producing-module description claiming to \"seed the bereavement plan\" — false on its face, since F-105 already established `m6.bereavement.eligible` is the ONLY creation path, and neither event appears in M16's own §4.5 table; `m6.admission.activated` — an admission ACTIVATION carries no fact the bereavement program (which starts at DEATH) needs, picked up only as part of that event's broad 15-consumer fan-out (F-101's own comment there already flags the shape); `m6.discharge.death` — co-emitted from the SAME `runEffects` transition as `m6.bereavement.eligible` (`admission-route-service-db.ts`'s single `t.effects` map), and `bereavement.eligible`'s own description says it IS \"the post-rule check on `m6.discharge.death`\" — M16's real consumer (`consumers/m6-eligibility.ts`) reads only the derived event, never this one; `m5.patient.deceased` — a THIRD hop downstream of the same transaction (M5's own §7.8 death cascade reacting to `m6.discharge.death`, itself reacting to the death-discharge transition), carrying no fact M16's intake decider reads; `m39.consent.renewed` — unlike `.signed`/`.revoked`, neither M16's spec nor its cascades file names a renewal-triggered action anywhere, and the declaration reads as a mechanical carry-over from the sibling consent-lifecycle events' consumer lists rather than an independent decision. All 6 dropped at the source in each producing module's `events-by-mNN.ts` (M5 ×1, M6 ×2, M7 ×1, M15 ×1, M39 ×1).",
    events: [
      "m37.ipu_admission.death_recorded",
      "m39.consent.revoked",
      "m39.consent.signed",
      "m5.patient.bereavement_opt_out_changed",
      "m6.admission.discharged",
      "m6.discharge.cosigned",
    ],
  },
  {
    module: "m25",
    kind: "handlers-unbound",
    reason:
      "F-135 (#248) checked this group per-event against M25's own §4.4 spec text (the `boot.ts` subscribe list, which names exactly three inbound topics) and its real `consumers/subscription-map.ts` (the same three, frozen), rather than trusting M23/M24's `declaredConsumers` guesses. **2 of 11 pairs are genuine, real, still-unbound subscriptions**, matching both: `m23.claim.rejected` (the 277CA-derived pre-835 denial-worklist seed, D2/D3 — `handleClaimRejected` is written and unit-tested) and `m18.evv.aggregator_rejected` (the EVV-aggregator-rejection seed, M18 §4.10 — `handleEvvAggregatorRejected` is written and unit-tested); both sit on the frozen subscription-map with no live relay binding yet, the same posture as M26/M27. **9 of 11 were genuinely misdeclared and dropped at the source**, none of them present in M25's own subscribe list under any spelling: `m23.claim.acknowledged`/`.acknowledgment_partial`/`.submitted` and the four `m24.medicaid_claim.*` acknowledgment/submission siblings carry no CARC/denial fact for M25 to act on — only a 277CA REJECTION (or its EVV-aggregator sibling) seeds a worklist row before an 835 lands, and M25 pulls the Medicaid 835 itself over M24's per-state channel (D9) rather than subscribing to any M24 claim-lifecycle event at all; `m23.claim.denied` and `m24.medicaid_claim.denied` are each M25's OWN OUTPUT read backwards — both events' own descriptions say the DENIED transition is \"driven by M25\" (M25 posts the denial 835 that causes it), so M25 is the producer of the fact behind each, not a consumer of it. All 9 dropped at the source in each producing module's `events-by-mNN.ts` (M23 ×4, M24 ×5).",
    events: ["m18.evv.aggregator_rejected", "m23.claim.rejected"],
  },
  {
    module: "m31",
    kind: "no-consumer-surface",
    reason: "M31 has no consumer directory and binds nothing.",
    events: [
      "m12.medication_history_pulled",
      "m12.medication_order.active",
      "m12.medication_order.list_changed",
      "m13.administration.recorded",
      "m16.bereavement.contact_active",
      "m17.caregiver_reminder_due",
      "m17.visit.cancelled",
      "m17.visit.rescheduled",
      "m39.consent.delegated_access.granted",
      "m39.consent.delegated_access.revoked",
      "m8.encounter.signed",
    ],
  },
  {
    module: "m11",
    kind: "handlers-unbound",
    reason:
      "F-137 (#248) checked every remaining pair against M11's own spec (its authoritative 'Outbox events consumed' list) and, where M11's own text was silent, against the PRODUCING module's spec for a specific, decided, cross-referenced claim — the F-131 'kept, not dropped' caution. 9 of 10 are genuine, real, still-unbound subscriptions: `m9.assessment.significant_change` is on M11's own live subscription list (`consumers/index.ts`'s `M11_OUTBOX_SUBSCRIPTIONS`) with a written, unit-tested decider (`consumers/assessment-trigger.ts`) — deferred only because nothing binds it to the dispatcher yet; the three `m21.supply_request.*` events are each individually named by M21's own catalog description as a real M11 relationship ('M11 auto-completes a one-shot order…', 'M11 releases the source order', 'Emitted so M11 learns the cascade ARRIVED… M11 would hold the order open forever') and `status_changed` additionally matches M11's own spec text (§4.5, 'auto-complete one-shots') — no M11 consumer file exists yet (`m21-fulfillment-status.ts`, named in the spec's file tree, was never built); the two `m39.consent.dpoa.*` events are each named for M11 twice over in M39's own spec — its §4.10-style outbox table ('M11 (attribution refresh)') and its dpoa_healthcare revocation-cascade table ('M11 (acting-consent revalidation on active orders)') — plus a checklist item stating outright 'Event m39.consent.dpoa.agent_appointed → M7/M11/M14 backref consumers stubbed'; and the three `m7.intervention.*` events are named by M7's own mutation-consumer table ('M14, M11 (if linked)') and M7's schema carries `linked_order_id` precisely for this handoff — M7's own architecture note states the READ direction runs the other way (M11 pulls M7 when authoring a care-plan-driven order) but the table still names M11 as a push consumer for the linked-order case. 1 of 10 was genuinely misdeclared and dropped at the source: `m6.admission.activated` has no support anywhere — M11's own consumed-events list never names it, and no file, decider, or even a comment in `11-orders/` mentions admission activation — the same broad-fan-out-no-rationale shape F-134/F-136 already found for m16/m23 on this identical event.",
    events: [
      "m21.supply_request.cancel_no_op",
      "m21.supply_request.cancelled",
      "m21.supply_request.status_changed",
      "m39.consent.dpoa.agent_appointed",
      "m39.consent.dpoa.agent_removed",
      "m7.intervention.added",
      "m7.intervention.discontinued",
      "m7.intervention.updated",
      "m9.assessment.significant_change",
    ],
  },
  {
    module: "m19",
    kind: "handlers-unbound",
    reason:
      "M19 binds its two D10 inbound triggers live (#204's sibling, F-043: the no-show and late-checkout welfare checks). `m36-delivery-failed.ts` is a written decider whose topic has no producer at all — M36 contributes no event catalog (F-094/#205) — and the eight events below are the §4.8 roster and safety-escalation intakes, forward-declared with no decider written.",
    events: [
      "m17.reassignment_needed",
      "m17.time_off.approved",
      "m17.visit.assigned",
      "m17.visit.unassigned",
      "m20.safety.check_in_escalated",
      "m20.safety.sos_alert_raised",
      "m39.consent.delegated_access.granted",
      "m39.consent.delegated_access.revoked",
    ],
  },
  {
    module: "m5",
    kind: "handlers-unbound",
    reason:
      "M5 binds two live consumers (proposal applier, death cascade). The remainder are forward declarations.",
    events: [
      "m17.visit.assigned",
      "m17.visit.unassigned",
      "m24.medicaid_eligibility.checked",
      "m39.consent.expired",
      "m39.consent.recipient_removed",
      "m39.consent.renewed",
      "m39.consent.revoked",
      "m39.consent.signed",
      "m39.consent.supersedes",
      "m6.admission.activated",
    ],
  },
  {
    module: "m13",
    kind: "handlers-unbound",
    reason:
      "M13 binds one live consumer (PDF-rendered back-ref) and carries a `consumers/` surface that no binding reaches.",
    events: [
      "m12.medication_order.active",
      "m12.medication_order.discontinued",
      "m21.comfort_kit.deployed_at_patient",
      "m21.comfort_kit.replenished",
      "m21.comfort_kit.return_reconciliation",
      "m21.comfort_kit.returned",
      "m37.iv_safety_overlay.required",
      "m6.transfer.created",
    ],
  },
  {
    module: "m24",
    kind: "handlers-unbound",
    reason:
      "M24 binds one live consumer (submission-request enqueue); the remainder sit on its forward-declared `consumers/` subscription-map surface.",
    events: [
      "m18.evv.aggregator_accepted",
      "m18.evv.aggregator_cancelled",
      "m18.evv.aggregator_submitted",
      "m24.medicaid_claim.submission_failed",
      "m24.medicaid_eligibility.refresh_requested",
      "m5.patient.address_changed",
      "m5.patient.payer_changed",
      "m8.encounter.cosigned",
    ],
  },
  {
    module: "m8",
    kind: "handlers-unbound",
    reason:
      "M8 binds one live consumer (visit-seeded encounter). The remainder are forward declarations.",
    events: [
      "m18.evv.check_in_recorded",
      "m18.evv.check_out_recorded",
      "m18.evv.event_corrected",
      "m18.evv.late_check_resolved",
      "m6.admission.activated",
      "m7.care_plan.initial_overdue",
      "m7.care_plan.review_overdue",
      "m7.care_plan.version_signed",
    ],
  },
  {
    module: "m18",
    kind: "handlers-unbound",
    reason:
      "M18 binds one live consumer (register-published-visit). The remainder are forward declarations.",
    events: [
      "m17.visit.cancelled",
      "m17.visit.completed",
      "m17.visit.late_check_out_suspected",
      "m17.visit.rescheduled",
      "m17.visit.started",
      "m39.consent.delegated_access.granted",
      "m39.consent.delegated_access.revoked",
    ],
  },
  {
    module: "m21",
    kind: "handlers-unbound",
    reason:
      "F-120 (#248) bound two of the three `consumers/m11-orders.ts` deciders (`outbox-consumers/m11-order-cascade.ts`) — the cancellation cascade and the DME monthly-rental close-out, both already emitted in production by M11's discharge cascade (F-102). `supply_fulfillment_requested` stays unbound: its own IO resolver (`consumers/order-context.ts`) says no platform seam answers 'which Location serves this patient' and `supply_request.location_id` is NOT NULL, so binding it today would either dead-letter every delivery or require inventing a Location-resolution heuristic nobody has decided on. `m11.order.signed` is redundant with the still-unbound specific event once that lands (the F-101 shape) and stays declared until then. M21 also carries the M13 comfort-kit handler file and the pharmacy-dispensed event that no binding reaches.",
    events: [
      "m11.order.signed",
      "m11.order.supply_fulfillment_requested",
      "m12.medication_order.dispensed_at_pharmacy",
      "m13.comfort_kit.controlled_substance_discrepancy",
      "m13.comfort_kit.deployed",
      "m13.comfort_kit.replenishment_needed",
      "m13.comfort_kit.return_required",
    ],
  },
  {
    module: "m29",
    kind: "no-consumer-surface",
    reason: "M29 has no consumer directory and binds nothing.",
    events: [
      "m11.order.hl7_orm_requested",
      "m11.order.signed",
      "m20.safety.osha_reportable_incident_filed",
      "m20.safety.workers_comp_claim_initiated",
      "m35.invoice.paid",
      "m35.refund.executed",
      "m5.patient.archived",
    ],
  },
  {
    module: "m1",
    kind: "no-consumer-surface",
    reason:
      "M1 owns the dispatcher itself and has no consumer directory; these declarations name the foundation module as a subscriber to downstream events.",
    events: [
      "m23.mac_portal.recovered",
      "m23.mac_portal.unavailable",
      "m24.medicaid_state_channel.recovered",
      "m24.medicaid_state_channel.unavailable",
      "m33.lag.exceeded",
      "m33.lag.recovered",
    ],
  },
  {
    module: "m6",
    kind: "handlers-unbound",
    reason:
      "M6 binds one live consumer (admission-event applier). The remainder are forward declarations.",
    events: [
      "m11.order.level_of_care_change_signed",
      "m11.order.recertification_signed",
      "m19.triage_call.gip_admission_proposed",
      "m23.noe.accepted",
      "m23.notr.accepted",
      "m37.ipu_admission.bed_assigned",
    ],
  },
  {
    module: "m7",
    kind: "handlers-unbound",
    reason:
      "M7 binds one live consumer (apply-IDG-decision). The remainder are forward declarations.",
    events: [
      "m19.triage_call.care_plan_change_indicated",
      "m39.consent.dpoa.agent_appointed",
      "m39.consent.dpoa.agent_removed",
      "m9.assessment.recorded",
      "m9.assessment.significant_change",
    ],
  },
  {
    module: "m35",
    kind: "no-consumer-surface",
    reason: "M35 has no consumer directory and binds nothing.",
    events: [
      "m32.capability.invoked",
      "m32.tenant_opt_in.recorded",
      "m32.tenant_opt_in.revoked",
      "m34.tenant.offboarding_initiated",
      "m34.tenant.provisioned",
    ],
  },
  {
    module: "m2",
    kind: "no-consumer-surface",
    reason: "M2 has no consumer directory and binds nothing.",
    events: [
      "m18.evv.device_approved",
      "m18.evv.device_suspended",
      "m39.consent.revoked",
    ],
  },
  {
    module: "m32",
    kind: "no-consumer-surface",
    reason: "M32 has no consumer directory and binds nothing.",
    events: [
      "m16.bereavement.risk_score_computed",
      "m19.triage.summary_requested",
      "m8.hearthnote.layer2_enhanced",
    ],
  },
  {
    module: "m37",
    kind: "no-consumer-surface",
    reason: "M37 has no consumer directory and binds nothing.",
    events: [
      "m19.triage_call.gip_admission_proposed",
      "m6.admission.activated",
      "m6.admission.discharged",
    ],
  },
  {
    module: "m9",
    kind: "no-consumer-surface",
    reason: "M9 has no consumer directory and binds nothing.",
    events: [
      "m13.prn_administration_recorded",
      "m8.encounter.signed",
      "m8.vitals.captured",
    ],
  },
  {
    module: "m12",
    kind: "handlers-unbound",
    reason:
      "M12 binds two live consumers (IDG decision intake, document back-ref) and carries three further handler files that no binding reaches.",
    events: [
      "m13.reconciliation.discontinue_requested",
      "m13.reconciliation.draft_order_requested",
    ],
  },
  {
    module: "m10",
    kind: "handlers-unbound",
    reason:
      "M10 binds one live consumer (admission timepoint scheduling). The remainder are forward declarations.",
    events: [
      "m8.encounter.signed",
    ],
  },
  {
    module: "m3",
    kind: "no-consumer-surface",
    reason: "M3 has no consumer directory and binds nothing.",
    events: [
      "m39.consent.supersedes",
    ],
  },
];
