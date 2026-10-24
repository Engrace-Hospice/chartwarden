import type { ModuleEventContribution } from "@chartwarden/types";
// apps/backend/src/modules/10-hope/events-by-m10.ts — Module 10's outbox-event contributions
// (M10-T06, spec §2.4 / §4.8). The full `m10.hope.*` taxonomy keyed on M10's own tables, under the
// `m10.` namespace (M01 D8 outbox_event_catalog / M03 D9 / M04 D9). check-fitness-gaps.ts scans this file
// for naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m10'), and valid declared consumers (real
// module ids). The spec §2.4 lists in-module shorthand topics (`hope.timepoint.signed`); the canonical
// wire `eventName` published to the M1 dispatcher follows M1 §3.17 (`m10.hope.<entity>_<verb>`) and
// mirrors `M10_EVENT_NAMES` in @chartwarden/types (the closed set the record/sign path + the §4.8 watchdog /
// submission workers may emit). This file adds the TypeBox `payloadSchema` + declared consumers the
// dispatcher validates each publish against (§2.4 catalog).
//
// The four events with locked downstream subscribers (§2.4 reconciliation table) are
// `m10.hope.timepoint_signed` (M33), `m10.hope.j2051_trigger_fired` (M33), `m10.hope.submission_accepted`
// (M30, M33), `m10.hope.submission_rejected` (M33). The rest gain consumers as M14/M22/M28/M30/M36 wire
// their subscriptions; M10 publishes them now. Per §2.4 idempotent dispatch keyed on
// `hope_assessment_id` + `event_kind` (or `schedule_id` / `sfv_id` / `submission_id` per the §2.4 table).
import { Type } from "@sinclair/typebox";

const isoInstant = Type.String({ minLength: 1 });
const rfaKind = Type.Union([
  Type.Literal("01_admission"),
  Type.Literal("02_huv1"),
  Type.Literal("03_huv2"),
  Type.Literal("04_sfv"),
  Type.Literal("05_discharge"),
]);
const j2051Severity = Type.Union([
  Type.Literal("none"),
  Type.Literal("mild"),
  Type.Literal("moderate"),
  Type.Literal("severe"),
]);

export const M10_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── timepoint lifecycle (§2.4) ────────────────────────────────────────────────────────────────────
  {
    eventName: "m10.hope.timepoint_scheduled",
    moduleOwner: "m10",
    description:
      "`schedule-hope-timepoints` created a HOPE timepoint schedule row on M6 `admission.activated`; M14 surfaces open windows.",
    payloadSchema: Type.Object({
      scheduleId: Type.String({ minLength: 1 }),
      rfaKind,
      windowOpensAt: isoInstant,
      windowClosesAt: isoInstant,
      lateDeadlineAt: isoInstant,
    }),
    // F-129 (#248) — m14 dropped: "M14 surfaces open windows" describes the OUTCOME, not the mechanism —
    // `packages/idg/src/packet/builder.ts`'s `HopeContextInput` (the packet's `hopeContext` block) is a
    // build-time pull through `HopeTimepointProvider` ("for upcoming RFAs/SFV chain" per M14's own §1.1
    // dependency line), not a push cache keyed on individual schedule events.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m10.hope.timepoint_signed",
    moduleOwner: "m10",
    description:
      "`recordHopeTimepoint` transitioned a draft assessment to signed; the snapshot + J2051 verdict are final. M33/M30 read it.",
    payloadSchema: Type.Object({
      assessmentId: Type.String({ minLength: 1 }),
      rfaKind,
      signedAt: isoInstant,
      signedBy: Type.String({ minLength: 1 }),
      j2051TriggerFired: Type.Boolean(),
      wasLate: Type.Boolean(),
    }),
    // F-115 (#248) — m28/m30 removed: m28 never subscribes to anything (F-035); m30 reads HOPE data via
    // the live M10 `QualityHopeConsumer` rollup seam (`j2051FollowUpRollup`/`sfvTimelinessRollup`/
    // `submissionPostureRollup`) on its nightly cadence, not by reacting to individual HOPE events — same
    // for every `m10.hope.*` entry below that names it.
    // F-129 (#248) — m14 dropped too: the description names M33/M30 as readers, not M14, and (like
    // `timepoint_scheduled` above) `hopeContext` is a build-time `HopeTimepointProvider` pull.
    declaredConsumers: [],
    seamConsumers: ["m30", "m33"],
    // ALSO live: server → patient room `hope:assessment:signed` (§4.5).
    isOutboxOnly: false,
  },
  {
    eventName: "m10.hope.timepoint_expired",
    moduleOwner: "m10",
    description:
      "`hope-window-watchdog` cron flipped an open schedule past `late_deadline_at` to expired (HQRP miss). M30 counts it.",
    payloadSchema: Type.Object({
      scheduleId: Type.String({ minLength: 1 }),
      rfaKind,
      expiredAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  // ── J2051 trigger + SFV chain (§2.4 / §4.9) ─────────────────────────────────────────────────────────
  {
    eventName: "m10.hope.j2051_trigger_fired",
    moduleOwner: "m10",
    description:
      "Section J's J2051 server-authoritative evaluator returned `triggerFired=true` at sign; an SFV obligation was created in the same transaction. M30 measures Timely Follow-Up.",
    payloadSchema: Type.Object({
      assessmentId: Type.String({ minLength: 1 }),
      sfvId: Type.String({ minLength: 1 }),
      maxSeverity: j2051Severity,
      triggeredAt: isoInstant,
      dueAt: isoInstant,
    }),
    declaredConsumers: ["m14"],
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m10.hope.sfv_created",
    moduleOwner: "m10",
    description:
      "A symptom_follow_up_visit row was inserted in the same transaction as `j2051_trigger_fired`; M36 dispatches the SFV obligation alert.",
    payloadSchema: Type.Object({
      sfvId: Type.String({ minLength: 1 }),
      triggeringAssessmentId: Type.String({ minLength: 1 }),
      dueAt: isoInstant,
    }),
    declaredConsumers: ["m14"],
    seamConsumers: ["m36"],
    // ALSO live: server → org room `hope:sfv:created` (§4.5).
    isOutboxOnly: false,
  },
  {
    eventName: "m10.hope.sfv_completed",
    moduleOwner: "m10",
    description:
      "An RFA-04 SFV completion matched an open SFV row; `completing_assessment_id` is set. M30 reads completion timeliness.",
    payloadSchema: Type.Object({
      sfvId: Type.String({ minLength: 1 }),
      completingAssessmentId: Type.String({ minLength: 1 }),
      completedAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m10.hope.sfv_overdue",
    moduleOwner: "m10",
    description:
      "`sfv-watchdog` cron flipped an open SFV past `due_at` to overdue; M36 escalates the alert.",
    payloadSchema: Type.Object({
      sfvId: Type.String({ minLength: 1 }),
      hoursPastDue: Type.Number(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m30", "m36"],
    isOutboxOnly: false,
  },
  {
    eventName: "m10.hope.sfv_missed",
    moduleOwner: "m10",
    description:
      "`sfv-watchdog` flipped an overdue SFV past 7 days to missed (terminal); M30's Timely Follow-Up measure counts the miss.",
    payloadSchema: Type.Object({
      sfvId: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  // ── correction-of-record (§2.4 / D7) ────────────────────────────────────────────────────────────────
  {
    eventName: "m10.hope.correction_submitted",
    moduleOwner: "m10",
    description:
      "A correction RFA was signed referencing a signed original (now superseded); `submit-correction-rfa` queues the iQIES Correction-RFA.",
    payloadSchema: Type.Object({
      correctionAssessmentId: Type.String({ minLength: 1 }),
      originalAssessmentId: Type.String({ minLength: 1 }),
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── iQIES submission lifecycle (§2.4 / §4.10) ───────────────────────────────────────────────────────
  {
    eventName: "m10.hope.submission_queued",
    moduleOwner: "m10",
    description:
      "`assemble-hope-submission` batched signed+unsubmitted assessments per ProviderEntity into a submission row.",
    payloadSchema: Type.Object({
      submissionId: Type.String({ minLength: 1 }),
      providerEntityId: Type.String({ minLength: 1 }),
      itemCount: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m10.hope.submission_transmitted",
    moduleOwner: "m10",
    description:
      "`iqies-submit-worker` POSTed a submission batch to iQIES; the signed envelope SHA-256 is recorded.",
    payloadSchema: Type.Object({
      submissionId: Type.String({ minLength: 1 }),
      transmittedAt: isoInstant,
      envelopeSha256: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: false,
  },
  {
    eventName: "m10.hope.submission_accepted",
    moduleOwner: "m10",
    description:
      "`iqies-reconcile-worker` recorded iQIES acceptance for a submission; M30 reads the acceptance rate for APU posture.",
    payloadSchema: Type.Object({
      submissionId: Type.String({ minLength: 1 }),
      // F-150 (#248) — added: the real live-bound M30 consumer (`buildM30HopeSubmissionAcceptedConsumer`)
      // needs the provider entity to enqueue the hope_derived recompute against; `hope_submission
      // .provider_entity_id` is NOT NULL and the emit site already has the updated row in hand.
      providerEntityId: Type.String({ minLength: 1 }),
      acceptedCount: Type.Integer({ minimum: 0 }),
      rejectedCount: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: ["m30"],
    seamConsumers: ["m33"],
    isOutboxOnly: false,
  },
  {
    eventName: "m10.hope.submission_rejected",
    moduleOwner: "m10",
    description:
      "`iqies-reconcile-worker` recorded iQIES rejection findings for a submission; M36 alerts compliance, M33 reports.",
    payloadSchema: Type.Object({
      submissionId: Type.String({ minLength: 1 }),
      rejectedCount: Type.Integer({ minimum: 0 }),
      findings: Type.Array(
        Type.Object({ ruleId: Type.String({ minLength: 1 }), count: Type.Integer({ minimum: 1 }) }),
      ),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: false,
  },
  // ── printable summary (§2.4 — M22 renders when it lands) ──────────────────────────────────────────────
  {
    eventName: "m10.hope.summary_requested",
    moduleOwner: "m10",
    description:
      "API `POST /hope/assessments/:id/summary-pdf` asked for the printable HOPE summary; M22 renders.",
    payloadSchema: Type.Object({
      assessmentId: Type.String({ minLength: 1 }),
      requestedBy: Type.String({ minLength: 1 }),
      /** The chart target M22 files the rendered summary against (F-099). */
      patientId: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m10.hope.retention_eligible",
    moduleOwner: "m10",
    description:
      "The monthly `hope-retention-scan` found a patient's HOPE record past its retention horizon (10y from the last iQIES transmission, else 7y from the last effective date) with no blocker; it is FLAGGED for M4 certified destruction. Emitted once per eligibility episode — the scan never deletes.",
    payloadSchema: Type.Object({
      patientId: Type.String({ minLength: 1 }),
      basis: Type.Union([Type.Literal("submitted_cms_10y"), Type.Literal("standard_7y")]),
      retentionYears: Type.Number({ minimum: 7 }),
      eligibleAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m4"],
    isOutboxOnly: true,
  },
];
