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
      "F-115 (#248) split this group in two — the blanket 'M30 is a producer, not a subscriber; no consumer directory exists' reason (M30-T… original) was FALSE for these four: `packages/quality/src/consumers/` is a real, unit-tested consumer directory (`handlers.ts` + `subscription-map.ts`, the §4.10 upstream fan-out — recompute enqueues, the mortality-review auto-draft, the CAHPS candidate seed, the medication-error incident auto-draft) that RULE 3(d) ships pure with no boot-wired binding, the same shape M23/M25/M26/M27 were already correctly classified `handlers-unbound` under. Two of `M30_OUTBOX_SUBSCRIPTIONS`'s six topics (`m6.discharge.death`, `m6.election.signed`) were already carried as a `handler-unbound` entry in outbox-subscription-exceptions.ts because the catalog never declared m30 on them; these four are the mirror case — the catalog DOES declare m30, and it is the binding that is missing. F-150 (#248) BOUND two of the four for real — `m10.hope.submission_accepted` (after widening its payload with `providerEntityId`, the fact the real consumer needs but the catalog never carried) and `m23.claim.adjudicated` (already carried everything needed) — both via the real `enqueueRecompute` port (`apps/backend/src/modules/30-quality/outbox-consumers/`), the first genuinely-bound relationship this whole registry has produced rather than a catalog correction. The other two stay unbound, for two DIFFERENT reasons, not the same one: `m12.medication.error_reported`'s handler (`createIncidentDraft`) needs a resolvable 'M30 service membership' for `incident_report.reported_by_membership_id` (NOT NULL) that no system-actor-membership convention anywhere in this codebase currently provides — genuinely blocked, not merely unwired. `m18.evv.visit_verified` is a DIFFERENT class of gap entirely, found while scoping this bind: M18's own `domain/event-lifecycle.ts` `recordEvent` decider declares the outbox effect, but the REAL production check-in/check-out write path (`evv-route-service-db.ts`) never calls that decider at all — it emits `check_in_recorded`/`check_out_recorded`/`at_patient_address`/`geofence_breach_recorded` inline and never `visit_verified`. This event is not merely unbound on M30's side, it is never PUBLISHED on M18's side — a producer-side gap in a different module, reported here rather than fixed, since it needs M18's own write path changed, not an M30 consumer.",
    events: ["m12.medication.error_reported", "m18.evv.visit_verified"],
  },
  {
    module: "m30",
    kind: "no-consumer-surface",
    reason:
      "F-115 (#248) — the ORIGINAL blanket reason here ('M30 is a producer, not a subscriber … no consumer directory exists') was wrong about 27 of this group's members, checked individually rather than assumed: they are the exact facts M30's OWN nightly recompute seams already read (`apps/backend/src/modules/30-quality/jobs/m30-jobs.ts` — `AdmissionOnsetReader`/`DischargeReader`/`LevelOfCarePeriodReader` (M6), `CarePlanCycleCountsView` (M7), `SignedEncountersReader` (M8), the live M10 HOPE rollup, `VerbalTimelinessCountsView` (M11), `MedicationAdministrationProvider`'s PRN/missed-dose counts (M13), `IdgScheduleProvider` (M14), `DisciplineComplianceProvider`'s supervisory counts (M15), `BereavementComplianceProvider.copOutreachCounts` (M16), `VisitMetricsProvider` (M17), `QualityCostReportConsumer` (M27) — verified per event against the actual seam query, not inferred from module proximity (three initially-plausible candidates — `m16.bereavement.plan_closed_*`/`plan_skipped_per_patient_opt_out`, whose numerator/denominator membership `copOutreachCounts` does not establish, and `m13.administration.recorded`/`refused`/`corrected`/`voided`, whose measures scan `scheduled_dose`/PRN-specific rows rather than the general administration stream — were checked and are NOT among the 27, and stay in this list). Those 27 are now declared correctly (`seamConsumers`, dropped from `declaredConsumers`, on each event's own `events-by-mNN.ts` entry) and no longer appear below; a deferral was never the right shape for a relationship that already resolves by seam and will never bind an outbox consumer. `m30.infection.event_recorded`'s 'self-subscriber' declaration is also gone: `recordInfectionEvent` runs the §7.8 outbreak-window scan INLINE in the same transaction, and nothing has ever consumed this event via the outbox. What remains below is the honest count: M20/M21/M23(noe/notr)/M25/M26/M37/M39/M9 facts M30 has no current seam for at all, three M6 facts (`applier.refused`, `compliance.window.*`, `f2f.window_*`, `admission.on_hold`/`.resumed`) outside the four M6 readers' documented scope, `m8.hearthnote.layer2_enhanced` (no late-entry/signed-encounter relevance), and three bereavement facts whose seam METHOD exists (`BereavementComplianceProvider.planClosureCounts`/`riskScreeningCompletenessCounts`) but is not yet called by any of the eleven measures m30-jobs.ts currently registers — a dormant capability, not a bound one (`bound is not computing`, F-042). F-148 (#248) finished the M16 sweep on the two events F-115 left unchecked: `plan_skipped_per_patient_opt_out` stays for the same 'genuine gap' reason as the plan_closed_* trio (it carries no `planId` — no plan is ever opened on this path — so `planClosureCounts`, which is keyed by `BereavementPlanClosureReason`, cannot answer it either; whether an opt-out-skipped death belongs in the CoP denominator is a real, undecided product question). `contact_referred_external` is GONE from this list, not merely re-verified: M30's own §1.1 relationship-inventory text scopes its whole M16 relationship to the CoP coverage measure ('M30 emits no bereavement data and writes nothing to M16'), `M30_OUTBOX_SUBSCRIPTIONS` has no `m16.*` key at all, `IncidentKind` has no member the referral maps to, and M16's own worked 'Done means' example for this exact transition narrates M36's alert and M22's letter render and names no M30 action — the event's terse table cell ('M30 incident potential') is unsupported everywhere that would have to carry it if it were real, dropped at the source rather than deferred. F-149 (#248) finished this group with six parallel per-producer sweeps against M30's own §1.1 relationship inventory (docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md) and its own blanket §353 principle ('Outbox publication is the only cross-module communication M30 performs at the boundary … M30 *calls* … reader seams as in-process function calls'), which decisively settled 36 of the 60 remaining events. **11 moved to seamConsumers, not dropped bare**: all 8 M11 order events (M11's own spec §D14 names a real `OrderProvider` seam M30 has not built the completion/transmission/results methods for yet), M21's 5 comfort-kit/controlled-substance/par events (M21's own spec names the real `SupplyFulfillmentProvider`/`ComfortKitDispatchProvider` seams by the exact measure), M14's 2 IDG review-clock events (M30's own `IdgScheduleProvider` seam is ACTIVELY called today, feeding a currently-registered measure), and `m39.consent.signed` (M30's `ConsentEvaluator.evaluate` is likewise active, per-actor, at read time — a live seam pull has nothing to invalidate from a signing push). **18 dropped clean, unsupported on both sides**: all 12 remaining M13 eMAR events (M30's own `M30_OUTBOX_SUBSCRIPTIONS` — its own header calls itself 'the SINGLE SOURCE OF TRUTH' — has exactly six keys and none is `m13.*`; the measures M13's spec claims feed M30, like a 'reconciliation-completed-in-time' measure, do not exist anywhere in M30's registered measure set), all 3 M20 field-safety events (M30's own spec is a flat denial — 'Field safety. Module 20. No M30 consumption path'), `m37.ipu_admission.discharged` (redundant sibling — the death case is carved out to the already-declared `death_recorded`), and `m8.hearthnote.layer2_enhanced` (M30's own D16 ten-event recompute-trigger list excludes it; only the different, already-declared `m8.encounter.signed` is on that list). **2 corrected from an initial MOVE-TO-SEAM recommendation to DROP on independent re-verification**: `m25.denial.opened` and both `m26.cap.*` events were first read as forward seams on the strength of M25's/M26's own aspirational spec text, but M30's own §1.1 inventory FLATLY denies both — 'Remittance posting. Module 25. No M30 consumption path' and 'Cap management. Module 26. No direct M30 consumption … not quality measures' — a stronger, decisive statement than the M19/M21 entries' genuinely conditional 'may consume … when the seam lands' phrasing, and the consuming module's own decisive text wins per F-101. What remains below (24 events) is now the honest, fully-swept residue: real, still-unbuilt relationships M30's own spec decisively names (M6's 9 admission/compliance/F2F-window events — every one independently cross-referenced 2-4 times in M6's own spec text; M15's 4 events; 5 of M16's 6; M23's 2 NOE/NOTR-breach events; M37's `restraint.applied` and `death_recorded`; M12's `medication_order.transmission_failed`), plus `m9.assessment.recorded`, which M9's own spec frames as a recompute-invalidation push a read-time seam would not naturally capture and which no seam currently covers either.",
    events: [
      "m12.medication_order.transmission_failed",
      "m15.discipline_assessment.amended",
      "m15.plan.discharged",
      "m15.plan.version_signed",
      "m15.volunteer.ratio_recomputed",
      "m16.bereavement.plan_closed_completed",
      "m16.bereavement.plan_closed_declined",
      "m16.bereavement.plan_closed_early",
      "m16.bereavement.plan_skipped_per_patient_opt_out",
      "m16.bereavement.risk_score_computed",
      "m23.noe.window_breached",
      "m23.notr.window_breached",
      "m37.ipu_admission.death_recorded",
      "m37.restraint.applied",
      "m6.admission.on_hold",
      "m6.admission.resumed",
      "m6.applier.refused",
      "m6.compliance.window.closed",
      "m6.compliance.window.opened",
      "m6.compliance.window.overdue",
      "m6.compliance.window.overridden",
      "m6.f2f.window_missed",
      "m6.f2f.window_overridden",
      "m9.assessment.recorded",
    ],
  },
  {
    module: "m22",
    kind: "handlers-unbound",
    reason:
      "M22 renders on REQUEST. Its live binding consumes `M22_DOCUMENT_REQUEST_EVENTS`, and a module that wants a document emits a render request which M22 answers with `m22.document.rendered`. NOTE (F-099): a reason written for the whole group was WRONG for six of its members (the REQUEST spelling itself, unconsumed); those are bound. M6's six CoP documents were then bound directly (F-100) per the M22 spec's own §4.11 table, which routes those SOURCE events to the renderer with no `document_requested` needed. F-117 (#248) re-checked the ORIGINAL claim that 'for M11/M12/M13/M21/M23/M33 the request half IS wired, so the source declaration is redundant' PER EVENT rather than per module — it was right for exactly 4 of the ~20 events across those six modules (the ones actually co-emitted with a `document_requested` sibling in the SAME transition: `m11.order.signed`/`.standing_spawned`, `m12.medication_order.signed`, `m13.reconciliation.completed` — all now dropped from `declaredConsumers`, no `seamConsumers` replacement, since the artifact is delivered via the other event) and WRONG for the rest, which are separate order/claim/billing lifecycle events on the SAME modules with no such sibling and stay genuinely declared. Two more were dropped as never needing a render at all, not merely redundant: `m37.body_release.completed` (the PRIOR transition's own guard already requires the document to exist — `releaseBody` refuses without a signed `body_release_authorization`) and `m27.cost_report.reopened` (resets to `draft`; no job, no request, nothing to render until the next `submitted`). `m27.cost_report.submitted` was dropped on the F-108 precedent — it enqueues the `ecr-generation` job rather than emitting a request itself, and that job's own `m27.artifact.render_requested` is the real, already-bound handshake. `m37.body_release.funeral_home_identified` was dropped the ordinary way: `identifyFuneralHome` co-emits `m37.body_release.document_requested` in the same transition. F-142 (#248) added a genuinely misdeclared arrival from the (now-deleted) m32 group: `m19.triage.summary_requested` had been wrongly declared to m32 (a documentation error in `events-by-m19.ts`'s own inline comment), corrected at the source once M19's own locked spec — cited three separate ways — and `packages/types/src/oncall.ts`'s own payload doc comment both settled the real consumer as M22, for a caregiver/attending PDF render request. Genuinely unbuilt on both sides (no producer emits it yet either). F-144 (#248) finally ran the F-101 per-event sweep the group's own prior reason had flagged as outstanding on 38 events spread across eleven producing modules — checked in six parallel producer-clustered forks against M22's own §4.11 consumer table and each producing module's spec/code. **28 of 38 were genuinely misdeclared and dropped at the source**: all five remaining M11 order events (`corrected`, `discontinued`, `level_of_care_change_signed`, `recertification_signed`, `supply_fulfillment_requested` — the last three either redundant with a co-emitted/downstream sibling M22 already renders off, or with no support in M22's table at all — `level_of_care_change_signed`'s own 'M22 renders the LOC-change form' claim was checked against the real `PLATFORM_TEMPLATE_TABLE` and confirmed to name no such template, matching the standing F-101 finding on its own downstream `m6.loc.changed` sibling); `m8.encounter.voided` (structurally impossible — `ENCOUNTER_GRAPH` legalizes `void` only from `draft`, so a voided encounter can never have had a PDF rendered to suppress); `m14.meeting.adjourned` (redundant — co-emitted alongside `m14.minutes.signed`, M22's real trigger, in the same transition); both remaining M15 events (`discipline_assessment.amended`, `plan.discharged` — M15's own Lock-status section names only `plan.version_signed` as the M22 trigger); all four remaining M16 bereavement-plan events (`plan_opened` redundant with its co-emitted `outreach_artifact_requested` sibling; `plan_closed_completed`/`.declined`/`.early` unsupported — M22's own table names only `outreach_artifact_requested`/`bereavement.anniversary_due` for M16, and none of the three closure deciders emit a render-request sibling); `m37.ipu_admission.death_recorded` (M22's own spec never mentions a magic-link surface at all; F-147 (#248) ran down the 'internally inconsistent' M37 citation this entry flagged and confirmed it as one imprecise summary-table row against 15+ decisive citations elsewhere in M37's own spec naming the LATER `m37.body_release.funeral_home_identified` as the real magic-link trigger, and M22 — never M2 — as its architecture-§7.8-named consumer; that event's own magic-link half stays genuinely unbuilt, see the m37 group); five of six M23 billing events (`claim.acknowledged`/`.rejected`/`.submitted`, `noe.submitted`, `notr.submitted` — each redundant with the one real trigger, `m23.billing.document_render_requested`, which M23's own §4.10 table names explicitly as the sole M22 handshake point, confirmed against `consumers/document-render.ts`'s four builder functions and their exact payload shapes); three of four M24 events (`medicaid_claim.acknowledged`/`.rejected`/`.submitted` — the identical M23 shape one module over, redundant with `medicaid_billing.document_render_requested`); `m25.appeal.submitted` (redundant — co-emitted alongside the already-live-bound `m25.appeal_packet.render_requested` in the same transition, confirmed in `write-service-drizzle.ts`); all three M30 events (`incident.submitted`, `qapi.project_chartered`, `qapi.pip_closed` — each catalog description's own 'renders ... on request' phrasing describes a route-triggered mechanism, not a push, and M30's spec names five dedicated `*.render_requested` events for this purpose that were never catalogued or emitted anywhere — a producer-side gap reported, not fixed); and both remaining M5 events (`privacy_flag_changed`, redundant with the identical F-115/M28 shape — SUD redaction applied fresh per read via M3's `sud_consent_present` predicate, not a cached flag; `unmerged` — M5's own locked D8 states merge re-points FK references through a live resolver with no destructive UPDATE, so there is nothing for a push event to correct). **10 of 38 confirmed genuine**, no catalog change needed: `m14.minutes.amended` and `m7.care_plan.version_signed` (both decisively named in their producing module's own outbox table); `m17.caregiver_reminder_due`, `m21.supply_request.delivered`, and all three `m39.consent.{expired,recipient_added,recipient_removed}` events (each decisively named in the producing module's own outbox table, the F-131 'kept, not dropped' asymmetry since none of these appear in M22's own §4.11 table either); and three already-correctly-declared 'document_render_requested'-shaped events that anchor the M23/M24/M25 redundant-sibling drops above (`m23.billing.document_render_requested`, `m24.medicaid_billing.document_render_requested`, `m25.denial_resolution_letter.render_requested`) — all three confirmed genuinely unbuilt on the PRODUCER side too (no emit site anywhere for any of them), a real gap in M22's own request-list maintenance separate from the catalog-declaration question this sweep answers. What remains below (31 events) is the same three-way split the group's reason previously described, now fully swept: real named gaps from M22's own §4.11 table with no consumer built, one stale cross-reference already corrected, and the 10 confirmed-genuine events above plus the two version-append/transfer-variant M6 events untouched since F-099.",
    events: [
      "m11.order.draft_created",
      "m11.order.results_received",
      "m12.medication_order.draft_created_from_extraction",
      "m12.medication_order.list_changed",
      "m12.medication_order.signature_requested",
      "m12.medication_order.transmitted",
      "m13.administration_record.document_requested",
      "m14.minutes.amended",
      "m14.minutes.signed",
      "m14.packet.render_requested",
      "m15.plan.version_signed",
      "m17.caregiver_reminder_due",
      "m18.evv.aggregator_accepted",
      "m18.evv.verification_pdf_requested",
      "m19.triage.summary_requested",
      "m21.supply_request.delivered",
      "m23.billing.document_render_requested",
      "m24.medicaid_billing.document_render_requested",
      "m25.denial_resolution_letter.render_requested",
      "m39.consent.expired",
      "m39.consent.recipient_added",
      "m39.consent.recipient_removed",
      "m39.consent.revoked",
      "m5.patient.draft_created_from_extraction",
      "m5.patient.merged",
      "m6.discharge.cosigned",
      "m6.transfer.created",
      "m7.care_plan.version_signed",
      "m8.encounter.addendum_signed",
      "m8.encounter.signed",
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
      "What remains here is the REAL 'since last IDG'/inclusion-cache/M22-back-ref shape M14's own spec names and has not built (9 events: the two M6 inclusion-cache events, M9's `recorded`/`significant_change`, M10's `j2051_trigger_fired`/`sfv_created`, M11's `order.discontinued`, M12's `medication_order.discontinued`, and F-142's `m19.triage_call.care_plan_change_indicated` — the M22 back-ref additionally has no producer, since `m14.packet.document_requested` is catalogued by nobody); plus 5 events F-145 confirmed genuine on decisive producer-module evidence after the originally-ambiguous 22 were finally checked against each producing module's OWN spec rather than left 'kept absent stronger evidence.' " +
      "F-145 (#248) ran that check on all 22, split across five producer-clustered forks. **17 of 22 were genuinely misdeclared, all a single shape repeated at scale — the seam-vs-push trap, the identical F-129 finding for M7/M9/M10 now extended to M6 and all twelve M13 eMAR events**: M13's own D16 publishes `MedicationAdministrationProvider`/`ReconciliationProvider` with M14 named as a read-path consumer for BOTH, and M14's own exhaustive 'Done means' build walkthrough (the eleven seam reads + four Valkey-projected outbox topics) never names a single M13 event — confirmed against M13's own primary 'Consumed by 14' line ('IDG packets show administrations since last IDG via M13's `getAdministrationsSince` seam and missed-dose count since last IDG via the same seam's aggregation projection'), which directly contradicts M13's own looser §4.10 per-event table listing M14 as a consumer on all twelve — the F-101 rule applied to a module's OWN two self-contradicting statements, trusting the decisive one. **This reverses the group's own PRIOR framing**, which had called `m13.scheduled_dose.missed` 'the strongest candidate to eventually bind' on a payload-shape resemblance to `PacketFlaggedEventDigest`'s `missed_dose` kind — a weaker signal than M13's own decisive seam-publication text, now correctly moved to `seamConsumers` alongside its eleven siblings (all twelve, never dropped bare — the seam relationship is real, just not outbox-shaped). Four M6 events (`admission.on_hold`/`.resumed`, `compliance.window.opened`/`.overdue`) had no support in M14's own build-description at all, and `compliance.window.overdue` was contradicted outright by M6's own text assigning the real consumer to M36's escalation chain, not M14 — the strongest form of counter-evidence, not mere silence. `m9.assessment.amended` is a redundant sibling: emitted in the SAME transaction as the correcting row's `m9.assessment.recorded`, M14's own real, live-bound subscription — the corrected value arrives via `.recorded` regardless. **5 of 22 confirmed genuine, no catalog change needed**: `m12.medication_history_pulled` (M12's own spec, twice: 'M14 (IDG packet)' / 'M14 (IDG packet refresh)') and `m39.consent.expiring_soon` (M39's own outbox table: 'M36 (alert), M14 (compliance tile)') — both the F-131 'kept, not dropped' asymmetry; and all three M15 events (`idg_decision.applied`, `plan.bootstrapped`, `plan.version_signed`) — M15's own real §4.10-style outbox table names M14 decisively for all three, the most decisive evidence type this series recognizes. `m15.idg_decision.applied` was checked specifically for the wrong-direction trap (is it just an echo of M14's own outbound `idg.decision_recorded`?) and confirmed genuinely distinct — M15's own inbound acknowledgment that it applied M14's decision, the identical shape M7's own `care_plan.idg_decision_applied` audit event already establishes for the M7/M14 pair. " +
      "F-142 (#248) added a ninth 'since last IDG'-shaped gap, found triaging the (now-deleted) m7 group: `m19.triage_call.care_plan_change_indicated` was declared for m7, but M19's own D8-cascade text (§11) names the real consumer as M14's IDG packet builder — corrected at the source (M19's `declaredConsumers` m7→m14).",
    events: [
      "m10.hope.j2051_trigger_fired",
      "m10.hope.sfv_created",
      "m11.order.discontinued",
      "m12.medication_history_pulled",
      "m12.medication_order.discontinued",
      "m15.idg_decision.applied",
      "m15.plan.bootstrapped",
      "m15.plan.version_signed",
      "m19.triage_call.care_plan_change_indicated",
      "m39.consent.expiring_soon",
      "m6.admission.activated",
      "m6.admission.discharged",
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
      "F-153 (#248) built live bindings for 6 of the 8 pairs F-136 had confirmed genuine: `m6.cti.signed`, `m6.f2f.attested`, `m6.loc.changed`, `m6.election.period_ended`, `m8.encounter.cosigned`, `m5.patient.deceased` now each enqueue onto the already-registered `revalidate.consumer` BullMQ worker (`runRevalidateConsumer`, a real running worker since the launch-worker set landed, that nothing had ever added a job to) via `outbox-consumers/m23-revalidate-triggers.ts`, and the worker's own `RevalidationTargetResolverPort` — fail-closed-unbound at boot — is now real (`buildDrizzleRevalidationTargetResolver`, `ClaimRepository.listRevalidationTargets`), matching every VALIDATING/READY claim by the event's `patientId`/`admissionId` (exact) or `encounterId` (jsonb containment on `claim_line.backing_encounter_ids`). `m5.patient.deceased` is bound for its `revalidate` effect only — the same event's `freeze_new_claims` effect stays unbuilt: no column, table, or code path anywhere records \"new claims frozen for this patient\" (confirmed only a `vi.fn()` mock exists for that port), a real, separate schema gap. **2 of 8 stay deferred, genuinely blocked**: `m18.evv.late_check_resolved`'s catalogued payload carries only `visitId` — no `claim`/`claim_line` column holds a visit id, so resolving it to a claim needs a reverse of F-123's `encounterVisitIdsForOrg` M23 has no port for; `m25.taxonomy.unmapped_code_observed` needs a genuinely new M23-side validation-rule-suggestion mechanism (no table, route, or consumer anywhere in this module).",
    events: ["m18.evv.late_check_resolved", "m25.taxonomy.unmapped_code_observed"],
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
      "F-133 (#248) checked this group per-event against M17's own §4.3/§4.4 spec text rather than trusting the six producing modules' `declaredConsumers` guesses — the F-101 rule. 12 of the 14 pairs were genuine, real, still-unbuilt subscriptions; 2 were genuinely misdeclared and dropped at the source (`m20.safety.check_in_recorded` — a seam pull, not a push; `m5.patient.address_changed` — M17 never geocodes, per its own §7.10). **F-152 (#248) built three of the twelve**: `m18.evv.check_in_recorded` (`published → en_route`) and `m18.evv.at_patient_address` (`en_route → in_visit`) — both named explicitly by `transitionVisit`'s own `VisitAdvanceSource: {via:\"evv\"}` doc comment as the D14 EVV-authoritative advances, mirroring `SchedulingRouteService.startVisit`/`arriveVisit`'s write shape; and `m20.safety.visit_cancellation_requested` — M20's own catalog says outright 'M20 never writes an M17 row — this event IS the request and M17's D3 handler decides,' using the established `M17_SYSTEM_USER_ID` sentinel (`consumers/admission-lifecycle.ts`'s convention) since `m17.visit.cancelled`'s catalogued payload requires a non-empty `cancelledBy` string, not a nullable column. Building this surfaced two findings on the remaining group, not yet acted on: `m18.evv.check_out_recorded`'s own catalog DESCRIPTION is likely wrong, not merely unbuilt — it claims to drive `in_visit → completed`, but `visit-machine.ts`'s `complete` case hard-guards `isSystemActor` to `m8.encounter.signed` only, so checkout cannot legally drive completion (`visit.evv_check_out_event_id` is real and unwritten, but recording it with zero state effect needs a product call, not a bind); `m18.evv.event_corrected`'s description (\"M8/M17 re-read the bracket\") reads as the identical seam-pull shape already dropped on the M8 side of this same event (F-140) — worth re-verifying and likely dropping, not binding. **The remaining 9 stay genuinely unbuilt**: `m15.volunteer.assignment_inactivated` needs a whole `m17.reassignment_needed` day-view reassignment-scan subsystem (cron + decider) that does not exist; `m8.encounter.orphan_recorded` is blocked on the PRODUCER (M17's own D2 row calls its consumer a deny-stub until M8's publisher exists, which it still doesn't); `m18.evv.late_check_resolved` names no concrete mechanism in either module; `m19.triage_call.visit_needed` and both `m39.consent.delegated_access.*` events were not re-investigated this pass (the two consent events read as a likely seam-pull misclassification — 'portal-upcoming scope check' sounds like a read-time ABAC gate — worth a future per-event check).",
    events: [
      "m15.volunteer.assignment_inactivated",
      "m18.evv.check_out_recorded",
      "m18.evv.event_corrected",
      "m18.evv.late_check_resolved",
      "m19.triage_call.visit_needed",
      "m20.safety.high_risk_area_entered",
      "m39.consent.delegated_access.granted",
      "m39.consent.delegated_access.revoked",
      "m8.encounter.orphan_recorded",
    ],
  },
  {
    module: "m16",
    kind: "handlers-unbound",
    reason:
      "F-153 (#248) built the fifth of these: `m6.admission.discharged` (filtered to `reason='death'`, §4.5's \"secondary verifier\" against M6 failing to emit `m6.bereavement.eligible`) is now a live consumer (`outbox-consumers/m6-admission-discharged-death.ts`) re-running the identical §4.3.1 `decideEligibilityIntake` core a second time off a different source event — a true no-op when the primary path already opened the plan. **4 remain genuine, real, still-unbuilt subscriptions**, matching M16's own §4.5 table or a documented producing-side decision: `m39.consent.signed` (§4.5's \"post-death-grant handler\", under the spec's stale name `consent.created`) is bigger than F-151's `consent.revoked` cascade — its full effect list needs `appendScore` (§4.3.4 risk-score recompute), a private closure requiring a real acting membership the consumer's system-actor convention doesn't fit, plus M38 relationship/SUD-disclosure seam calls; `m5.patient.bereavement_opt_out_changed` (§4.5 + D9, `decidePatientOptOutFlip`) — the `skip` branch has no route case to mirror at all and the `close_early` branch needs `cancelFutureOutreach`/`closeoutStats`, both private, unexported closures; `m6.discharge.cosigned` — blocked producer-side twice over (M6's `discharge_event` models no external source, so `DeathDischargeReader` never returns anything but `internal_clinician_recorded`, and the payloads don't match the decider's fields either); `m37.ipu_admission.death_recorded` — M16's own `dependsOn` excludes 37, and M37's one published seam touching `ipu_admission` is keyed by `patientId`, not designed to map `ipuAdmissionId → M6 admissionId` — no bridging seam exists on either side.",
    events: [
      "m37.ipu_admission.death_recorded",
      "m39.consent.signed",
      "m5.patient.bereavement_opt_out_changed",
      "m6.discharge.cosigned",
    ],
  },
  {
    module: "m25",
    kind: "handlers-unbound",
    reason:
      "F-135 (#248) checked this group per-event against M25's own §4.4 spec text (the `boot.ts` subscribe list, which names exactly three inbound topics) and its real `consumers/subscription-map.ts` (the same three, frozen), rather than trusting M23/M24's `declaredConsumers` guesses. **2 of 11 pairs are genuine, real, still-unbound subscriptions**, matching both: `m23.claim.rejected` (the 277CA-derived pre-835 denial-worklist seed, D2/D3 — `handleClaimRejected` is written and unit-tested) and `m18.evv.aggregator_rejected` (the EVV-aggregator-rejection seed, M18 §4.10 — `handleEvvAggregatorRejected` is written and unit-tested). **F-153 (#248) attempted to bind both and found the \"same posture as M26/M27\" framing undersold it — two real schema gaps, not merely a missing relay bind**: (1) `denial_case` carries NO unique index on either idempotency key shape the handlers' own header promises (\"the 277CA seed dedupes on (claimId, source, UTC date); the EVV seed on the aggregator submission id... the store enforces the dedupe\") — only non-unique indexes exist, so a redelivery or a dispatcher-tick race would double-seed a row silently; (2) `DenialSeedStore.seedDenial`'s declared input has no `taxonomyStatus` field, while `denial_case.taxonomy_status` is NOT NULL with no default and the only existing writer (`ingest/service-drizzle.ts`) derives it via `effectiveCategory(catalogCategory)` against M38's resolved CARC category — neither `handleClaimRejected` nor `handleEvvAggregatorRejected` performs that resolution. Needs a migration (partial unique indexes on `denial_case`) and a widened `seedDenial` port before either can bind. **9 of 11 were genuinely misdeclared and dropped at the source**, none of them present in M25's own subscribe list under any spelling: `m23.claim.acknowledged`/`.acknowledgment_partial`/`.submitted` and the four `m24.medicaid_claim.*` acknowledgment/submission siblings carry no CARC/denial fact for M25 to act on — only a 277CA REJECTION (or its EVV-aggregator sibling) seeds a worklist row before an 835 lands, and M25 pulls the Medicaid 835 itself over M24's per-state channel (D9) rather than subscribing to any M24 claim-lifecycle event at all; `m23.claim.denied` and `m24.medicaid_claim.denied` are each M25's OWN OUTPUT read backwards — both events' own descriptions say the DENIED transition is \"driven by M25\" (M25 posts the denial 835 that causes it), so M25 is the producer of the fact behind each, not a consumer of it. All 9 dropped at the source in each producing module's `events-by-mNN.ts` (M23 ×4, M24 ×5).",
    events: ["m18.evv.aggregator_rejected", "m23.claim.rejected"],
  },
  {
    module: "m31",
    kind: "no-consumer-surface",
    reason:
      "F-139 (#248) checked every pair against M31's own authoritative §4.10 'M31 consumes' table (13 named source events, each with a real consumer-file name), its own `M31_SUBSCRIBED_EVENT_NAMES` mirror (`packages/types/src/portal.ts`), and — for two events the mirror flagged as aspirational — the PRODUCING module's own decisive text. The blanket 'M31 has no consumer directory and binds nothing' reason described the MECHANISM correctly (no `consumers/` directory exists anywhere in `31-portal/`) but said nothing about which declarations were real. 6 of the original 11 pairs are genuine, real, still-unbuilt subscriptions: `m16.bereavement.contact_active` (M16's OWN outbox table names M31 explicitly among its consumers — the F-131 'kept, not dropped' caution); `m17.visit.cancelled`/`.rescheduled` (telehealth-scoped, `m17-visit-cancelled-telehealth.ts`/`m17-visit-rescheduled-telehealth.ts` — force-end / re-mint the vendor room); `m39.consent.delegated_access.granted`/`.revoked` (the real, decided D10 mechanism for `family_caregiver_access` grant creation/cascade-revoke); `m8.encounter.signed` (telehealth-attached, `m8-encounter-signed-telehealth.ts`). 5 of 11 were genuinely misdeclared and dropped at the source: all three M12 events and `m13.administration.recorded` are each redundant with a documented SEAM PULL M31's own §4.4 dependency text names by method (`MedicationOrderProvider.getPortalMedicationSummary`, `MedicationAdministrationProvider.getPortalAdministrationSummary`); `m17.caregiver_reminder_due` is disclaimed outright by M31's own text ('visit-reminder opt-in is M22's domain … but exposed in M31's preference UI'). Checking the full §4.10 table surfaced the REVERSE defect too (F-102/F-106/F-129 shape): 6 events M31's own table names with a real consumer file had NO m31 declaration anywhere in the catalog — `m17.visit.published` (room-mint enqueue), `m6.admission.discharged` (both `reason` branches — bereaved transition / 30-day grace timer), `m22.document.rendered` (patient-facing kinds), `m16.bereavement.plan_opened`/`.plan_closed_completed` (plan-level bereaved-scope flip / grant revocation, distinct from the per-contact `contact_active` fact above), and `m39.consent.revoked` (the BROAD any-consent-type cascade, genuinely wider than `delegated_access.revoked`'s family-caregiver-only scope) — all six now declared at the source. Two of M31's OWN mirror-listed events were checked and NOT added, on the producing module's more decisive say-so: `m39.consent.created` — M39's own outbox table states its consumers as '(none — drafts are internal)', a first-party disclaimer stronger than M31's aspirational spec text; and `m4.legal_hold.applied`/`.released` — M4's own module spec (§M04-F03) commits this to a registered `HoldApplier` SEAM per data-owning module, never an outbox subscription, and `events-by-m4.ts`'s own header says declaring a consumer here 'would be a namespace lie'. Both stay exactly as `outbox-subscription-exceptions.ts` already filed them.",
    events: [
      "m16.bereavement.contact_active",
      "m16.bereavement.plan_closed_completed",
      "m16.bereavement.plan_opened",
      "m17.visit.cancelled",
      "m17.visit.published",
      "m17.visit.rescheduled",
      "m22.document.rendered",
      "m39.consent.delegated_access.granted",
      "m39.consent.delegated_access.revoked",
      "m39.consent.revoked",
      "m6.admission.discharged",
      "m8.encounter.signed",
    ],
  },
  {
    module: "m11",
    kind: "handlers-unbound",
    reason:
      "F-137 (#248) checked every remaining pair against M11's own spec (its authoritative 'Outbox events consumed' list) and, where M11's own text was silent, against the PRODUCING module's spec for a specific, decided, cross-referenced claim — the F-131 'kept, not dropped' caution. 9 of 10 were genuine, real, still-unbound subscriptions; 1 of 10 (`m6.admission.activated`) was genuinely misdeclared (no support anywhere in M11's own consumed-events list) and dropped at the source. **F-152 (#248) built two of the nine**: `m9.assessment.significant_change` — the §2.7 D7 order-suggestion banner (`decideAssessmentSuggestion`), writing the Valkey `wardenx:m11:orders:suggestion:<patientId>` projection (7-day TTL) `suggestion-banner.ts`'s own header always named as the mechanism and nothing had built; and `m21.supply_request.status_changed` — the D8 one-shot auto-complete, `toStatus='delivered'` on a `supply`/`comfort_kit` order (never `dme`, which closes out via the separate monthly-rental path already bound by F-120). The remaining 7 stay genuinely blocked, checked again: `m21.supply_request.cancelled`/`.cancel_no_op` — M11's own spec names neither, and tracing `consumers/bindings.ts` shows the M11 order is already synchronously discontinued in the SAME transaction that emits `m21.supply_request.supply_cancellation_requested`, so what M21's catalog gloss would mean for a cancellation reaching M21 through some OTHER path is a genuine, undecided product question; the two `m39.consent.dpoa.*` events — `order_records.ts` has zero DPOA/consent/attribution columns and no concrete target is named on either side beyond a one-line gloss; the three `m7.intervention.*` events — `order_record` has no care-plan-intervention column, and the one concrete linkage (`care_plan_intervention.linked_order_id`) is M7-owned with the READ direction running the opposite way (M11 pulls M7 when authoring an order, not a push subscription).",
    events: [
      "m21.supply_request.cancel_no_op",
      "m21.supply_request.cancelled",
      "m39.consent.dpoa.agent_appointed",
      "m39.consent.dpoa.agent_removed",
      "m7.intervention.added",
      "m7.intervention.discontinued",
      "m7.intervention.updated",
    ],
  },
  {
    module: "m19",
    kind: "handlers-unbound",
    reason:
      "F-140 (#248) checked every pair against M19's own spec text (`WARDENX_MODULE_19_ONCALL_TRIAGE_SPEC_v0_3.md`) and its real `consumers/` directory (3 files — the two D10 inbound triggers already bound, plus `m36-delivery-failed.ts`, whose topic has no producer at all). 1 of 8 kept: `m17.visit.assigned` — M19's own spec (line 1207) is decisive and specific: 'At every shift cron tick + on every m17.visit.assigned outbox event affecting an on_call_* visit purpose, M19's shift-sync worker reads VisitAssignmentReader.tonightsOnCallRoster' — with a named job (`m19.shift-sync.debounced`) and consumer file (`m17-roster-changed.consumer.ts`) in the file tree, and an explicit note that 'M17 emits no separate m17.roster.changed', which is also why `.unassigned` below is redundant with it rather than kept alongside it. 7 of 8 dropped: `m17.time_off.approved` and `m17.reassignment_needed` — M19's spec checks PTO/reassignment eligibility via a SEAM PULL at the 'go on shift' gate ('not on PTO via M17 reader'), never a push, and M19's spec never mentions 'reassignment' at all; `m17.visit.unassigned` — the shift-sync worker re-pulls the FULL roster off `.assigned` alone, so a separate unassignment push is redundant with what it already covers; `m20.safety.check_in_escalated`/`.sos_alert_raised` — the reverse-direction trap, caught: M20's own LOCKED D14 decision states the after-hours recipient set is composed by M20 PULLING M19's `OnCallProvider.currentOnCallForProviderEntity` seam, explicitly 'without M19 needing to know about safety alerts' — M19's own spec never mentions SOS/safety anywhere; `m39.consent.delegated_access.granted`/`.revoked` — M19 gates portal-caregiver access via a live `ConsentEvaluator.isActive` SEAM PULL inside the `portal_session_consent_active` ABAC predicate, evaluated per-request, with no consumer file planned for either event.",
    events: ["m17.visit.assigned"],
  },
  {
    module: "m5",
    kind: "handlers-unbound",
    reason:
      "F-138 (#248) checked every pair against M5's own spec text and, where M5 was silent, against the PRODUCING module's spec for a specific, decided, cross-referenced claim. 9 of 10 were genuine, real, still-unbound subscriptions; 1 of 10 (`m24.medicaid_eligibility.checked`) was genuinely misdeclared, running the relationship in the OPPOSITE direction, and dropped at the source. **F-152 (#248) built one of the nine**: `m6.admission.activated` — the §3.3/ARCH-011 denormalization of `provider_entity_id`/`location_id` onto `patient`, resolved through M6's registered `AdmissionStatusReader.getAdmissionSiting` seam (no `dependsOn` edge to M6 required; org-explicit, safe from a relay tick), scoped deliberately to ONLY the `patient` row — cascading onto the dozen-plus child tables that carry their own `provider_entity_id` (`patient_address`, `patient_payer`, …) is a separate, undecided product question this build does not guess at. `m17.visit.assigned`/`.unassigned` and all six `m39.consent.*` events remain genuinely blocked, checked again and confirmed still unbuilt: the visit-assignment mechanism needs a whole per-clinician Valkey-set caseload cache with zero existing Redis/Valkey usage anywhere in `05-patient/` to mirror (`CaseloadStore`'s read side still answers from `patient_assignment` alone, per its own 'Phase-1' comment); the six M39 events need both a real M39 consent-type→`PrivacyFlag` mapping that exists nowhere in the codebase and a full per-delivery re-read of all the patient's current consents (the decider recomputes the whole flag set, not an incremental diff) — `privacy/index.ts`'s own `M39_CONSENT_CONSUMER_DEFERRED = true` constant is an explicit, already-documented Phase-1 gate, not an oversight.",
    events: [
      "m17.visit.assigned",
      "m17.visit.unassigned",
      "m39.consent.expired",
      "m39.consent.recipient_removed",
      "m39.consent.renewed",
      "m39.consent.revoked",
      "m39.consent.signed",
      "m39.consent.supersedes",
    ],
  },
  {
    module: "m13",
    kind: "handlers-unbound",
    reason:
      "F-140 (#248) checked every pair against M13's own authoritative `M13_OUTBOX_SUBSCRIPTIONS` list (`consumers/index.ts`, 11 entries each naming a real consumer function backed by the pure decider `decideReconciliationTrigger`) and, where that list was silent, against the producing module's own catalog text. 7 of 8 original pairs were kept; 1 of 8 (`m37.iv_safety_overlay.required`) was a seam-vs-push trap and moved to `seamConsumers`. The reverse check found 4 real reverse-direction gaps, all on M13's own subscription list with a real decider each and never declared. **F-152 (#248) built all four**: `m6.admission.activated`, `m6.transfer.created`, `m6.discharge.created` and `m6.cti.signed` all open the §2.8 D17 medication-reconciliation worksheet via the real `decideReconciliationTrigger`/`buildReconciliationWorksheet` cores, through one consumer (`outbox-consumers/m6-reconciliation-triggers.ts`) resolving admission siting via M6's org-explicit `admissionSchedulingContextForOrg` seam (M13's `dependsOn` has no edge to 6). Verifying the build found a real gap the fork's own type had missed: `AdmissionAnchor.providerEntityId` was typed non-null while the source `admission.provider_entity_id` column is nullable (ARCH-011) exactly like `locationId` already was — widened to match and given the identical 'refuse rather than fabricate' throw, since `medication_reconciliation_worksheet.provider_entity_id` is NOT NULL and has never been exercised. **The remaining 7 stay genuinely unbuilt, none attempted this pass**: `m6.admission.discharged` (`m13.admission-discharged-cascade`) is the strongest remaining candidate — `planDischargeCascade` (`packages/emar/src/cascade/discharge-cascade.ts`) is pure and complete, needing only M13's own tables, but is a BATCH write (multiple dose cancellations + per-dose emissions) deliberately not rushed in this pass; `m12.medication_order.active`/`.discontinued` need a cross-module read of M12's order via its `MedicationOrderProvider` seam plus a batch `scheduled_dose` insert, its own scoping pass; `m21.comfort_kit.deployed_at_patient`/`.returned` have deciders (`buildComfortKitDeployment`/`applyKitReturn`) whose input/write requirements were not verified this pass; `m21.comfort_kit.replenished`/`.return_reconciliation` have no decider at all yet in M13, per the group's own prior finding.",
    events: [
      "m12.medication_order.active",
      "m12.medication_order.discontinued",
      "m21.comfort_kit.deployed_at_patient",
      "m21.comfort_kit.replenished",
      "m21.comfort_kit.return_reconciliation",
      "m21.comfort_kit.returned",
      "m6.admission.discharged",
    ],
  },
  {
    module: "m24",
    kind: "handlers-unbound",
    reason:
      "F-140 (#248) checked every pair against M24's own authoritative `M24_SUBSCRIPTION_MAP` (`consumers/subscription-map.ts`, 8 named topics each mapped to a real handler in `consumers/handlers.ts`) rather than trusting the producing modules' guesses. 1 of 8 original pairs kept: `m5.patient.address_changed` — M5's own description is decisive ('triggers... Medicaid state recheck (M24)'), a real still-unbound relationship. 7 of 8 dropped, none in `M24_SUBSCRIPTION_MAP` under any spelling: the three `m18.evv.aggregator_*` events are each either 'operational visibility' with no M24-specific mechanism, or (for `.accepted`) explicitly rejected by M24's own D9 decision ('M24 owns its own EVV gate without consuming M18's seam' is a named boundary violation — the real mechanism is `EvvComplianceReader.bracketStateForVisit`, a seam pull at claim assembly); the two self-declared `m24.medicaid_claim.submission_failed`/`.medicaid_eligibility.refresh_requested` have no handler in `handlers.ts` at all (the first's real retry is BullMQ job-level backoff on the original submit job; the second is never emitted anywhere in the codebase); `m5.patient.payer_changed` is redundant with `PatientPayerReader.coverageKindOn()`, a seam consumed at claim assembly — the identical shape F-136 already found for M23 on this same event; `m8.encounter.cosigned` is absent from `M24_SUBSCRIPTION_MAP`'s exhaustive trigger-revalidate list, which names only `.signed`. Checking the full subscription map surfaced 5 real reverse-direction gaps: `m23.claim.acknowledged` (`resolve-medicare-primary` / `handleMedicarePrimaryAck` — the COB precondition for billing Medicaid secondary once Medicare pays primary), `m5.patient.updated` (`trigger-revalidate` / `handleUpstreamChange`), `m8.encounter.signed` (same handler), and `m25.remittance.claim_paid`/`.claim_denied` (`mark-claim-paid`/`mark-claim-denied`, real handlers `handleClaimPaid`/`handleClaimDenied`) — all five named on M24's own map with a real handler and the catalog never declared `m24`. Two stale `outbox-subscription-exceptions.ts` entries covered these: a `handler-unbound` entry for the first three, correct as far as it went, and a `would-defer-a-bound-event` entry for the M25 pair that assumed declaring `m24` would interrupt M23's live delivery to those two events — the same mistaken belief F-139/m31 already corrected (`buildOutboxRoutingPlan` delivers to every bound consumer regardless of what else is declared). Both entries deleted; all five added at the source.",
    events: [
      "m23.claim.acknowledged",
      "m25.remittance.claim_denied",
      "m25.remittance.claim_paid",
      "m5.patient.address_changed",
      "m5.patient.updated",
      "m8.encounter.signed",
    ],
  },
  {
    module: "m21",
    kind: "handlers-unbound",
    reason:
      "F-153 (#248) built live bindings for 2 of the 4 `consumers/m13-comfort-kit.ts` deciders: `m13.comfort_kit.deployed` (§2.5 deployment-ack, resolved by patient+admission — the whole point of the ack is that the M13 deploymentId link does not exist yet) and `.return_required` (§2.6 chain-of-custody return open) are now live in `outbox-consumers/m13-comfort-kit-cascade.ts`. **`m11.order.signed` is removed outright, not bound**: it was misdeclared, not merely unbound — redundant with the co-emitted, more specific `m11.order.supply_fulfillment_requested` sibling (same transaction, `emitDownstreamSignedEvent`), the F-117/F-101 co-emission shape; dropped from `events-by-m11.ts`'s `declaredConsumers` at the source. **4 pairs remain genuinely blocked or not yet attempted**: `m11.order.supply_fulfillment_requested` — still blocked, not misdeclared — its own IO resolver (`consumers/order-context.ts`) states no platform seam answers 'which Location serves this patient'; `m13.comfort_kit.replenishment_needed` (§2.1 intake) needs the SAME shared `insertRequest` write path `write-service-drizzle.ts`'s `createDirect` seam calls — extracting it to module scope (the `patchSupplyRequest`/F-102 precedent) is shared-file work, not an isolated bind; `m13.comfort_kit.controlled_substance_discrepancy` (§4.5.1) is payload-BLOCKED — the catalogued `m21.controlled_substance.discrepancy_detected` schema requires a non-nullable `returnId` + full custody chain, the shape a RECONCILIATION-time discrepancy carries, while M13's bedside re-emit fires at drug ADMINISTRATION time before any `comfort_kit_return` row exists; `m12.medication_order.dispensed_at_pharmacy` has no decider built anywhere in M21 (only referenced by spec line 66) — needs new DoseSpot-dispensed business logic.",
    events: [
      "m11.order.supply_fulfillment_requested",
      "m12.medication_order.dispensed_at_pharmacy",
      "m13.comfort_kit.controlled_substance_discrepancy",
      "m13.comfort_kit.replenishment_needed",
    ],
  },
  {
    module: "m29",
    kind: "no-consumer-surface",
    reason:
      "F-141 (#248) checked every pair against M29's own locked spec (D1 four-pillar scope: HL7 inbound/outbound, NPPES, Xero/Gusto) and its M5 dependency prose. 6 of 7 dropped: `m11.order.signed` is redundant with the specific `hl7_orm_requested` event (M29's spec never mentions `.signed`, only the specific event with the PID/ORC/OBR/NTE payload); `m20.safety.osha_reportable_incident_filed`/`workers_comp_claim_initiated` and `m35.invoice.paid`/`refund.executed` have no support anywhere in D1's scope (the M35 relationship actually runs the opposite direction, a seam pull via `ExternalInterfaceMetricsProvider`); `m5.patient.archived` claimed 'M29 expires related HL7 inbound proposals' with zero corroboration in M29's spec, which names exactly one proposal-expiry path (the 72h SLA timer). `m11.order.hl7_orm_requested` is kept — decisive on both sides (M29's own spec: 'M29 consumes the m11.order.hl7_orm_requested outbox event as a typed listener... M29 wires the live consumer at lock'). The reverse check found a real, decisive, undeclared subscription: `m5.patient.deceased`, named explicitly in M29's M5-dependency prose ('consumed via outbox to freeze inbound ADT processing for the decedent') — added. `m5.patient.merged` was checked and correctly NOT added — M29's own text describes it as a seam pull ('resolved at every lookup'), never a push.",
    events: ["m11.order.hl7_orm_requested", "m5.patient.deceased"],
  },
  {
    module: "m1",
    kind: "no-consumer-surface",
    reason:
      "F-141 (#248) checked all six pairs individually rather than trusting the blanket 'no consumer directory' framing. All six confirmed genuine, 0 dropped, 0 added: M23/M24/M33 each independently and consistently describe the same real, built mechanism — the `system_status` table + `SystemStatusReader.upsert` (already live behind the admin route) — that only lacks its automatic-consumer wiring; all three producing modules use the identical decisive phrasing ('M1 records/clears the degraded system_status'). `m12.dosespot_degraded`/`.recovered` was checked as the obvious sibling candidate and correctly excluded — M12's own spec routes DoseSpot degradation through a per-tenant feature flag, not the platform-global `system_status` table, a principled scoping difference (`system_status` is NON_ORG_SCOPED; DoseSpot connectivity is per-tenant).",
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
      "F-143 (#248) checked all six pairs against M6's own spec text and, where M6 was silent, against the producing module's own decisive, cross-referenced claim — the F-131 'kept, not dropped' caution. 4 of 6 are genuine, real, still-unbound subscriptions: `m11.order.level_of_care_change_signed`/`.recertification_signed` are each decisive on M11's side — M11's own locked D9/D10 (with a rejected-alternatives table) state outright 'M11 emits `m11.order.level_of_care_change_signed`; M6 subscribes and runs its LCP transition' / 'M11 emits `m11.order.recertification_signed`; M6 subscribes and validates F2F + CTI then transitions the next period' — M6's own spec predates this cross-module decision and is comparatively silent, the same asymmetry F-131 named for `m25.remittance.claim_recouped`. `m23.noe.accepted`/`m23.notr.accepted` are both decisive on M23's side too: M23's own 'Done means' walkthroughs (§7.4/§7.6) state plainly 'the NOE transitions to ACK_ACCEPTED; emits `m23.noe.accepted`; M6's consumer picks up the event and closes the M6 NOE compliance window' and the identical shape for NOTR — a genuinely NEW fact (when the MAC accepted) M6 cannot derive from its own F-106/F-107 emissions, which trigger the NOE/NOTR filing, not its acceptance. **2 of 6 were genuinely misdeclared and dropped at the source**: `m19.triage_call.gip_admission_proposed` — M19's own locked spec names M37, never M6, as the real consumer (line 18's 'Consumed by' table and line 1947's Lock-status section both state 'M37 IPU / GIP module consumes `m19.triage_call.gip_admission_proposed` at M37 lock'); M6's own advisory role on this disposition is a SEAM (M11's `level_of_care_change` order draft), never an outbox subscription — `m6` was the spurious extra on an event `m37` already correctly declares. `m37.ipu_admission.bed_assigned` is the seam-vs-push trap: M6's real `confirmLocBedAssignment` route (admission-route-service-db.ts) verifies the bed via a SEAM READ (`ipuBedAssignmentReader.activeBedAssignmentForLevelOfCarePeriod`), never an outbox consumer, and M6's own spec (line 621) names exactly one inbound external event it consumes (`m29.hl7_inbound_proposal.accepted`) — not this one.",
    events: [
      "m11.order.level_of_care_change_signed",
      "m11.order.recertification_signed",
      "m23.noe.accepted",
      "m23.notr.accepted",
    ],
  },
  // F-142 (#248) — the `m7` group is GONE, not merely emptied. All 5 pairs were checked against M7's own
  // authoritative surface: `m39.consent.dpoa.agent_appointed`/`.agent_removed` and both `m9.assessment.*`
  // events are redundant with documented build-time SEAM PULLS (M7's own D7 — a single ABAC seam to M39
  // for DPOA attribution; M7's own spec — the registered `LatestAssessmentProvider` seam for M9 scores),
  // dropped at the source with no m7 replacement. `m19.triage_call.care_plan_change_indicated` was a
  // genuine misdeclaration, not merely unsupported: M19's own D8-cascade text (§11) names the real
  // consumer as M14's IDG packet builder, not M7 — corrected at the source (declaredConsumers m7→m14) and
  // the pair now lives in the m14 group below.
  {
    module: "m35",
    kind: "no-consumer-surface",
    reason:
      "F-142 (#248) found the group's original 5 events and its blanket reason were BOTH wrong — a seam-vs-push trap. M35's own D21 (locked, exhaustive: '8 inbound subscriptions') never names any M32 or M34 event, and D24 states both relationships are SEAMS, not pushes: M32 calls `UsageMeteringIngest.ingest` directly INTO M35's own published seam (task T-21), and M35 consumes M34's `OnboardingStatusProvider` as a forward-seam deny-stub, never an outbox push either way. All 5 original events (`m32.capability.invoked`, `m32.tenant_opt_in.{recorded,revoked}`, `m34.tenant.{provisioned,offboarding_initiated}`) dropped at the source — the F-101 shape at group-reason granularity, since the group's OWN framing had smuggled in the wrong five. The reverse check found the real gap: D21's exhaustive 8-event list — `m2.organization.{activated,suspended,closed}`, `m2.session.created`, `m5.patient.{created,status_changed,deceased,merged}` — was already correctly tracked in `scripts/outbox-subscription-exceptions.ts`'s rule-6 'no-handler' buckets (catalog agreement was the only thing missing), except `m5.patient.{created,status_changed}`, which M35's own D21 marks `record-only-target` (M5 has refused the billing-input coupling; stays untouched). The other 6 are now correctly declared at the source (M2's four events, M5's `deceased`/`merged`) and the matching stale `outbox-subscription-exceptions.ts` 'no-handler' entries deleted, per the gate's own message ('now both subscribed and declared — the exception has outlived its reason'). `M35_SUBSCRIBED_EVENT_NAMES` (`packages/types/src/subscription-billing.ts`) corrected to match — the 5 wrong names removed, the list now exactly D21's 8. M35 still has no `consumers/` directory, so all 6 remain genuinely deferred here.",
    events: [
      "m2.organization.activated",
      "m2.organization.closed",
      "m2.organization.suspended",
      "m2.session.created",
      "m5.patient.deceased",
      "m5.patient.merged",
    ],
  },
  {
    module: "m2",
    kind: "no-consumer-surface",
    reason:
      "F-142 (#248) checked both pairs against M2's own authoritative surface. `m18.evv.device_approved`/`.device_suspended` were dropped: M18's own spec (§2.2.3) states the two rows are independent — `evv_device.m2_device_attestation_id` is a logical FK M18 reads FROM M2 (a seam/FK pull), never a push M2 needs; M2's own spec never mentions `evv_device` or this approval lifecycle at all. `m39.consent.revoked` is kept — decisive and repeatedly cross-referenced in M39's own locked spec (D7: 'typed per-consent-type handlers emit outbox events that consumers subscribe to... M2 portal-session terminate...'; the per-type cascade table names M2 explicitly for both `portal_access` and `family_caregiver_access`; a 'Done means' walkthrough names the exact mechanism — 'M2 consumer subscribes; iterates active sessions... terminates each session immediately'). M2's own spec is silent on this (M39 authored the cascade; M2's spec predates it), the F-131 'kept, not dropped' asymmetry.",
    events: ["m39.consent.revoked"],
  },
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
  {
    module: "m37",
    kind: "no-consumer-surface",
    reason:
      "F-143 (#248) checked all three pairs against M37's own §4.5 'Outbox Subscriptions (Consumers)' table (apps/backend/src/modules/37-ipu/, which has no `consumers/` directory yet — matching the blanket placeholder this reason used to carry, now checked per event rather than assumed for all three). 2 of 3 are genuine, real, still-unbuilt subscriptions the table names explicitly: `m19.triage_call.gip_admission_proposed` (with a named, unbuilt consumer file, and independently corroborated three separate ways in M19's own spec); `m6.admission.discharged` (named with a designated consumer file, 'If patient has open ipu_admission → cascade-discharge'). **1 of 3 was genuinely misdeclared and dropped at the source**: `m6.admission.activated` is NOT in M37's §4.5 table at all — the table instead names two more granular M6 events M37 actually wants (`m6.level_of_care.requires_ipu_bed`/`m6.level_of_care.activated`), neither of which exists in M6's real catalog, and `m6.admission.activated` itself has no support in M37's own consumption table and was part of that event's broad fan-out with no IPU-specific rationale, the same shape F-134/F-136/F-137 already found repeatedly on this identical event. F-147 (#248) ran the naming-mismatch down rather than leaving it flagged: `m6.loc.changed` is NOT the real trigger either, checked against M6's own production code (`state-machines/level-of-care.ts`) rather than guessed — the `pending → assigning` transition a GIP/IRC LOC change enters emits NO outbox event at all ('No outbox event while assigning — nothing downstream should treat an unconfirmed IPU request as a real period of care yet', `admission-route-service-db.ts`); `m6.loc.changed` fires only later, at CONFIRMATION (`assigning → active`), which M37 already learns about through its OWN `assign-bed` route rather than by consuming an event, matching F-143's `m6` group finding that the M6↔M37 bed handshake is a seam PULL, not a push. M6's one published LOC seam (`LevelOfCareReader`) deliberately EXCLUDES `assigning`-status periods from both of its methods ('not yet a real period of care'), so no seam exists either. The spec's D2 handshake `m6.level_of_care.requires_ipu_bed → m37.ipu_admission.opened → …` was simply never built on the M6 side — there is no event and no seam a catalog declaration could bind M37 to, so nothing here is a misdeclaration; it is real, unbuilt M6-side infrastructure (a new outbox event or seam exposing `assigning`-state periods) that M37's own spec's 'surface on the IPU intake worklist' promise depends on and the codebase does not deliver — reported, not fixed, since inventing a new production event/seam is outside a catalog-declaration pass.",
    events: [
      "m19.triage_call.gip_admission_proposed",
      "m6.admission.discharged",
    ],
  },
  // F-143 (#248) — the `m9` group is GONE, not merely emptied. All 3 pairs were checked against M9's
  // own spec: `m13.prn_administration_recorded` has no support anywhere in M9's "Depends on"/"Consumed
  // by" relationship inventory or its §2.4 outbox table; `m8.encounter.signed` is M8 calling INTO M9's
  // `recordAssessment` API synchronously (M9's own line 61), never a push M9 would subscribe to;
  // `m8.vitals.captured` is the seam-vs-push trap — M9's own spec (line 75) states trending "may read
  // the encounter vital series via M8's seam ... but M9 does not own vital signs," a documented pull
  // M9 would perform, never an outbox push. All 3 dropped at the source (`m8.vitals.captured` moved to
  // `seamConsumers` instead, recording the aspirational-but-unbuilt seam relationship).
  {
    module: "m12",
    kind: "handlers-unbound",
    reason:
      "F-143 (#248) checked the group's two catalogued events plus M12's OWN authoritative `M12_OUTBOX_SUBSCRIPTIONS` list (consumers/index.ts, D4/D10-locked, 10 entries each with a real pure decider already shipped) rather than trusting the stale placeholder reason ('binds two live consumers... three further handler files' — actually three live consumers, and the 'third handler file' investigation found SEVEN undeclared real subscriptions, not one). Both catalogued events KEEP: M13's own spec (lines 266-267, plus its Wave/Done-means tables and test checklist) is decisive that `m13.reconciliation.draft_order_requested`/`.discontinue_requested` target M12 as consumer — a SEPARATE reconciliation surface from M12's own D10 MedHx-reconciliation mechanism (confirmed: M12's D10 flow has no M13 involvement anywhere), genuinely unbuilt on the M12 side (no `triggering_reconciliation_decision_id` column, no consumer file, and `M12_OUTBOX_SUBSCRIPTIONS` names no `m13.*` event). **The reverse check found 7 real, decisive, currently-undeclared subscriptions** — every one of them already on M12's own live subscription list with a shipped, unit-tested decider, and the catalog had simply never declared `m12` on any of them, surviving repeated prior sweeps of the SAME producing events (`m6.admission.activated` in particular had been re-scrutinized by name in F-101/F-134/F-136/F-137/F-140, none of which checked it for M12): `m5.patient.created`/`.updated`/`.address_changed`/`.payer_changed` (D4's DoseSpot patient sync, `sync-triggers.ts`'s `decidePatientSyncTrigger`), `m6.admission.activated`/`m6.cti.signed` (D10's MedHx pull 'on admission.activated and at each F2F window,' `decideMedHxFetch`), and `m11.order.verbal_expired_unsigned` (the group's own already-registered `M12_OUTBOX_SUBSCRIPTIONS` entry for `m12.verbal-expired`, `decideVerbalExpiry`). All 7 added at the source in each producing module's `events-by-mNN.ts`, not here.",
    events: [
      "m11.order.verbal_expired_unsigned",
      "m13.reconciliation.discontinue_requested",
      "m13.reconciliation.draft_order_requested",
      "m5.patient.address_changed",
      "m5.patient.created",
      "m5.patient.payer_changed",
      "m5.patient.updated",
      "m6.admission.activated",
      "m6.cti.signed",
    ],
  },
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
