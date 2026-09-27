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
      "M14 has a `consumers/` surface (consumers/index.ts) whose handler code exists and whose dispatcher binding does not reach it. F-104 removed the six §4.5 D8 AUTO-CLOSE events from this group by binding them (`consumers/bindings.ts`) — and by fixing the defect underneath, `idg_action_item.linked_artifact_id` being written by no code path, without which a live handler would have matched nothing forever. What remains is the other three shapes M14 describes and has not built: the M6 inclusion cache (which patients belong to a location's next meeting), the M9/M10/M11/M12 'since last IDG' Valkey projection cache, and the M22 packet back-ref — which additionally has no producer, since `m14.packet.document_requested` is catalogued by nobody.",
    events: [
      "m10.hope.j2051_trigger_fired",
      "m10.hope.sfv_created",
      "m10.hope.timepoint_scheduled",
      "m10.hope.timepoint_signed",
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
      "m39.consent.dpoa.agent_appointed",
      "m39.consent.dpoa.agent_removed",
      "m39.consent.expiring_soon",
      "m6.admission.activated",
      "m6.admission.discharged",
      "m6.admission.on_hold",
      "m6.admission.resumed",
      "m6.compliance.window.opened",
      "m6.compliance.window.overdue",
      "m6.cti.drafted",
      "m6.cti.late_flagged",
      "m6.cti.voided",
      "m6.discharge.created",
      "m6.f2f.scheduled",
      "m6.f2f.window_missed",
      "m6.f2f.window_overridden",
      "m7.care_plan.version_drafted",
      "m7.goal.added",
      "m7.goal.discontinued",
      "m7.goal.met",
      "m7.goal.updated",
      "m7.intervention.added",
      "m7.intervention.discontinued",
      "m7.intervention.updated",
      "m7.problem.added",
      "m7.problem.resolved",
      "m7.problem.updated",
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
      "M23 binds three real consumers: remittance feedback, submission-request enqueue, and — since F-106/F-107 — the NOE draft on `m6.election.period_started` and the NOTR draft on `m6.revocation.created` / `m6.transfer.created` / `m6.discharge.created`, the first writers `noe_record` and `notr_record` have ever had. The remaining declarations sit on its `consumers/` subscription-map surface, whose header calls the topics forward-declared and inert pending the live inbound relay; that relay landed, so what is left is the per-effect Drizzle work, not a platform phase. Each of the rest needs a port the composition root has nothing to bind: `enqueueRevalidation` (the §11.A re-validation job queue), `freezeNewClaims` (the `m5.patient.deceased` claim freeze) and `recordDocumentBackReference` (the M22 render receipt, which additionally waits on M22 publishing a claim-artifact template).",
    events: [
      "m11.order.level_of_care_change_signed",
      "m11.order.recertification_signed",
      "m18.evv.late_check_resolved",
      "m23.claim.draft_created",
      "m25.denial.resolved_favorable_via_appeal",
      "m25.taxonomy.unmapped_code_observed",
      "m37.census.snapshot_taken",
      "m37.ipu_admission.bed_assigned",
      "m37.ipu_admission.discharged",
      "m37.ipu_admission.transferred",
      "m5.patient.deceased",
      "m5.patient.payer_changed",
      "m6.admission.activated",
      "m6.admission.discharged",
      "m6.cti.signed",
      "m6.election.period_ended",
      "m6.f2f.attested",
      "m6.loc.changed",
      "m6.nor.acknowledged",
      "m8.encounter.cosigned",
    ],
  },
  {
    module: "m27",
    kind: "handlers-unbound",
    reason:
      "THE PREVIOUS REASON WAS WRONG ABOUT EVERY MEMBER OF THIS GROUP, the F-099 shape at full scale. It read: M27's `consumers/subscription-map.ts` + `handlers.ts` are the M25/M26 mirror, the topics are forward-declared and registered inert until the live inbound relay lands. That map names THREE topics — `m22.document.rendered` (bound in F-108), `m25.denial.opened` and a non-existent M40 offboard name — and NOT ONE of the events below. They were never forward-declared; they were never declared at all, and the relay they were said to be waiting on has landed. What is actually true: M27's input model is a seam PULL, not a subscription. The §4.8 `statistics-refresh` job re-aggregates the S-3 patient-day census from M6's `LevelOfCarePeriodReader`/`AdmissionCensusReader` and the visits-by-discipline from M8's `EncounterStatisticsProvider`; `refresh-inputs` materializes the trial balance; the M23/M26 revenue and cap facts arrive through M27's own (currently deny-stubbed) forward-seam readers. So every event below names as a PUSH consumer a module that resolves the same fact by PULL, and each one defers on a binding that will never be written — nine of them (`m21.supply_request.invoice_*`, `m26.cap.accrual_recorded`/`.settlement_*`/`.year_*`, `m8.mileage.captured`) naming m27 and nobody else, so every emission is a row re-claimed every thirty minutes for the life of the deployment with no consumer anywhere. The correction is the F-101 sweep — drop `m27` from these `declaredConsumers` and let the nine become record-only — not a binding, and it needs the same per-event verification F-101 gave m6's seven rather than a blanket edit.",
    events: [
      "m21.supply_request.invoice_accrued",
      "m21.supply_request.invoice_reconciled",
      "m23.claim.paid",
      "m23.claim.replaced",
      "m23.claim.voided",
      "m24.medicaid_claim.paid",
      "m24.medicaid_claim.replaced",
      "m24.medicaid_claim.voided",
      "m26.cap.accrual_recorded",
      "m26.cap.settlement_finalized",
      "m26.cap.settlement_proposed",
      "m26.cap.year_closed",
      "m26.cap.year_closing",
      "m26.cap.year_opened",
      "m37.census.snapshot_taken",
      "m37.ipu_admission.discharged",
      "m37.ipu_admission.transferred",
      "m6.admission.activated",
      "m6.admission.discharged",
      "m6.election.period_ended",
      "m6.election.period_started",
      "m6.loc.changed",
      "m8.mileage.captured",
    ],
  },
  {
    module: "m26",
    kind: "handlers-unbound",
    reason:
      "M26's `consumers/subscription-map.ts` states it verbatim: 'the boot dispatcher binds each topic to its handler when the live inbound relay lands; until then these are forward-declared (registered, inert)'. The Drizzle `CapConsumerStore` is deferred behind the M5 MBI + M6 first-election readers.",
    events: [
      "m23.claim.acknowledged",
      "m23.claim.line_finalized",
      "m23.claim.paid",
      "m23.claim.replaced",
      "m23.claim.voided",
      "m24.medicaid_claim.acknowledged",
      "m24.medicaid_claim.paid",
      "m24.medicaid_claim.replaced",
      "m24.medicaid_claim.voided",
      "m25.remittance.advice_posted",
      "m25.remittance.claim_recouped",
      "m37.census.snapshot_taken",
      "m37.ipu_admission.discharged",
      "m37.ipu_admission.transferred",
      "m6.admission.activated",
      "m6.admission.discharged",
      "m6.discharge.created",
      "m6.election.period_ended",
      "m6.election.period_started",
      "m6.loc.changed",
      "m6.revocation.created",
      "m6.transfer.created",
    ],
  },
  {
    module: "m34",
    kind: "handlers-unbound",
    reason:
      "M34 binds one live consumer (`m34.tenant-provision-enqueue`). The rest are forward declarations against the platform-ops surfaces — several of them the same offboarding/shred chain #105 unblocked.",
    events: [
      "m20.safety.coverage_gap_detected",
      "m20.safety.device_attestation_anomaly",
      "m20.safety.sos_terminus_reached",
      "m23.mac_credential.updated",
      "m24.medicaid_trading_partner.updated",
      "m27.cost_report.accepted",
      "m27.cost_report.closed",
      "m27.cost_report.created",
      "m27.cost_report.reopened",
      "m27.cost_report.submitted",
      "m30.cop.status_changed",
      "m30.sra.cycle_closed",
      "m35.subscription.activated",
      "m35.subscription.canceled",
      "m35.subscription.created",
      "m35.subscription.paused",
      "m35.subscription.plan_changed",
      "m35.subscription.resumed",
      "m35.subscription.status_changed",
      "m35.subscription.suspended",
      "m35.tenant.billing_blocked",
    ],
  },
  {
    module: "m17",
    kind: "handlers-unbound",
    reason:
      "M17 has a `consumers/` surface that yields no live binding: handler code exists and no dispatcher binding reaches it.",
    events: [
      "m15.volunteer.assignment_inactivated",
      "m18.evv.at_patient_address",
      "m18.evv.check_in_recorded",
      "m18.evv.check_out_recorded",
      "m18.evv.event_corrected",
      "m18.evv.late_check_resolved",
      "m19.triage_call.visit_needed",
      "m20.safety.check_in_recorded",
      "m20.safety.high_risk_area_entered",
      "m20.safety.visit_cancellation_requested",
      "m39.consent.delegated_access.granted",
      "m39.consent.delegated_access.revoked",
      "m5.patient.address_changed",
      "m8.encounter.orphan_recorded",
    ],
  },
  {
    module: "m16",
    kind: "handlers-unbound",
    reason:
      "M16 now binds two live consumers: the IDG risk intake and, since F-105, the §4.3.1 bereavement intake on `m6.bereavement.eligible` — the only path by which a `bereavement_plan` row can exist. `m6.discharge.cosigned` is the one remaining WRITTEN decider (`decideCosignReceipt`, the D18 gate release) and it is blocked producer-side twice over: M6's `discharge_event` models no external source, so its `DeathDischargeReader` returns `internal_clinician_recorded` for EVERY decedent and no plan can carry the `external_source_metadata` a receipt would release; and the payloads do not meet — M6 publishes `dischargeEventId` + `medicalDirectorCosignedAt`, the decider reads `sourceProposalId` + `cosignedAt` + `medicalDirectorMembershipId`. The rest have no handler written at all.",
    events: [
      "m15.plan.discharged",
      "m37.ipu_admission.death_recorded",
      "m39.consent.renewed",
      "m39.consent.revoked",
      "m39.consent.signed",
      "m5.patient.bereavement_opt_out_changed",
      "m5.patient.deceased",
      "m6.admission.activated",
      "m6.admission.discharged",
      "m6.discharge.cosigned",
      "m6.discharge.death",
      "m7.care_plan.discharged",
    ],
  },
  {
    module: "m25",
    kind: "handlers-unbound",
    reason:
      "M25 binds one live consumer (`m25.parse-and-post`). The rest sit on its `consumers/` subscription-map surface, forward-declared and inert on the same footing as M26/M27.",
    events: [
      "m18.evv.aggregator_rejected",
      "m23.claim.acknowledged",
      "m23.claim.acknowledgment_partial",
      "m23.claim.denied",
      "m23.claim.rejected",
      "m23.claim.submitted",
      "m24.medicaid_claim.acknowledged",
      "m24.medicaid_claim.acknowledgment_partial",
      "m24.medicaid_claim.denied",
      "m24.medicaid_claim.rejected",
      "m24.medicaid_claim.submitted",
    ],
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
      "M11 binds two live consumers (IDG decision intake, document back-ref) and carries four further handler files (admission-discharged-discontinue, assessment-trigger, hope-trigger, suggestion-banner) that no binding reaches.",
    events: [
      "m21.supply_request.cancel_no_op",
      "m21.supply_request.cancelled",
      "m21.supply_request.status_changed",
      "m39.consent.dpoa.agent_appointed",
      "m39.consent.dpoa.agent_removed",
      "m6.admission.activated",
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
      "M21 binds one live consumer (document back-ref) and carries three further handler files (m11-orders, m13-comfort-kit, order-context) that no binding reaches.",
    events: [
      "m11.order.discontinued",
      "m11.order.signed",
      "m11.order.supply_cancellation_requested",
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
