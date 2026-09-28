// apps/backend/src/modules/09-assessments/events-by-m9.ts — Module 9's outbox-event contributions
// (M9-T06, spec §2.4 / §4.8). The full `m9.*` taxonomy keyed on M9's own tables, under the `m9.`
// namespace (M01 D8 outbox_event_catalog / M03 D9 / M04 D9). check-fitness-gaps.ts scans this file for
// naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m9'), and valid declared consumers (real
// module ids). The named cross-module consumers (M7/M11/M14/M22/M28/M30/M33/M36) subscribe when they
// land / are wired; M9 publishes the events now.
//
// The event NAMES mirror `M9_EVENT_NAMES` in @wardenx/types (the closed set the record path + the §4.8
// escalation/license workers may emit); this file adds the TypeBox `payloadSchema` + declared consumers
// the dispatcher validates each publish against (§2.4 catalog). `m9.assessment.significant_change` is
// the threshold-crossing trigger M36 fans out to the care-team channel + clinical-supervisor inbox
// (§4.9) — its payload feeds the typed alert `buildSignificantChangeAlert` produces.
//
// Per §2.4 "all emitted through Module 1's outbox helper; idempotent dispatch keyed on
// `(assessment_id, event_kind)`". Every M9 event is outbox-only EXCEPT the two §4.4 live-channel events
// (`m9.assessment.recorded`, `m9.assessment.significant_change`) which M36/Socket.IO also pushes to the
// patient room for the live chart refresh / alert banner (§4.4 table).
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

/** A scale-type token (mirrors `scale_type`, §3.2) — kept as a constrained string so the catalog stays
 * decoupled from the per-scale discriminated union (§4.3 lives in @wardenx/assessments). */
const scaleType = Type.String({ minLength: 1 });
/** The §2.4 significant-change rule id (mirrors `significant_change_rule_id`, §3.2). */
const ruleId = Type.String({ minLength: 1 });
/** §4.9 alert severity at emission (mirrors `AssessmentAlertSeverity`). */
const severity = Type.Union([
  Type.Literal("clinical_urgent"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);

export const M9_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── assessment record / amendment (§2.4) ────────────────────────────────────────────────────────────
  {
    eventName: "m9.assessment.recorded",
    moduleOwner: "m9",
    description:
      "Every successful scale insert (incl. corrections); M7 latest-cache invalidate + IDG/FHIR/HQRP inputs.",
    payloadSchema: Type.Object({
      assessmentId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      scaleType,
      score: Type.Union([Type.Number(), Type.Null()]),
      capturedAt: Type.String({ minLength: 1 }),
      sourceEncounterId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
      isCorrection: Type.Boolean(),
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035). m30 stays declared — unlike its
    // M6/M7/M8 siblings this fact has no current M30 seam (no assessment reader exists in
    // apps/backend/src/modules/30-quality/), so this remains a genuine gap, not a seam-pull.
    // F-142 (#248) — m7 dropped: M7's own spec (§"Clinical assessments") is decisive — M7 reads M9's
    // latest scores via the registered `LatestAssessmentProvider` seam at packet-assembly time, never a
    // push cache to invalidate.
    declaredConsumers: ["m14", "m30"],
    seamConsumers: ["m33"],
    // ALSO live: server → patient room live chart refresh (§4.4).
    isOutboxOnly: false,
  },
  {
    eventName: "m9.assessment.amended",
    moduleOwner: "m9",
    description:
      "A row flipped active → superseded because a correction was created (companion to the new row's recorded).",
    payloadSchema: Type.Object({
      supersededId: Type.String({ minLength: 1 }),
      correctingId: Type.String({ minLength: 1 }),
      scaleType,
      reason: Type.String({ minLength: 1 }),
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    // F-145 (#248) — m14 REMOVED: redundant sibling — `.amended` is emitted in the SAME transaction as
    // `insertScale`'s correcting row, which itself emits `m9.assessment.recorded` — M14's real,
    // live-bound subscription (`m14.m9-assessment-recorded`). The corrected value arrives via
    // `.recorded` regardless; `.amended` only marks the prior row superseded, a fact with no
    // corresponding packet field.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── significant-change chain (§2.4 / §4.9) ────────────────────────────────────────────────────────────
  {
    eventName: "m9.assessment.significant_change",
    moduleOwner: "m9",
    description:
      "A threshold-crossing rule fired within the recording transaction; M36 delivers the typed §4.9 alert.",
    payloadSchema: Type.Object({
      eventId: Type.String({ minLength: 1 }),
      assessmentId: Type.String({ minLength: 1 }),
      priorAssessmentId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
      ruleId,
      scaleType,
      deltaValue: Type.Union([Type.Number(), Type.Null()]),
      thresholdValue: Type.Union([Type.Number(), Type.Null()]),
      severity,
    }),
    // F-142 (#248) — m7 dropped: same `LatestAssessmentProvider` seam-pull reasoning as
    // `assessment.recorded` above — nothing in M7's spec distinguishes significant-change handling
    // from the general latest-score read.
    declaredConsumers: ["m11", "m14"],
    seamConsumers: ["m36"],
    // ALSO live: server → patient room + care-team channel live alert banner (§4.4).
    isOutboxOnly: false,
  },
  {
    eventName: "m9.assessment.significant_change_acknowledged",
    moduleOwner: "m9",
    description: "A clinician acked an open/escalated change; M36 closes the alert.",
    payloadSchema: Type.Object({
      eventId: Type.String({ minLength: 1 }),
      ackBy: Type.String({ minLength: 1 }),
      ackAt: Type.String({ minLength: 1 }),
      note: Type.Optional(Type.String()),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m9.assessment.significant_change_escalated",
    moduleOwner: "m9",
    description:
      "The §4.8 hourly change-escalation cron flipped a CRITICAL open change to escalated after 24h no-ack; M36 re-delivers at severity=high.",
    payloadSchema: Type.Object({
      eventId: Type.String({ minLength: 1 }),
      originalDetectedAt: Type.String({ minLength: 1 }),
      escalatedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── printable summary (§2.4 — M22 renders when it lands) ──────────────────────────────────────────────
  {
    eventName: "m9.assessment.summary_requested",
    moduleOwner: "m9",
    description:
      "M22 / portal asked for the printable assessment summary; M9 emits the domain payload.",
    payloadSchema: Type.Object({
      patientId: Type.String({ minLength: 1 }),
      asOfDate: Type.String({ minLength: 1 }),
      scales: Type.Array(scaleType),
      lang: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  // ── license-status worker (§2.2.3 / §4.8 daily scan) ──────────────────────────────────────────────────
  {
    eventName: "m9.scale.license_pending_renewal",
    moduleOwner: "m9",
    description:
      "Daily license-status scan: a proprietary-scale license entered the 30-day renewal window.",
    payloadSchema: Type.Object({
      scaleType,
      expiresAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m9.scale.license_lapsed",
    moduleOwner: "m9",
    description:
      "Daily license-status scan: a proprietary-scale license expired; form-gating now blocks recording.",
    payloadSchema: Type.Object({
      scaleType,
      expiredAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m9.scale.policy_changed",
    moduleOwner: "m9",
    description:
      "A tenant updated scale_policy (enable/disable or tightened thresholds); reporting reconciles.",
    payloadSchema: Type.Object({
      scaleType,
      changedFields: Type.Array(Type.String({ minLength: 1 })),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
];
