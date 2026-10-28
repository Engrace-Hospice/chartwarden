import type { ModuleEventContribution } from "@chartwarden/types";
// apps/backend/src/modules/06-admission/events-by-m6.ts — Module 6's outbox-event contributions
// (M6-T10, spec §4.4). The full `m6.*` taxonomy keyed on M6's own tables, under the `m6.` namespace
// (M01 D8 / M03 D9). check-fitness-gaps.ts scans this file for naming (`mN.<resource>.<verb>`),
// ownership (moduleOwner='m6'), and valid declared consumers (real module ids). The named cross-module
// consumers (M5/M7/M8/M11/M13/M14/M16/M22/M23/M26/M27/M28/M30/M33/M36/M37) subscribe when they land;
// M6 publishes the events now. Per §4.7 ("No webhook/Socket.IO") every M6 event is outbox-only.
//
// SPEC DIVERGENCE (F-101): M6 §4.4's own event table names M22 as a consumer of seven events M22's
// §4.11 consumer table does not name — `referral.accepted`, `admission.draft_created`,
// `admission.activated`, `admission.discharged`, `election.drafted`, `election.period_started`,
// `loc.changed`. `declaredConsumers` is a ROUTING input, not a record of interest, so the two specs
// disagreeing was not documentary: `buildOutboxRoutingPlan` defers an event while ANY declared
// consumer is unbound, and M22 was never going to bind these. This file follows M22's table, which is
// the one the consuming module owns. The per-event comments say which sibling event renders the
// artifact each of the seven was presumably reaching for.
//
// Provenance marker (§4.4): `m6.discharge.created`, `m6.discharge.death` and
// `m6.compliance.window.opened` are reused by the `AdmissionEventApplier` (M6-T11), which publishes
// them with `source='m29_proposal_accept'` — modelled as an OPTIONAL payload field so route-emitted and
// applier-emitted events share one schema and existing consumers keep working unmodified.
import { Type } from "@sinclair/typebox";

/** The four CMS levels of care (mirrors `level_of_care`; §3.2). */
const levelOfCare = Type.Union([
  Type.Literal("routine_home_care"),
  Type.Literal("continuous_home_care"),
  Type.Literal("inpatient_respite_care"),
  Type.Literal("general_inpatient_care"),
]);

/** Compliance-window severity (`info` = D15 external signals). */
const windowSeverity = Type.Union([
  Type.Literal("warning"),
  Type.Literal("alert"),
  Type.Literal("info"),
]);

/** Optional provenance marker the AdmissionEventApplier stamps on applier-reused events (§4.4). */
const applierSource = Type.Optional(Type.Literal("m29_proposal_accept"));

export const M6_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── referral ──────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.referral.received",
    moduleOwner: "m6",
    description:
      "A referral was received (route 1) — M36 resolves recipients + dispatches (ADR-0024).",
    payloadSchema: Type.Object({
      referralId: Type.String({ minLength: 1 }),
      source: Type.String({ minLength: 1 }),
      receivedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.referral.review_started",
    moduleOwner: "m6",
    description: "Referral review was started; lifecycle moved to under_review.",
    payloadSchema: Type.Object({
      referralId: Type.String({ minLength: 1 }),
      outcome: Type.Optional(Type.Literal("eligible")),
    }),
    // Record-only, like every other referral transition: no M36 (or, for `converted`, M22) outbox
    // consumer exists for these five — declaring one deferred every emission forever. M36 reads
    // referral state through its notification seam; M22 renders from `m6.election.signed`.
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.referral.pending_information",
    moduleOwner: "m6",
    description: "Referral was placed in pending_information while intake waits for more data.",
    payloadSchema: Type.Object({ referralId: Type.String({ minLength: 1 }) }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.referral.qualified",
    moduleOwner: "m6",
    description: "Referral was qualified after patient resolution and intake readiness checks.",
    payloadSchema: Type.Object({
      referralId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.referral.duplicate",
    moduleOwner: "m6",
    description: "Referral was marked as duplicate.",
    payloadSchema: Type.Object({
      referralId: Type.String({ minLength: 1 }),
      // Present when the referral had resolved/created a patient: M5 ends the creator's access grant on it.
      patientId: Type.Optional(Type.String({ minLength: 1 })),
      // Present when M6's create-patient step ran: the grant holder, so M5 ends only their grant.
      patientCreatedByUserId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    declaredConsumers: ["m5"],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.referral.converted",
    moduleOwner: "m6",
    description: "A qualified referral produced exactly one pending admission.",
    payloadSchema: Type.Object({
      referralId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    // TASK-031 — was missing entirely (not even a boot-wiring gap like the others): `triageReferral`
    // (route 5) has always emitted this event name, and it has never been declared, so every triage
    // call 500'd with `unknown_event` in any DATABASE_URL boot.
    eventName: "m6.referral.triaged",
    moduleOwner: "m6",
    description: "A triage outcome (eligible/ineligible) was recorded (route 5).",
    payloadSchema: Type.Object({
      referralId: Type.String({ minLength: 1 }),
      outcome: Type.Union([Type.Literal("eligible"), Type.Literal("ineligible")]),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.referral.accepted",
    moduleOwner: "m6",
    description:
      "A referral was accepted (route 6); seeds the draft admission + election form prep.",
    payloadSchema: Type.Object({
      referralId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
    }),
    // F-101 — `["m22"]` until now. M6 §4.4's table says "M36 …, M22" and the description says the
    // acceptance "seeds the … election form prep", but M22 renders the election statement on
    // `m6.election.signed`, and a form prepared for a draft that may never be signed is not a
    // document. Record-only: the row IS the durable record of the acceptance.
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.referral.declined",
    moduleOwner: "m6",
    description:
      "The hospice declined the referral (route 7; clinical/geographic/capacity reasons — D16).",
    payloadSchema: Type.Object({
      referralId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
      // Present when the referral had resolved/created a patient: M5 ends the creator's access grant on it.
      patientId: Type.Optional(Type.String({ minLength: 1 })),
      // Present when M6's create-patient step ran: the grant holder, so M5 ends only their grant.
      patientCreatedByUserId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    declaredConsumers: ["m5"],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.referral.withdrawn",
    moduleOwner: "m6",
    description:
      "The referring party/upstream system canceled the referral before a decision (D16; applier).",
    payloadSchema: Type.Object({
      referralId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      withdrawnVia: Type.String({ minLength: 1 }),
      originalReferralReceivedAt: Type.String({ minLength: 1 }),
      withdrawnAt: Type.String({ minLength: 1 }),
      // Present when the referral had resolved/created a patient: M5 ends the creator's access grant on it.
      patientId: Type.Optional(Type.String({ minLength: 1 })),
      // Present when M6's create-patient step ran: the grant holder, so M5 ends only their grant.
      patientCreatedByUserId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    declaredConsumers: ["m5"],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── admission ─────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.admission.draft_created",
    moduleOwner: "m6",
    description:
      "A draft admission + draft period 1 was created — either `admission.draft_from_referral` (has a " +
      "referral) or direct intake / walk-in (TASK-034, no referral).",
    payloadSchema: Type.Object({
      admissionId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      referralId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    // F-101 — `["m22"]` until now, which M6 §4.4 glosses as "(election form prep)". M22 publishes no
    // blank-form template and its §4.11 consumer table does not name this event; the election
    // statement is rendered from `m6.election.signed`, on the signed artifact.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.admission.activated",
    moduleOwner: "m6",
    description: "Admission activated (route 14) — the broad fan-out the whole system keys off.",
    payloadSchema: Type.Object({
      admissionId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      activatedAt: Type.String({ minLength: 1 }),
      // TASK-031: optional, not dropped — the route's emit (admission-route-service-db.ts) doesn't
      // look up the current election period today (a second query the activation transaction doesn't
      // otherwise need); a consumer that needs it can resolve it from `admissionId` via the M6 seam
      // rather than block every activation on a field none of the 15 declared consumers' existing
      // wiring reads yet.
      currentElectionPeriodId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    declaredConsumers: [
      "m5",
      "m7",
      // F-140 (#248) — `m8` REMOVED: M8's own spec (line 387) states outright that outbox publication is
      // the only cross-module communication M8 performs "at the boundary" — every upstream fact,
      // including anything from M6, is an in-process SEAM call, never an outbox subscription. M8's only
      // M6 seam is `FaceToFaceWriter`, unrelated to activation.
      // #48 — M10 materializes the three admission-anchored HOPE timepoint windows here. It was absent
      // from this list for the same reason nothing ever inserted a `hope_timepoint_schedule` row: the
      // handshake the planners were written for had no consumer end.
      "m10",
      // F-140 (#248) — `m13` ADDED: on M13's own live `M13_OUTBOX_SUBSCRIPTIONS` list, with a real
      // decider (`m13.reconciliation-admission`) that opens the admission's medication-reconciliation
      // worksheet.
      "m13",
      // F-137 (#248) — `m11` REMOVED: no support anywhere — M11's own spec's authoritative "Outbox
      // events consumed" list (line 2859) names `m6.admission.discharged`/`.loc.changed`, M9's
      // significant-change, M10's J2051 trigger, the M14/M22 back-refs and the M21 forward seam, and
      // never this event; M11's codebase carries no consumer file, decider, or even a comment
      // mentioning "activated" or "activation" anywhere. It was part of this event's broad fan-out
      // with no order-specific rationale, the same shape F-134/F-136 already found for m16/m23 on this
      // identical event.
      // F-176 (#248) — m14 REMOVED: F-171's T-24h packet-build worker answers §2.3 D9 inclusion by PULL (`idgPacketInclusionForOrg` reads `admission` at build time; no inclusion cache exists to write into), so there is nothing for this push to update.
      // F-103 — M15 bootstraps the three CoP discipline plans here (§1.1 D10), and this list did not name
      // it, so the consumer could not be bound and NOTHING in the repository has ever inserted a
      // `discipline_care_plan` row. Every M15 write route is `/discipline-plans/:planId/…`, so that
      // consumer is the only creation path there is.
      "m15",
      // F-134 (#248) — `m16` removed: an admission ACTIVATION carries no fact M16's bereavement
      // program needs (the program starts at DEATH, not admission), M16's own §4.5 outbox-
      // subscriptions table never names this event, and no consumer of it exists anywhere in
      // `16-bereavement/` — the F-101 "broad fan-out the whole system keys off" phrasing described
      // the list, not an individual decision to include M16.
      // F-101 — `m22` was here. The activation is the platform's broadest clinical fan-out and it
      // renders nothing: M22's §4.11 consumer table names six M6 events (election.signed, cti.signed,
      // f2f.attested, nor.acknowledged, revocation.created, discharge.created) plus the two still
      // deferred below, and this is not among them. Unlike the three that went record-only, this entry
      // still defers — on the other eleven unbound consumers, which is the true reason.
      // F-136 (#248) — `m23` REMOVED: an ACTIVATION anchors no claim by itself — M23's own §4.4/
      // dependsOn text subscribes to the full M6 outbox catalog by NAME (election.signed/
      // period_started/period_ended, cti.signed, f2f.attested, loc.changed, revocation.created,
      // transfer.created, discharge.created, discharge.death) and admission.activated is not among
      // them; it was part of this event's broad fan-out with no billing-specific rationale, the same
      // shape F-134 already found for m16 on this identical event.
      // F-143 (#248) — `m37` REMOVED: M37's own §4.5 "Outbox Subscriptions" table names two more
      // granular M6 events it actually wants (`m6.level_of_care.requires_ipu_bed`/`.activated`, neither
      // of which M6's real catalog publishes) and never names `admission.activated` — the same broad
      // fan-out with no module-specific rationale F-134/F-136/F-137 already found repeatedly on this
      // event.
      // F-143 (#248) — `m12` ADDED: M12's own live `M12_OUTBOX_SUBSCRIPTIONS` list
      // (consumers/index.ts) names this event for `m12.admission-activated-medhx`, backed by a real
      // pure decider (`decideMedHxFetch`, sync-triggers.ts) per M12's D10 — genuinely undeclared until
      // now, surviving five prior sweeps of this same event (F-101/F-134/F-136/F-137/F-140).
      "m12",
    ],
    // F-130 (#248) — m27 REMOVED: M27's own §1.1 relationship inventory + manifest-patch dependsOn list
    // ([1,2,3,4,6,8,12,13,22,23,26,36,38,40]) names M6's `AdmissionCensusReader`/`LevelOfCarePeriodReader`
    // as a build-time SEAM PULL ("the service-side patient-day census, independent of M23's billed days")
    // for the S-3 statistics-refresh job — never an outbox subscription, and M27's spec never mentions
    // reacting to admission-lifecycle events.
    // F-115 (#248) — m28 REMOVED: the FHIR gateway resolves every seam it reads (M5/M6/M7/M8/M11/M12/M13)
    // fresh at REQUEST time (§164.528 D3, F-035) and holds no cached/derived state an admission event
    // would ever need to invalidate — it never subscribes to anything. m30 REMOVED from declaredConsumers
    // and added to seamConsumers: it has no reactive handler for this event (packages/quality/src/
    // consumers/ covers exactly six upstream topics, per M30_OUTBOX_SUBSCRIPTIONS, and this is not one of
    // them); it reads this fact via `AdmissionOnsetReader.listAdmissionsStartedInPeriod` on its own nightly
    // recompute cadence (the `opioid_on_admission_rate` denominator) instead — the m33/m36 shape, not an
    // outbox subscription that will ever bind.
    // F-131 (#248) — m26 REMOVED: M26's own §4.4 consumer surface (`consumers/subscription-map.ts`) names
    // exactly two M6 topics — `m6.revocation.created` (freeze) and `m6.transfer.created` (proportional
    // weight init) — and M26's "Depends on" text reads M6 through `ElectionPeriodReader`, a build-time
    // benefit-period-anchored PULL, not a push subscription to admission activation.
    seamConsumers: ["m30", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.admission.on_hold",
    moduleOwner: "m6",
    description: "Admission placed on hold (route 12).",
    payloadSchema: Type.Object({
      admissionId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
      heldAt: Type.String({ minLength: 1 }),
    }),
    // F-145 (#248) — m14 REMOVED: not in M14's own exhaustive build-description (the "Done means"
    // walkthrough names the eleven seam reads + the four Valkey-projected outbox topics M14 actually
    // consumes, and M6's own "Consumed by 14" text names only `m6.referral.withdrawn` for M14) —
    // no packet field or readiness check references hold status anywhere.
    // F-195 (#248) — m30 REMOVED: M6's own spec (line 2983) names `holdReason`/`holdAt`/`releasedAt` as
    // "surfaced in M30's operational dashboard" — the F-179 REST-resolution shape, not a push. Those
    // columns were write-only until this round; `GET /api/v1/admissions` (org-wide, `?state=on_hold`
    // filterable) now projects all three, the real dashboard read the spec describes.
    declaredConsumers: ["m17"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.admission.resumed",
    moduleOwner: "m6",
    description: "Admission resumed from hold (route 13).",
    payloadSchema: Type.Object({
      admissionId: Type.String({ minLength: 1 }),
      resumedAt: Type.String({ minLength: 1 }),
    }),
    // F-145 (#248) — m14 REMOVED: same as `.on_hold` above.
    // F-195 (#248) — m30 REMOVED: same REST-resolution correction as `.on_hold` above — see that entry's
    // comment for the full citation.
    declaredConsumers: ["m17"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.admission.discharged",
    moduleOwner: "m6",
    description: "Admission discharged (routes 36/37/38/39) — the broad close-out fan-out.",
    payloadSchema: Type.Object({
      admissionId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
      dischargeDate: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [
      // #48 — M10 materializes the single 7-day Discharge RFA window here (D9 keeps it out of the
      // admission plan because its `discharge_reason` branch is unknown until discharge happens).
      "m10",
      // F-102 — M11 and M12 each ship a complete, unit-tested discharge-cascade decider
      // (`consumers/admission-discharged-discontinue.ts` / `consumers/admission-discharged-cascade.ts`)
      // that nothing could bind, because this list did not name them and
      // `assertBindableAgainstCatalog` refuses a binding whose module the catalog does not declare. Two
      // one-sided absences that hid each other: every order and every medication order in flight when a
      // patient was discharged stayed in flight forever.
      "m11",
      "m12",
      // F-140 (#248) — `m13` ADDED: M13's own live `M13_OUTBOX_SUBSCRIPTIONS` list names this event with
      // a real decider (`m13.admission-discharged-cascade`) that enqueues the D14 cancel-future-schedule
      // cascade.
      "m13",
      // F-176 (#248) — m14 REMOVED: F-171's T-24h packet-build worker answers §2.3 D9 inclusion by PULL (`idgPacketInclusionForOrg` reads `admission` at build time; no inclusion cache exists to write into), so there is nothing for this push to update.
      "m7",
      // M5 §2.4.1 `active/on_hold → discharged` ("revoke / discharge for cause / transfer (M6)"): the
      // live-discharge edge (`05-patient/outbox-consumers/m6-admission-discharged.ts`). A `reason: death`
      // delivery is skipped there — `m6.discharge.death` owns `→ deceased`.
      "m5",
      "m16",
      "m17",
      // F-101 — `m22` was here. The discharge SUMMARY is rendered from `m6.discharge.created`, which
      // carries the `discharge_event` id M22 back-refs; this event carries the ADMISSION id and no
      // renderable artifact. Still defers, on the other seven.
      // F-136 (#248) — `m23` REMOVED: the same redundancy one module over — M23's real NOTR-draft
      // trigger is `m6.discharge.created` (already bound in `consumers/subscription-map.ts`), which
      // carries the `discharge_event` id the NOTR draft back-refs; this broader admission-lifecycle
      // event carries no fact M23 needs beyond what discharge.created already delivers.
      "m37",
      // WP 3.8 - m36 has TWO consumers here: `m36.channel-membership-sync` (archive) and `m36.patient-lifecycle-review`
      // (queues the patient's open care-team tasks for a supervisor). declaredConsumers is unchanged.
      "m36",
      // GAP-071 — m24 ADDED: voids the patient's not-yet-billed `rb_day` rows from the discharge date
      // (M24 §2.2: "voided ... when the underlying patient day is voided in M5 deceased / discharge correction").
      "m24",
      // F-222 (#248) — `m31` REMOVED (was F-139's ADD): the `reason!='death'` branch is now a DAILY SWEEP over
      // M6's CURRENT discharge state through the org-explicit published read `portalDischargedPastGraceForOrg`
      // (`31-portal/jobs/post-discharge-grace-sweep.ts`) — a SEAM PULL, see `seamConsumers` below; a re-admitted
      // patient simply stops being a candidate, so no per-event grace job exists to cancel. The `reason='death'`
      // branch is redundant with the bound `m6.bereavement.eligible` -> M16 `plan_opened`/`contact_active` chain.
    ],
    // F-130 (#248) — m27 REMOVED: same reasoning as `m6.admission.activated` above — M27's S-3 census is
    // a seam pull, refreshed on demand, never a push subscription to admission lifecycle events.
    // F-115 (#248) — m28/m30 removed for the same reason as `m6.admission.activated` just above: m28
    // never subscribes to anything (request-time-only reads), and m30 reads this fact via
    // `DischargeReader.liveDischargeTimingCounts` (HCI indicators 3/4) on its nightly cadence rather than
    // reacting to this event.
    // F-131 (#248) — m26 REMOVED: same reasoning as `m6.admission.activated` above — M26's only M6
    // subscriptions are `revocation.created`/`transfer.created`; an ordinary discharge is a benefit-period
    // boundary M26 reads via the `ElectionPeriodReader` PULL, not a push subscription.
    seamConsumers: ["m30", "m31", "m33"],
    isOutboxOnly: true,
  },
  // ── election ──────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.election.drafted",
    moduleOwner: "m6",
    description: "An election statement was drafted for a period (route 15/20).",
    payloadSchema: Type.Object({
      electionPeriodId: Type.String({ minLength: 1 }),
      sequence: Type.Integer({ minimum: 1 }),
      // Same TASK-031 reasoning as the sibling `m6.election.period_started` schema just below:
      // `election_period.effective_at`/`scheduled_end_at` aren't populated at draft time (the
      // statement is drafted before the period is ever activated), so these stay optional rather
      // than fabricated — the only call site (`draftElectionStatement`) never had a source of truth
      // for them and previously omitted all four fields outright, which threw on every single call
      // (payload_schema_violation, since this schema demanded them non-optional).
      startDate: Type.Optional(Type.String({ minLength: 1 })),
      endDate: Type.Optional(Type.String({ minLength: 1 })),
    }),
    // F-101 — `["m22"]` until now. The statement M22 renders is the SIGNED one (`m6.election.signed`,
    // just below, which is bound); a draft has no signature block to render and the CMS artifact is
    // the executed election. Record-only.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.election.signed",
    moduleOwner: "m6",
    description: "The election statement was signed (route 17).",
    payloadSchema: Type.Object({
      electionStatementId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      signedAt: Type.String({ minLength: 1 }),
      /** The chart M22 files the rendered CoP document against (F-100). Every one of these six
       *  artifacts is patient-scoped by definition — there is no defensible null. */
      patientId: Type.String({ minLength: 1 }),
      // FY2027 — additive, optional: what M22's 42 CFR 418.24(b)(1)–(8) statement template prints.
      patientName: Type.Optional(Type.String({ minLength: 1 })),
      signerKind: Type.Optional(
        Type.Union([Type.Literal("patient"), Type.Literal("representative")]),
      ),
      hospiceName: Type.Optional(Type.String({ minLength: 1 })),
      effectiveDate: Type.Optional(Type.String({ minLength: 1 })),
    }),
    // F-106 — m23 REMOVED. M23's §4.4 map routes its NOE draft off this topic, but the two NOT NULL
    // date columns a `noe_record` needs (`election_effective_date`, `window_target_at`) have no source
    // at signing: the election's effective date lives only on `election_period.effective_at`, written
    // by the `setActive` transition at admission ACTIVATION, and the statement carries only `signed_at`.
    // M23 consumes `m6.election.period_started` instead — emitted from the transaction that writes that
    // very column. `declaredConsumers` is a ROUTING input, so naming a module that does not consume the
    // topic defers every emission forever (the F-101 reasoning, same file).
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.election.period_started",
    moduleOwner: "m6",
    description: "An election period activated (admission.activate or auto-advance on recert).",
    payloadSchema: Type.Object({
      electionPeriodId: Type.String({ minLength: 1 }),
      sequence: Type.Integer({ minimum: 1 }),
      // TASK-031: optional, not dropped — `election_period.effective_at`/`scheduled_end_at` are never
      // populated by the §7.1 period-1 seed (`acceptReferral`) or by direct-intake `createAdmission`;
      // computing real dates here would mean fabricating a period-kind-derived (90/60-day) end date the
      // schema has no source of truth for. A consumer that needs the window can read it from
      // `electionPeriodId` via the M6 seam once the seed path actually stores it.
      startDate: Type.Optional(Type.String({ minLength: 1 })),
      endDate: Type.Optional(Type.String({ minLength: 1 })),
      admissionId: Type.String({ minLength: 1 }),
      // F-217 — the F2F/CTI adequacy decision (certification/adequacy.ts) that gated this ACTIVATION.
      // Additive and optional: present only on the recert-activation emission (the one path that runs the
      // gate); absent on the pending-period creation emission and the period-1 seed. A period that reaches
      // this event on the gated path is always `adequate` (an inadequate one refuses and rolls back), so the
      // value a consumer gains is the non-blocking `flags` (late CTI, overridden F2F window) — never PHI,
      // only machine-readable codes.
      adequacy: Type.Optional(
        Type.Object({
          verdict: Type.Union([Type.Literal("adequate"), Type.Literal("inadequate")]),
          f2fRequired: Type.Boolean(),
          reasonCodes: Type.Array(Type.String({ minLength: 1 })),
          flags: Type.Array(Type.String({ minLength: 1 })),
        }),
      ),
    }),
    // F-101 — `m22` was first in this list. A recertification period starting is a billing and cap
    // fact, not a document: the recert artifact is the CTI, rendered from `m6.cti.signed`. Still
    // defers, on m23.
    // F-130 (#248) — m27 REMOVED: same seam-pull reasoning as `m6.admission.activated` (F-130 above) —
    // M27's service-side census reads M6's `LevelOfCarePeriodReader` fresh on demand, never a push
    // subscription to election-period lifecycle events.
    // F-131 (#248) — m26 REMOVED: M26's own §4.4 subscription-map names no `m6.election.*` topic at all —
    // its cap math reads election-period boundaries through the `ElectionPeriodReader` PULL (§1.1 "Depends
    // on"), never a push subscription to a period opening/ending.
    declaredConsumers: ["m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.election.period_ended",
    moduleOwner: "m6",
    description: "An election period auto-ended at midnight on its endDate (trigger).",
    payloadSchema: Type.Object({
      electionPeriodId: Type.String({ minLength: 1 }),
      sequence: Type.Integer({ minimum: 1 }),
      endDate: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
    }),
    // F-130 (#248) — m27 REMOVED: same seam-pull reasoning as `m6.election.period_started` above.
    // F-131 (#248) — m26 REMOVED: same reasoning as `m6.election.period_started` above.
    declaredConsumers: ["m23"],
    isOutboxOnly: true,
  },
  // ── certification (CTI) ─────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.cti.drafted",
    moduleOwner: "m6",
    description:
      "A certification of terminal illness was drafted and assigned to its hospice physician.",
    payloadSchema: Type.Object({
      ctiId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      isRecert: Type.Boolean(),

      hospiceMdId: Type.Optional(Type.String({ minLength: 1 })),

      signatureRequestedAt: Type.Optional(Type.String({ minLength: 1 })),

      signatureDueAt: Type.Optional(Type.String({ minLength: 1 })),
    }),
    // F-129 (#248) — m14 dropped: `patientCover.nextRecertDueAt`/`f2fWindowState` (the packet's only
    // CTI/F2F-derived cover fields) are documented in `PacketCoverInput` (`packages/idg/src/packet/
    // builder.ts`) as read "from M5 `PatientReader` + M6 recert/F2F reader" at build time — a seam pull,
    // matching M14's own §1.1 dependency line ("6 (Admission… — recert/F2F windows shown on the packet
    // cover)"). No CTI lifecycle event is named anywhere in M14's own spec.
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.cti.signed",
    moduleOwner: "m6",
    description: "A CTI was fully signed (route 24, or 25 when both signatures are required).",
    payloadSchema: Type.Object({
      ctiId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      signedAt: Type.String({ minLength: 1 }),
      /** The chart M22 files the rendered CoP document against (F-100). Every one of these six
       *  artifacts is patient-scoped by definition — there is no defensible null. */
      patientId: Type.String({ minLength: 1 }),
      /** GAP-033 - the typed render payload M6 builds in the signing transaction (packages/types render-payloads),
       *  which M22's form compiler validates and draws. Optional on the wire so a producer that cannot resolve a
       *  source still emits; M22 then refuses the id-only event (DLQ) rather than draw a blank form. */
      renderPayload: Type.Optional(Type.Unknown()),
    }),
    // F-140 (#248) — m13 ADDED: M13's own live `M13_OUTBOX_SUBSCRIPTIONS` list names this event with a
    // real decider (`m13.reconciliation-recertification-signed`) that opens the recertification
    // medication-reconciliation worksheet.
    // F-143 (#248) — m12 ADDED: M12's own live `M12_OUTBOX_SUBSCRIPTIONS` list names this event for
    // `m12.recertification-medhx`, backed by the same `decideMedHxFetch` decider per M12's D10 — the
    // MedHx pull also fires "at each F2F window," and a signed CTI is the trigger.
    declaredConsumers: ["m13", "m22", "m23", "m12"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.cti.late_flagged",
    moduleOwner: "m6",
    description: "A CTI was flagged late (route 27); carries the written-cert deadline.",
    payloadSchema: Type.Object({
      ctiId: Type.String({ minLength: 1 }),
      writtenCertDeadlineAt: Type.String({ minLength: 1 }),
    }),
    // F-129 (#248) — m14 dropped: same reasoning as `cti.drafted` above (build-time seam pull).
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.cti.voided",
    moduleOwner: "m6",
    description: "A CTI was voided (route 26).",
    payloadSchema: Type.Object({
      ctiId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    }),
    // F-129 (#248) — m14 dropped: same reasoning as `cti.drafted` above (build-time seam pull).
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.cti.due_7d",
    moduleOwner: "m6",
    description: "A CTI obligation is seven days from its due date.",
    payloadSchema: Type.Object({
      ctiId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      dueAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.cti.due_3d",
    moduleOwner: "m6",
    description: "A CTI obligation is three days from its due date.",
    payloadSchema: Type.Object({
      ctiId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      dueAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.cti.overdue_1d",
    moduleOwner: "m6",
    description: "A CTI obligation is one day overdue.",
    payloadSchema: Type.Object({
      ctiId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      dueAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.cti.signature_requested",
    moduleOwner: "m6",
    description: "A CTI was assigned to the hospice physician for signature.",
    payloadSchema: Type.Object({
      ctiId: Type.String({ minLength: 1 }),
      hospiceMdId: Type.String({ minLength: 1 }),
      requestedAt: Type.String({ minLength: 1 }),
      dueAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.cti.signature_due_1d",
    moduleOwner: "m6",
    description: "A CTI hospice-physician signature is due within one day.",
    payloadSchema: Type.Object({
      ctiId: Type.String({ minLength: 1 }),
      hospiceMdId: Type.String({ minLength: 1 }),
      dueAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.cti.signature_overdue",
    moduleOwner: "m6",
    description: "A CTI hospice-physician signature deadline has passed.",
    payloadSchema: Type.Object({
      ctiId: Type.String({ minLength: 1 }),
      hospiceMdId: Type.String({ minLength: 1 }),
      dueAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── face-to-face ────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.f2f.scheduled",
    moduleOwner: "m6",
    description: "A face-to-face encounter was scheduled (route 28).",
    payloadSchema: Type.Object({
      f2fId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      scheduledDate: Type.String({ minLength: 1 }),
    }),
    // F-129 (#248) — m14 dropped: same reasoning as `m6.cti.drafted` above — `f2fWindowState` is a
    // build-time `PacketCoverInput` seam pull, not a push cache.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    // F-100 — the event the completion transition should always have emitted. It emitted
    // `m6.f2f.scheduled` instead, which no schema could satisfy from the completion path and which said
    // the wrong thing to every consumer. Record-only: completion is an internal step of the §2.3.4 chain
    // and no module acts on it — `m6.f2f.attested` is the CoP-significant moment, and inventing a
    // consumer here would put a permanently-pending row on every completion.
    eventName: "m6.f2f.completed",
    moduleOwner: "m6",
    description:
      "A scheduled face-to-face encounter was recorded as completed (route 30), with the CMS-418.22 window verdict.",
    payloadSchema: Type.Object({
      f2fId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      encounterDate: Type.String({ minLength: 1 }),
      withinWindow: Type.Boolean(),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.f2f.attested",
    moduleOwner: "m6",
    description: "A face-to-face encounter was attested (route 31); may back-ref an encounter.",
    payloadSchema: Type.Object({
      f2fId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      attestedAt: Type.String({ minLength: 1 }),
      encounterId: Type.Optional(Type.String({ minLength: 1 })),
      /** The chart M22 files the rendered CoP document against (F-100). Every one of these six
       *  artifacts is patient-scoped by definition — there is no defensible null. */
      patientId: Type.String({ minLength: 1 }),
      /** GAP-033 - the typed render payload M6 builds in the signing transaction (packages/types render-payloads),
       *  which M22's form compiler validates and draws. Optional on the wire so a producer that cannot resolve a
       *  source still emits; M22 then refuses the id-only event (DLQ) rather than draw a blank form. */
      renderPayload: Type.Optional(Type.Unknown()),
    }),
    declaredConsumers: ["m22", "m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.f2f.window_overridden",
    moduleOwner: "m6",
    description: "The F2F window was overridden by a compliance officer (route 32).",
    payloadSchema: Type.Object({
      f2fId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    }),
    // F-129 (#248) — m14 dropped: same reasoning as `m6.cti.drafted` above (build-time seam pull).
    // F-178 (#248) — m30 MOVED to seamConsumers: M30 now pulls this fact via the real
    // `ComplianceWindowCountsProvider` seam (`f2fWindowOverrideCounts` — override_reason IS NOT NULL among
    // F2F windows due in the scope period), a nightly batch read over `compliance_window`, not a reaction
    // to this push (M6 §7.5 W-OVR-02 is decisive M30's dashboard "Overrides count" is fed by this fact, but
    // names no event handler). This event is F2F-SPECIFIC (`f2fId`, not `complianceWindowId`), so the
    // F2F-scoped seam's coverage is complete for it — unlike its four `m6.compliance.window.*` siblings
    // below, which are generic across all 11 window kinds and stay genuinely unbound (see their own notes).
    declaredConsumers: [],
    seamConsumers: ["m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.f2f.window_missed",
    moduleOwner: "m6",
    description: "The CMS F2F window closed without an attestation (scheduled job trigger).",
    payloadSchema: Type.Object({
      electionPeriodId: Type.String({ minLength: 1 }),
    }),
    // F-129 (#248) — m14 dropped: same reasoning as `m6.cti.drafted` above (build-time seam pull).
    // F-178 (#248) — m30 MOVED to seamConsumers: M30's `ComplianceWindowCountsProvider` reads
    // `compliance_window` table state directly (the F2F window's due date + closed/override status), not
    // this push. F-178b (#248) — HAS A REAL PRODUCER as of this round: `runF2fWindowMissedScanCron`
    // (`jobs/cron-workers.ts`, on the previously-unwired `M6_QUEUES.windowAlert` schedule) opens the
    // `f2f_recert_30d_prior` compliance_window row and publishes this event the moment
    // `decideF2fWindowStatus` first reads "missed" for a recert election period; before this round the
    // event was catalogued but never emitted anywhere (`decideF2fWindowStatus` had zero callers).
    declaredConsumers: [],
    seamConsumers: ["m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.f2f.due_7d",
    moduleOwner: "m6",
    description: "A required face-to-face encounter is seven days from its due date.",
    payloadSchema: Type.Object({
      f2fId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      dueAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.f2f.due_3d",
    moduleOwner: "m6",
    description: "A required face-to-face encounter is three days from its due date.",
    payloadSchema: Type.Object({
      f2fId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      dueAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.f2f.overdue_1d",
    moduleOwner: "m6",
    description: "A required face-to-face encounter is one day overdue.",
    payloadSchema: Type.Object({
      f2fId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      dueAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── level of care ───────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.loc.changed",
    moduleOwner: "m6",
    description: "The level of care changed (route 33); opens a new level-of-care period.",
    payloadSchema: Type.Object({
      levelOfCarePeriodId: Type.String({ minLength: 1 }),
      newLevel: levelOfCare,
      effectiveStart: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
    }),
    // F-101 — `m22` was first in this list. A level-of-care change is a revenue and quality fact with
    // no M22 template behind it. Still defers, on m23.
    // F-130 (#248) — m27 REMOVED: this IS the exact table (`level_of_care_period`) M27's own
    // `LevelOfCarePeriodReader` seam pull reads for Worksheet S-3 — "the service-side patient-day census
    // … independent of M23's billed days" per M27's §1.1 dependency line — never an outbox subscription.
    // F-131 (#248) — m26 REMOVED: M26's cap math is per-beneficiary and benefit-period-anchored
    // (`ElectionPeriodReader`), not level-of-care-anchored; its own D13 names the INPATIENT (20% rule) day
    // source as M23 claim lines by revenue code (0655/0656), never M6 LOC periods, and its
    // subscription-map.ts names no `m6.loc.changed` topic.
    // GAP-071 — m24 ADDED: M24's spec (§4.4 `m6-loc-changed.consumer.ts`) re-evaluates the patient's
    // not-yet-billed `rb_day` rows from `effectiveStart` (`24-billing-medicaid/outbox-consumers/m24-rb-day-consumers.ts`).
    declaredConsumers: ["m23", "m24"],
    // F-115 (#248) — m30 moved here from declaredConsumers: it reads LOC data via
    // `LevelOfCarePeriodReader.chcOrGipCoverageCounts`/`.levelOfCareDaySpans` (HCI indicators 1/8/9) on
    // its own nightly cadence, not by reacting to this event — no consumer binds it or ever will.
    seamConsumers: ["m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.level_of_care.activated",
    moduleOwner: "m6",
    description:
      "M6 activated an IPU level-of-care period (`assigning` -> `active`) after verifying the M37 bed " +
      "assignment (`confirmLocBedAssignment`, M6 §2.3.5 / M37 §2.2 handshake). M37 acknowledges it by " +
      "confirming the matching `bed_assigned` admission.",
    payloadSchema: Type.Object({
      levelOfCarePeriodId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      // Only the two IPU levels ever pass through `assigning`, so only they can activate this way.
      newLevel: Type.Union([
        Type.Literal("inpatient_respite_care"),
        Type.Literal("general_inpatient_care"),
      ]),
      activatedAt: Type.String({ minLength: 1 }),
    }),
    // M37 §2.2 (`bed_assigned` -> `active`: "M6 LCP confirmation event received") and §4.5 name this as
    // the event M37's `confirm` is driven by; `m37.lcp-activated` is the binding.
    declaredConsumers: ["m37"],
    isOutboxOnly: true,
  },
  // ── revocation / transfer ───────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.revocation.created",
    moduleOwner: "m6",
    description: "The beneficiary revoked the hospice election (route 36).",
    payloadSchema: Type.Object({
      revocationEventId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      revocationDate: Type.String({ minLength: 1 }),
      /** The chart M22 files the rendered CoP document against (F-100). Every one of these six
       *  artifacts is patient-scoped by definition — there is no defensible null. */
      patientId: Type.String({ minLength: 1 }),
      /** GAP-033 - the typed render payload M6 builds in the signing transaction (packages/types render-payloads),
       *  which M22's form compiler validates and draws. Optional on the wire so a producer that cannot resolve a
       *  source still emits; M22 then refuses the id-only event (DLQ) rather than draw a blank form. */
      renderPayload: Type.Optional(Type.Unknown()),
    }),
    declaredConsumers: ["m22", "m23", "m26"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.transfer.created",
    moduleOwner: "m6",
    description: "A hospice transfer (in/out) was recorded (routes 37/38).",
    payloadSchema: Type.Object({
      transferEventId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      direction: Type.Union([Type.Literal("in"), Type.Literal("out")]),
      /** F-107 — the transfer's own effective date (`transfer_event.effective_at`, NOT NULL). A
       *  transfer-OUT ends the hospice benefit, and 42 CFR 418.26 dates the 5-day NOTR window from
       *  THIS date. It is not derivable downstream: `transferOut` discharges the admission through
       *  `dischargeAdmissionTx`, which stamps `admission.discharged_at = now()` — the instant the
       *  paperwork was filed, not the day the transfer took effect. Both emit sites have it in hand. */
      effectiveAt: Type.String({ minLength: 1 }),
      otherHospiceCcn: Type.Optional(Type.String({ minLength: 1 })),
      /** F-192 (#248) — the chart M22 files the rendered transfer-summary document against (F-100's
       *  "every one of these artifacts is patient-scoped by definition — there is no defensible null"
       *  reasoning, one event over). Widened onto both real emit sites (`transferOut`/`transferIn`,
       *  `admission-route-service-db.ts`), which already resolve the admission's patient in the same
       *  transaction. */
      patientId: Type.String({ minLength: 1 }),
      /** GAP-033 - the typed render payload M6 builds in the signing transaction (packages/types render-payloads),
       *  which M22's form compiler validates and draws. Optional on the wire so a producer that cannot resolve a
       *  source still emits; M22 then refuses the id-only event (DLQ) rather than draw a blank form. */
      renderPayload: Type.Optional(Type.Unknown()),
    }),
    declaredConsumers: ["m13", "m22", "m23", "m26"],
    isOutboxOnly: true,
  },
  // ── discharge ───────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.discharge.created",
    moduleOwner: "m6",
    description: "A discharge was recorded (route 39; also recordExternalDeath via the applier).",
    payloadSchema: Type.Object({
      dischargeEventId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
      dischargeDate: Type.String({ minLength: 1 }),
      requiresMedicalDirectorCosign: Type.Boolean(),
      /** The chart M22 files the rendered CoP document against (F-100). Every one of these six
       *  artifacts is patient-scoped by definition — there is no defensible null. */
      patientId: Type.String({ minLength: 1 }),
      /** GAP-033 - the typed render payload M6 builds in the signing transaction (packages/types render-payloads),
       *  which M22's form compiler validates and draws. Optional on the wire so a producer that cannot resolve a
       *  source still emits; M22 then refuses the id-only event (DLQ) rather than draw a blank form. */
      renderPayload: Type.Optional(Type.Unknown()),
      source: applierSource,
    }),
    // F-129 (#248) — m14 dropped: redundant with `m6.admission.discharged`, M14's own §4.5-table
    // inclusion-cache subscription (D9) — same discharge transaction, same `admissionId`/`dischargeDate`
    // facts M14 actually needs. `discharge.created`'s richer `dischargeEventId`/`requiresMedicalDirectorCosign`
    // fields serve M22/M23, which `admission.discharged`'s payload does not carry.
    // F-131 (#248) — m26 REMOVED: an ordinary discharge (this event) is a benefit-period boundary M26
    // reads via the `ElectionPeriodReader` PULL, not a push subscription; M26's own §4.4 subscription-map
    // names only `m6.revocation.created`/`m6.transfer.created` from M6.
    // F-140 (#248) — m13 ADDED: M13's own live `M13_OUTBOX_SUBSCRIPTIONS` list names this event with a
    // real decider (`m13.reconciliation-discharge-executed`) that opens the discharge worksheet and
    // emits `m13.comfort_kit.return_required`.
    declaredConsumers: ["m13", "m22", "m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.discharge.death",
    moduleOwner: "m6",
    description:
      "Discharge reason was death (route 39 / recordExternalDeath) — via " +
      "M5's §7.8 death cascade (GAP-004), flips patient.status='deceased'; also drives M37's own " +
      "`recordDeath` transition for an IPU-facility death (F-172/#248).",
    payloadSchema: Type.Object({
      dischargeEventId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      dischargeDate: Type.String({ minLength: 1 }),
      source: applierSource,
      // F-172 (#248) — widened at the source rather than resolved through a new seam: `dischargeType
      // === "death"` requires `deathCertifierId` be present (`checkDischargeNarrative`, enforced before
      // `dischargeAdmissionTx` ever runs), so the fact is already in hand at the one real emit site
      // (`admission-route-service-db.ts`'s `dischargeAdmissionTx`) — the F-099/F-100 "the artifact is
      // already at the emit site" shape. M37's `ipu_body_release.pronouncing_physician_id` (NOT NULL)
      // is the consumer this widening exists for.
      // F-227 (#248) — OPTIONAL now: an external (M29-accepted) death names no pronouncing certifier at
      // intake (M6 §4.8.4 recordExternalDeath; the sending facility pronounced, the medical-director
      // cosign attests). M37's body-release opener needs the physician and skips when it is absent.
      deathCertifierId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    // F-134 (#248) — `m16` removed: this event is co-emitted with `m6.bereavement.eligible` from the
    // SAME `runEffects` call on the SAME death-discharge transition (`admission-route-service-db.ts`
    // — both are in one `t.effects` map keyed off one transition); `bereavement.eligible`'s own
    // description says it IS the "post-rule check on `m6.discharge.death`" — so `discharge.death` is
    // the source and `bereavement.eligible` is the already-bound, already-correct M16 handshake.
    // M16's own `consumers/m6-eligibility.ts` reads only `bereavement.eligible`, never this event.
    // F-172 (#248) — `m37` ADDED: the real, previously-missing producer for `transitionAdmission(...,
    // {type: "recordDeath"})` (`packages/inpatient`), which §2.2 documents as "driven by the M6 death
    // consumer (system actor)". M16 is deliberately NOT added here even though it is a declared
    // consumer of the DOWNSTREAM `m37.ipu_admission.death_recorded` event — see that event's own entry
    // in `events-by-m37.ts` for why that declaration is being dropped as redundant in the same change.
    // GAP-089 — m30 ADDED: the mortality-review auto-creator (M30 §4.10, D9) consumes this event
    // (`30-quality/outbox-consumers/m6-discharge-death.ts`, mortality half; the CAHPS half is separate).
    declaredConsumers: ["m5", "m30", "m37"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.discharge.cosigned",
    moduleOwner: "m6",
    description:
      "A discharge was cosigned by the medical director (route 40): completes a for-cause " +
      "discharge, or attests an external-source death (F-227; carries `sourceProposalId`).",
    payloadSchema: Type.Object({
      dischargeEventId: Type.String({ minLength: 1 }),
      medicalDirectorCosignedAt: Type.String({ minLength: 1 }),
      // F-176 (#248) — widened for M22's cosign render (a new VERSION of the discharge summary, M22 spec §4.11/§7.17).
      // The renderer files the document against the chart and renders the same facts `m6.discharge.created` carried.
      admissionId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      /** GAP-033 - the typed render payload M6 builds in the signing transaction (packages/types render-payloads),
       *  which M22's form compiler validates and draws. Optional on the wire so a producer that cannot resolve a
       *  source still emits; M22 then refuses the id-only event (DLQ) rather than draw a blank form. */
      renderPayload: Type.Optional(Type.Unknown()),
      dischargeDate: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
      // F-227 (#248) — the D18 release facts for an EXTERNAL-source death's cosign (M16 spec §4.3.1
      // `receiveCosignAndReleaseGate` needs `{sourceProposalId, cosignedAt, medicalDirectorMembershipId}`;
      // `cosignedAt` is `medicalDirectorCosignedAt`). Additive + optional: absent on a for-cause cosign
      // (route 40 over a `pending_cosign` row), which is not an external-source plan's gate.
      sourceProposalId: Type.Optional(Type.String({ minLength: 1 })),
      medicalDirectorMembershipId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    // F-094/#205 — M16's `consumers/m6-eligibility.ts` carries `decideCosignReceipt`, the D18
    // gate-release decider for exactly this topic, and the catalog named only m22.
    declaredConsumers: ["m16", "m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.discharge.details_recorded",
    moduleOwner: "m6",
    description:
      "A claim-relevant detail was recorded after the fact (discharge-details routes): the place of death on " +
      "a completed death discharge or the receiving care setting on a transfer-out. They set the Medicare " +
      "claim's patient discharge status (40/41/42, 50/51), so M23 re-validates the admission's open claims.",
    payloadSchema: Type.Object({
      admissionId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      detail: Type.Union([Type.Literal("place_of_death"), Type.Literal("receiving_care_setting")]),
      dischargeEventId: Type.Optional(Type.String({ minLength: 1 })),
      transferEventId: Type.Optional(Type.String({ minLength: 1 })),
      value: Type.String({ minLength: 1 }),
      previousValue: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      corrected: Type.Boolean(),
    }),
    // M23 is the only consumer: its `revalidate` effect re-runs the discharge rule against the new value.
    declaredConsumers: ["m23"],
    isOutboxOnly: true,
  },
  // ── notice of rights ────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.nor.acknowledged",
    moduleOwner: "m6",
    description: "The Notice of Rights was acknowledged (route 41).",
    payloadSchema: Type.Object({
      norAcknowledgmentId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      acknowledgedAt: Type.String({ minLength: 1 }),
      /** The chart M22 files the rendered CoP document against (F-100). Every one of these six
       *  artifacts is patient-scoped by definition — there is no defensible null. */
      patientId: Type.String({ minLength: 1 }),
      /** GAP-033 - the typed render payload M6 builds in the signing transaction (packages/types render-payloads),
       *  which M22's form compiler validates and draws. Optional on the wire so a producer that cannot resolve a
       *  source still emits; M22 then refuses the id-only event (DLQ) rather than draw a blank form. */
      renderPayload: Type.Optional(Type.Unknown()),
    }),
    // F-136 (#248) — m23 REMOVED: the Notice of Rights is never mentioned anywhere in M23's own spec —
    // no dependsOn text, no §4.4 subscription, no NOE/NOTR/claim mechanism references it. M22 remains
    // the real consumer (the rendered CoP document, per F-100).
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  // ── compliance windows ──────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.compliance.window.opened",
    moduleOwner: "m6",
    description:
      "A compliance window opened (trigger/job/applier); `severity='info'` = D15 external signal.",
    payloadSchema: Type.Object({
      complianceWindowId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      windowType: Type.String({ minLength: 1 }),
      dueAt: Type.String({ minLength: 1 }),
      severity: windowSeverity,
      source: applierSource,
    }),
    // F-145 (#248) — m14 REMOVED: same as `m6.admission.on_hold` above — no support in M14's own
    // exhaustive build-description; M6's own text (line 599) assigns the real overdue-window consumer to
    // M36's escalation chain, not M14.
    // F-178 (#248) — m30 investigated, genuinely unbound at the time: this event is GENERIC across all 11
    // `complianceWindowKind` values (payload carries `windowType`, not just F2F) — M6's spec (line 3868)
    // confirms non-F2F kinds are real and actively created (`concurrent_hospital_admission`,
    // `external_discharge_notice`, `hl7_admission_cancellation` informational windows). The
    // `ComplianceWindowCountsProvider` seam F-178 built is hardcoded to `windowKind = 'f2f_recert_30d_prior'`
    // only (by design — Phase 1 was scoped to the F2F cluster), so it resolves NOTHING for the other 10
    // window kinds.
    // F-179 (#248) — m30 DROPPED: the "M30 dashboard pulls open windows"/"Overrides — last 30 days" text
    // M6's spec (line 2322/2330/3047) describes for this GENERIC, all-window-kind fact is already satisfied
    // by `GET /api/v1/compliance-windows` (`admission-routes.ts` route 44 — org-wide, all window kinds,
    // filterable, gated by `compliance.read`/`compliance.scope`, explicitly "org-wide for
    // compliance_officer"). This is a direct frontend-to-M6 REST read, not a backend module-to-module
    // relationship — no M30 route, seam registration, or UI screen spec for an M30-owned dashboard exists
    // anywhere (grepped); the `ComplianceReader`/`listOpenWindows` interface `packages/types/src/admission.ts`
    // pre-declares for exactly this shape has zero registrations/implementations/callers, a pure aspirational
    // leftover. Nothing for the outbox/seam registry to track: misdeclared, not merely unbuilt.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.compliance.window.closed",
    moduleOwner: "m6",
    description: "A compliance window closed (trigger); carries how it was closed.",
    payloadSchema: Type.Object({
      complianceWindowId: Type.String({ minLength: 1 }),
      closedAt: Type.String({ minLength: 1 }),
      closedVia: Type.String({ minLength: 1 }),
    }),
    // F-178/F-179 (#248) — m30 investigated then DROPPED — same reasoning as `m6.compliance.window.opened`
    // above: this is the GENERIC, all-window-kind close event; the real "M30 reads this" fact is already
    // satisfied by `GET /api/v1/compliance-windows`, a direct frontend REST read, not a backend relationship.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.compliance.window.overdue",
    moduleOwner: "m6",
    description: "The `admission.window_alert` job moved an overdue window to alert severity.",
    payloadSchema: Type.Object({
      complianceWindowId: Type.String({ minLength: 1 }),
      severity: Type.Literal("alert"),
      // GAP-026 — the escalation scan (`jobs/window-escalation.ts`) adds the routing facts M36 pages on.
      admissionId: Type.Optional(Type.String({ minLength: 1 })),
      patientId: Type.Optional(Type.String({ minLength: 1 })),
      windowKind: Type.Optional(Type.String({ minLength: 1 })),
      dueAt: Type.Optional(Type.String({ minLength: 1 })),
    }),
    // F-145 (#248) — m14 REMOVED: M6's own spec (line 599) is decisive and names the OPPOSITE
    // consumer for this exact fact: "`compliance_window.overdue` (for any window) → M36 escalating
    // alert chain (clinician → supervisor → DON)" — not mere silence, an affirmative counter-claim.
    // F-178/F-179 (#248) — m30 investigated then DROPPED — same reasoning as `m6.compliance.window.opened`
    // above: generic across all window kinds; already satisfied by the direct `GET /api/v1/compliance-windows`
    // REST read, not a backend relationship.
    // GAP-026 — m36 BOUND: `m36.admission-compliance-alerts` pages the care team + compliance on every
    // non-addendum window kind (the addendum kinds keep their dedicated `m6.election_addendum.overdue`).
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.compliance.window.overridden",
    moduleOwner: "m6",
    description: "A compliance window was overridden by a compliance officer (route 46).",
    payloadSchema: Type.Object({
      complianceWindowId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    }),
    // F-178/F-179 (#248) — m30 investigated then DROPPED — same reasoning as `m6.compliance.window.opened`
    // above: this generic route-46 override event fires for ANY window kind, already satisfied by the direct
    // `GET /api/v1/compliance-windows` REST read. Not to be confused with the F2F-specific
    // `m6.f2f.window_overridden` sibling above, which the F-178 seam genuinely does bind as a real backend
    // relationship.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  // ── FY2027 election statement addendum (42 CFR 418.24(c)/(d), CMS-1851-F) ─────────────────────────────
  {
    eventName: "m6.election_addendum.drafted",
    moduleOwner: "m6",
    description:
      "An election statement addendum version was drafted (the initial one at election, or an update after a plan-of-care change).",
    payloadSchema: Type.Object({
      electionAddendumId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      versionNumber: Type.Integer({ minimum: 1 }),
      trigger: Type.Union([Type.Literal("initial"), Type.Literal("poc_change")]),
      dueAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    }),
    // Record-only: the clock is the compliance window opened in the same transaction, and the window's own
    // overdue event (below) is what pages someone.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.election_addendum.furnished",
    moduleOwner: "m6",
    description:
      "An addendum version was furnished in writing (418.24(c)(10)) — M22 renders the 'Patient Notification of Hospice Non-Covered Items, Services, and Drugs' PDF from `renderPayload`.",
    payloadSchema: Type.Object({
      electionAddendumId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      /** The chart M22 files the rendered addendum against. */
      patientId: Type.String({ minLength: 1 }),
      versionNumber: Type.Integer({ minimum: 1 }),
      furnishedAt: Type.String({ minLength: 1 }),
      furnishMethod: Type.Union([
        Type.Literal("paper"),
        Type.Literal("electronic_with_paper_copy"),
      ]),
      /** Every 418.24(c)(1)–(10) element, already resolved (election-addendum/render-payload.ts). */
      renderPayload: Type.Unknown(),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.election_addendum.acknowledged",
    moduleOwner: "m6",
    description:
      "A furnished addendum version was signed, refused (reason documented), or marked signature-not-required — M22 appends a new version of the same PDF carrying the notation (418.24(c)(9), (d)(4)).",
    payloadSchema: Type.Object({
      electionAddendumId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      versionNumber: Type.Integer({ minimum: 1 }),
      outcome: Type.Union([
        Type.Literal("signed"),
        Type.Literal("refused"),
        Type.Literal("signature_not_required"),
      ]),
      acknowledgedAt: Type.String({ minLength: 1 }),
      renderPayload: Type.Unknown(),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.election_addendum.not_required",
    moduleOwner: "m6",
    description:
      "An unfurnished addendum version was marked not required because the patient died, revoked, or was discharged first (418.24(d)(3)).",
    payloadSchema: Type.Object({
      electionAddendumId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      versionNumber: Type.Integer({ minimum: 1 }),
      reason: Type.Union([
        Type.Literal("death"),
        Type.Literal("revocation"),
        Type.Literal("discharge"),
      ]),
    }),
    // Record-only: nothing downstream acts on a closed obligation; M23 reads the settled state through the
    // claim-assembly addendum seam (`electionAddendumComplianceForOrg`).
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.election_addendum.overdue",
    moduleOwner: "m6",
    description:
      "An addendum's 418.24(d) window (5 days from election / 3 days from a plan-of-care change) passed without it being furnished — M36 alerts the care team and compliance.",
    payloadSchema: Type.Object({
      complianceWindowId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      electionAddendumId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      windowKind: Type.Union([
        Type.Literal("election_addendum_initial"),
        Type.Literal("election_addendum_update"),
      ]),
      dueAt: Type.String({ minLength: 1 }),
    }),
    // A DEDICATED overdue event rather than the generic `m6.compliance.window.overdue`: that one is emitted for
    // every window kind, carries no patient, and has no consumer (F-178/F-179). The addendum is a condition for
    // payment, so its miss needs a page with a patient to route on.
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── Milestone 10a: NOMNC delivery + BFCC-QIO expedited review (record-keeping; every clock is typed) ───────
  // PHI-free: ids, the deadline kind and instants only (the representative name, QIO name and every note stay in
  // the tables). M36 pages the care team and compliance by event NAME; M6 never imports M36.
  {
    eventName: "m6.nomnc.recorded",
    moduleOwner: "m6",
    description:
      "A NOMNC delivery was recorded on an admission (or superseded a prior record). Informational: no consumer.",
    payloadSchema: Type.Object({
      nomncNoticeId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      supersededNoticeId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.expedited_review.opened",
    moduleOwner: "m6",
    description:
      "Staff opened a BFCC-QIO expedited review for a NOMNC (the QIO told the hospice). M36 alerts the care team and compliance right away: the provider duties start that same day.",
    payloadSchema: Type.Object({
      expeditedReviewId: Type.String({ minLength: 1 }),
      nomncNoticeId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      qioNotifiedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.expedited_review.decided",
    moduleOwner: "m6",
    description:
      "The QIO's outcome was recorded as a fact (upheld / reversed / other). Informational: nothing is unwound automatically.",
    payloadSchema: Type.Object({
      expeditedReviewId: Type.String({ minLength: 1 }),
      nomncNoticeId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      outcome: Type.Union([
        Type.Literal("discharge_upheld"),
        Type.Literal("discharge_reversed"),
        Type.Literal("other"),
      ]),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.expedited_deadline.approaching",
    moduleOwner: "m6",
    description:
      "An unsatisfied typed deadline crossed a product alert boundary (24 / 4 / 1 hours before it). M36 alerts the care team and compliance.",
    payloadSchema: Type.Object({
      expeditedDeadlineId: Type.String({ minLength: 1 }),
      subject: Type.Union([Type.Literal("notice"), Type.Literal("review")]),
      kind: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      dueAt: Type.String({ minLength: 1 }),
      boundaryHours: Type.Number({ minimum: 1 }),
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.expedited_deadline.overdue",
    moduleOwner: "m6",
    description:
      "A typed deadline passed unsatisfied. Emitted once per deadline; M36 alerts the care team and compliance.",
    payloadSchema: Type.Object({
      expeditedDeadlineId: Type.String({ minLength: 1 }),
      subject: Type.Union([Type.Literal("notice"), Type.Literal("review")]),
      kind: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      dueAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── bereavement / applier ───────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.bereavement.eligible",
    moduleOwner: "m6",
    description:
      "Post-rule check on `m6.discharge.death` cleared bereavement onboarding (W-DC-01).",
    payloadSchema: Type.Object({
      admissionId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      eligibleAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m16"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.applier.refused",
    moduleOwner: "m6",
    description: "The AdmissionEventApplier refused an M29 proposal on a contract violation (D13).",
    payloadSchema: Type.Object({
      proposalId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
      refusedAt: Type.String({ minLength: 1 }),
    }),
    // F-180 (#248) — m30 DROPPED: M6's own spec places this beside a Prometheus gauge
    // (`m6_applier_refused_total`, "dashboard data source") — its own framing is ops/observability, not a
    // cross-module business-fact handoff. M30's own locked spec never mentions "applier"/"external-event"
    // anywhere (0 hits), including its compile-checked §4.4 consumed-seams table. The refusal is already
    // durably recorded independent of any consumer, via the live `m6.applier.contract_violation_refused`
    // audit action (compliance retention). If a real gap remains, it's the never-built
    // `m6_applier_refused_total` counter on the M6 side — metrics, not an outbox consumer.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
];
