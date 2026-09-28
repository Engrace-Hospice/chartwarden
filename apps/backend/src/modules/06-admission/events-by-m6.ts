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
import type { ModuleEventContribution } from "@wardenx/types";

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
    description:
      "Referral review was started; lifecycle moved to under_review.",
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
    description:
      "Referral was placed in pending_information while intake waits for more data.",
    payloadSchema: Type.Object({ referralId: Type.String({ minLength: 1 }) }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.referral.qualified",
    moduleOwner: "m6",
    description:
      "Referral was qualified after patient resolution and intake readiness checks.",
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
    payloadSchema: Type.Object({ referralId: Type.String({ minLength: 1 }) }),
    declaredConsumers: [],
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
    description:
      "A triage outcome (eligible/ineligible) was recorded (route 5).",
    payloadSchema: Type.Object({
      referralId: Type.String({ minLength: 1 }),
      outcome: Type.Union([
        Type.Literal("eligible"),
        Type.Literal("ineligible"),
      ]),
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
    }),
    declaredConsumers: [],
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
    }),
    declaredConsumers: [],
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
    description:
      "Admission activated (route 14) — the broad fan-out the whole system keys off.",
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
      "m8",
      // #48 — M10 materializes the three admission-anchored HOPE timepoint windows here. It was absent
      // from this list for the same reason nothing ever inserted a `hope_timepoint_schedule` row: the
      // handshake the planners were written for had no consumer end.
      "m10",
      "m11",
      "m14",
      // F-103 — M15 bootstraps the three CoP discipline plans here (§1.1 D10), and this list did not name
      // it, so the consumer could not be bound and NOTHING in the repository has ever inserted a
      // `discipline_care_plan` row. Every M15 write route is `/discipline-plans/:planId/…`, so that
      // consumer is the only creation path there is.
      "m15",
      "m16",
      // F-101 — `m22` was here. The activation is the platform's broadest clinical fan-out and it
      // renders nothing: M22's §4.11 consumer table names six M6 events (election.signed, cti.signed,
      // f2f.attested, nor.acknowledged, revocation.created, discharge.created) plus the two still
      // deferred below, and this is not among them. Unlike the three that went record-only, this entry
      // still defers — on the other twelve unbound consumers, which is the true reason.
      "m23",
      "m26",
      "m27",
      "m37",
    ],
    // F-115 (#248) — m28 REMOVED: the FHIR gateway resolves every seam it reads (M5/M6/M7/M8/M11/M12/M13)
    // fresh at REQUEST time (§164.528 D3, F-035) and holds no cached/derived state an admission event
    // would ever need to invalidate — it never subscribes to anything. m30 REMOVED from declaredConsumers
    // and added to seamConsumers: it has no reactive handler for this event (packages/quality/src/
    // consumers/ covers exactly six upstream topics, per M30_OUTBOX_SUBSCRIPTIONS, and this is not one of
    // them); it reads this fact via `AdmissionOnsetReader.listAdmissionsStartedInPeriod` on its own nightly
    // recompute cadence (the `opioid_on_admission_rate` denominator) instead — the m33/m36 shape, not an
    // outbox subscription that will ever bind.
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
    declaredConsumers: ["m14", "m17", "m30"],
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
    declaredConsumers: ["m14", "m17", "m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.admission.discharged",
    moduleOwner: "m6",
    description:
      "Admission discharged (routes 36/37/38/39) — the broad close-out fan-out.",
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
      "m14",
      "m7",
      "m16",
      "m17",
      // F-101 — `m22` was here. The discharge SUMMARY is rendered from `m6.discharge.created`, which
      // carries the `discharge_event` id M22 back-refs; this event carries the ADMISSION id and no
      // renderable artifact. Still defers, on the other eight.
      "m23",
      "m26",
      "m27",
      "m37",
      "m36",
    ],
    // F-115 (#248) — m28/m30 removed for the same reason as `m6.admission.activated` just above: m28
    // never subscribes to anything (request-time-only reads), and m30 reads this fact via
    // `DischargeReader.liveDischargeTimingCounts` (HCI indicators 3/4) on its nightly cadence rather than
    // reacting to this event.
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  // ── election ──────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.election.drafted",
    moduleOwner: "m6",
    description:
      "An election statement was drafted for a period (route 15/20).",
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
    description:
      "An election period activated (admission.activate or auto-advance on recert).",
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
    }),
    // F-101 — `m22` was first in this list. A recertification period starting is a billing and cap
    // fact, not a document: the recert artifact is the CTI, rendered from `m6.cti.signed`. Still
    // defers, on m23/m26/m27.
    declaredConsumers: ["m23", "m26", "m27"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.election.period_ended",
    moduleOwner: "m6",
    description:
      "An election period auto-ended at midnight on its endDate (trigger).",
    payloadSchema: Type.Object({
      electionPeriodId: Type.String({ minLength: 1 }),
      sequence: Type.Integer({ minimum: 1 }),
      endDate: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m23", "m26", "m27"],
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
    description:
      "A CTI was fully signed (route 24, or 25 when both signatures are required).",
    payloadSchema: Type.Object({
      ctiId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      signedAt: Type.String({ minLength: 1 }),
      /** The chart M22 files the rendered CoP document against (F-100). Every one of these six
       *  artifacts is patient-scoped by definition — there is no defensible null. */
      patientId: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m22", "m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.cti.late_flagged",
    moduleOwner: "m6",
    description:
      "A CTI was flagged late (route 27); carries the written-cert deadline.",
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
    description:
      "A face-to-face encounter was attested (route 31); may back-ref an encounter.",
    payloadSchema: Type.Object({
      f2fId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      attestedAt: Type.String({ minLength: 1 }),
      encounterId: Type.Optional(Type.String({ minLength: 1 })),
      /** The chart M22 files the rendered CoP document against (F-100). Every one of these six
       *  artifacts is patient-scoped by definition — there is no defensible null. */
      patientId: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m22", "m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.f2f.window_overridden",
    moduleOwner: "m6",
    description:
      "The F2F window was overridden by a compliance officer (route 32).",
    payloadSchema: Type.Object({
      f2fId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    }),
    // F-129 (#248) — m14 dropped: same reasoning as `m6.cti.drafted` above (build-time seam pull).
    declaredConsumers: ["m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.f2f.window_missed",
    moduleOwner: "m6",
    description:
      "The CMS F2F window closed without an attestation (scheduled job trigger).",
    payloadSchema: Type.Object({
      electionPeriodId: Type.String({ minLength: 1 }),
    }),
    // F-129 (#248) — m14 dropped: same reasoning as `m6.cti.drafted` above (build-time seam pull).
    declaredConsumers: ["m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.f2f.due_7d",
    moduleOwner: "m6",
    description:
      "A required face-to-face encounter is seven days from its due date.",
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
    description:
      "A required face-to-face encounter is three days from its due date.",
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
    description:
      "The level of care changed (route 33); opens a new level-of-care period.",
    payloadSchema: Type.Object({
      levelOfCarePeriodId: Type.String({ minLength: 1 }),
      newLevel: levelOfCare,
      effectiveStart: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
    }),
    // F-101 — `m22` was first in this list. A level-of-care change is a revenue and quality fact with
    // no M22 template behind it. Still defers, on m23/m26/m27.
    declaredConsumers: ["m23", "m26", "m27"],
    // F-115 (#248) — m30 moved here from declaredConsumers: it reads LOC data via
    // `LevelOfCarePeriodReader.chcOrGipCoverageCounts`/`.levelOfCareDaySpans` (HCI indicators 1/8/9) on
    // its own nightly cadence, not by reacting to this event — no consumer binds it or ever will.
    seamConsumers: ["m30"],
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
    }),
    declaredConsumers: ["m13", "m22", "m23", "m26"],
    isOutboxOnly: true,
  },
  // ── discharge ───────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.discharge.created",
    moduleOwner: "m6",
    description:
      "A discharge was recorded (route 39; also recordExternalDeath via the applier).",
    payloadSchema: Type.Object({
      dischargeEventId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
      dischargeDate: Type.String({ minLength: 1 }),
      requiresMedicalDirectorCosign: Type.Boolean(),
      /** The chart M22 files the rendered CoP document against (F-100). Every one of these six
       *  artifacts is patient-scoped by definition — there is no defensible null. */
      patientId: Type.String({ minLength: 1 }),
      source: applierSource,
    }),
    // F-129 (#248) — m14 dropped: redundant with `m6.admission.discharged`, M14's own §4.5-table
    // inclusion-cache subscription (D9) — same discharge transaction, same `admissionId`/`dischargeDate`
    // facts M14 actually needs. `discharge.created`'s richer `dischargeEventId`/`requiresMedicalDirectorCosign`
    // fields serve M22/M23/M26, which `admission.discharged`'s payload does not carry.
    declaredConsumers: ["m22", "m23", "m26"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.discharge.death",
    moduleOwner: "m6",
    description:
      "Discharge reason was death (route 39 / recordExternalDeath) — seeds bereavement (D6) and, via " +
      "M5's §7.8 death cascade (GAP-004), flips patient.status='deceased'.",
    payloadSchema: Type.Object({
      dischargeEventId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      dischargeDate: Type.String({ minLength: 1 }),
      source: applierSource,
    }),
    declaredConsumers: ["m16", "m5"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.discharge.cosigned",
    moduleOwner: "m6",
    description:
      "A for-cause discharge was cosigned by the medical director (route 40).",
    payloadSchema: Type.Object({
      dischargeEventId: Type.String({ minLength: 1 }),
      medicalDirectorCosignedAt: Type.String({ minLength: 1 }),
    }),
    // F-094/#205 — M16's `consumers/m6-eligibility.ts` carries `decideCosignReceipt`, the D18
    // gate-release decider for exactly this topic, and the catalog named only m22.
    declaredConsumers: ["m16", "m22"],
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
    }),
    declaredConsumers: ["m22", "m23"],
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
    declaredConsumers: ["m14", "m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.compliance.window.closed",
    moduleOwner: "m6",
    description:
      "A compliance window closed (trigger); carries how it was closed.",
    payloadSchema: Type.Object({
      complianceWindowId: Type.String({ minLength: 1 }),
      closedAt: Type.String({ minLength: 1 }),
      closedVia: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.compliance.window.overdue",
    moduleOwner: "m6",
    description:
      "The `admission.window_alert` job moved an overdue window to alert severity.",
    payloadSchema: Type.Object({
      complianceWindowId: Type.String({ minLength: 1 }),
      severity: Type.Literal("alert"),
    }),
    declaredConsumers: ["m14", "m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.compliance.window.overridden",
    moduleOwner: "m6",
    description:
      "A compliance window was overridden by a compliance officer (route 46).",
    payloadSchema: Type.Object({
      complianceWindowId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m30"],
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
    description:
      "The AdmissionEventApplier refused an M29 proposal on a contract violation (D13).",
    payloadSchema: Type.Object({
      proposalId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
      refusedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m30"],
    isOutboxOnly: true,
  },
];
