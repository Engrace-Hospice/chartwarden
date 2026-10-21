// apps/backend/src/modules/18-evv/events-by-m18.ts — Module 18's outbox-event contributions (M18-T07,
// spec §4.10). The full `m18.evv.*` taxonomy keyed on M18's own `evv_event` / `evv_missing_resolution` /
// `evv_device` / `evv_geofence_policy` / `evv_aggregator_submission` lifecycle, under the `m18.` namespace
// (M01 D8 outbox_event_catalog / M03 D9 / M04 D9). check-fitness-gaps.ts scans this file for naming
// (`mN.<resource>.<verb>` — every name here is the canonical three-segment form), ownership (moduleOwner='m18'),
// and declared consumers (real module ids).
//
// The canonical wire `eventName`s mirror `M18_EVENT_NAMES` in @chartwarden/types (the closed §4.10 set the capture
// pipeline / correction-of-record / late-check sweep / device lifecycle / geofence-policy editor / the §2.2.5 D7
// aggregator submission machine may emit). Each entry adds the TypeBox `payloadSchema` + declared consumers the
// dispatcher validates each publish against, so "DB updated but the event never went out" is closed in the same
// transaction as the mutation (M1 §25.5/§25.6). Idempotency: every emit is keyed on `(eventId, outboxTopic,
// recordedAt)` via the M1 outbox helper (§4.10).
//
// Phase-1 boundary (§0): M18 PUBLISHES the full set now — the producer side ships; the consumer attaches when
// that module locks. **`m18.evv.check_in_recorded` / `m18.evv.check_out_recorded` wire LIVE M8's
// `encounter.period` EVV-bracket forward seam (M8 D9) AND drive M17's visit-state transitions (D14)** — M17
// reads them to advance `published → en_route → in_visit → completed`. `m18.evv.at_patient_address` is the
// geofence-confirmation stream M17 reads; `m18.evv.late_check_resolved` flows to M17 / M8 / M23. The Phase-2
// consumers stay inert deny-stubs until those modules land: **M19** on-call triage (`late_check_out_detected`)
// and **M25** denial-management (`aggregator_rejected`) — M18 never calls their routes, it only emits the typed
// outbox event. Consumer dedup is keyed on `(eventId, consumerName)` per the M1 outbox-consumer pattern.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@chartwarden/types";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const nullableId = Type.Union([id, Type.Null()]);

/** Module 18's §4.10 outbox-event catalog contribution (the boot UPSERTs each into `outbox_event_catalog`). All
 *  names are the canonical `m18.evv.<verb>` form, so `OutboxEventEntry`'s template type checks directly (no cast).*/
export const M18_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── capture lifecycle (§2.2 / §4.10) ────────────────────────────────────────────────────────────────────
  {
    eventName: "m18.evv.check_in_recorded",
    moduleOwner: "m18",
    description:
      "An `evv_event` kind=check_in was recorded — CLOSES M8's encounter.period EVV-bracket forward seam (M8 D9) and drives M17's `published → en_route → in_visit` visit transition (D14).",
    payloadSchema: Type.Object({
      eventId: id,
      visitId: id,
      patientId: id,
      postingMembershipId: id,
      capturedAt: isoInstant,
      recordedAt: isoInstant,
      gpsQuality: id,
      geofenceDecision: id,
    }),
    // F-043/#103 — M20 re-anchors the mid-visit cadence to the ARRIVAL (§7.1); it was subscribed in
    // `M20_SUBSCRIBED_EVENT_NAMES` and declared nowhere.
    // F-140 (#248) — m8 removed: M8's own spec (its architecture note, line 387) states outright that
    // outbox publication is the only cross-module communication M8 performs "at the boundary" — every
    // upstream fact M8 reads, including the EVV bracket, is an in-process SEAM call
    // (`EvvBracketResolver`), never an outbox subscription. No M18 consumer file exists anywhere in M8.
    declaredConsumers: ["m17", "m18", "m20"],
    isOutboxOnly: true,
  },
  {
    eventName: "m18.evv.check_out_recorded",
    moduleOwner: "m18",
    description:
      "An `evv_event` kind=check_out was recorded (paired with its check-in by the worker) — closes the EVV bracket (M8 D9). F-158 (#248) corrected this description: it previously claimed the event 'drives M17's `in_visit → completed` transition' — false against the reconciled machine (`visit-machine.ts`'s `complete` case is guarded to the `m8.encounter.signed` consumer alone, per M17's own §2.2/§2.5/§7.1 spec text). M17's real, live consumer stamps `visit.evv_check_out_event_id` as a provenance pointer only, no lifecycle transition.",
    payloadSchema: Type.Object({
      eventId: id,
      visitId: id,
      patientId: id,
      postingMembershipId: id,
      capturedAt: isoInstant,
      recordedAt: isoInstant,
      gpsQuality: id,
      geofenceDecision: id,
      pairedCheckInEventId: nullableId,
      serviceDurationMinutes: Type.Number(),
    }),
    // F-043/#103 — M20 opens the post-visit window from the check-out (§7.1), materializing it when the
    // visit predates the cadence materializer.
    // F-140 (#248) — m8 removed: same seam-pull reasoning as `check_in_recorded` above.
    declaredConsumers: ["m17", "m18", "m20"],
    isOutboxOnly: true,
  },
  {
    eventName: "m18.evv.visit_verified",
    moduleOwner: "m18",
    description:
      "A check-out paired with an in-geofence, non-superseded check-in completed the EVV bracket with no open `evv_missing_resolution` — the M30 Quality fully-EVV-verified signal.",
    payloadSchema: Type.Object({
      visitId: id,
      patientId: id,
      organizationId: id,
      verifiedAt: isoInstant,
    }),
    declaredConsumers: ["m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m18.evv.event_corrected",
    moduleOwner: "m18",
    description:
      "A correction-of-record superseded an `evv_event` (Clinical Supervisor+, step-up; §2.3) — M8/M17 re-read the bracket. `correctionReason` is denylisted in audit.",
    payloadSchema: Type.Object({
      supersededEventId: id,
      newEventId: id,
      visitId: id,
      correctedByMembershipId: id,
      correctionReason: Type.String(),
    }),
    // F-140 (#248) — m8 removed: same seam-pull reasoning as `check_in_recorded` above — M8's
    // `EvvBracketResolver` re-reads the bracket, it is never pushed to.
    declaredConsumers: ["m17"],
    isOutboxOnly: true,
  },
  {
    eventName: "m18.evv.geofence_breach_recorded",
    moduleOwner: "m18",
    description:
      "A capture event landed outside the applied geofence — the M36 supervisor warn alert + M20 field-safety awareness.",
    payloadSchema: Type.Object({
      eventId: id,
      visitId: id,
      computedDistanceM: Type.Number(),
      appliedRadiusM: Type.Integer(),
      kind: Type.Union([Type.Literal("check_in"), Type.Literal("check_out")]),
    }),
    // F-043/#103 — `m20` was declared here and NOWHERE in M20 answers it: the topic is absent from
    // `M20_SUBSCRIBED_EVENT_NAMES` and there is no handler, so the declaration deferred every emission
    // forever. The "M20 field-safety awareness" the description names is the M36 supervisor alert below,
    // which is a seam and not an outbox subscription — the same shape as `gps_spoof_suspected`, where
    // M18 owns the response and M20 renders a caveat (M18 §1.2 / M20 §7.7).
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m18.evv.at_patient_address",
    moduleOwner: "m18",
    description:
      "A check-in whose geofence evaluation passes — the at-patient-address confirmation stream M17 Scheduling reads.",
    payloadSchema: Type.Object({
      eventId: id,
      visitId: id,
      patientId: id,
      postingMembershipId: id,
      computedDistanceM: Type.Number(),
      appliedRadiusM: Type.Integer(),
      confirmedAt: isoInstant,
    }),
    declaredConsumers: ["m17"],
    isOutboxOnly: true,
  },
  {
    eventName: "m18.evv.gps_spoof_suspected",
    moduleOwner: "m18",
    description:
      "The gps-spoof-detector flagged an event `gps_quality='suspected_spoof'` (advisory, not blocking, D9) — the M36 supervisor/compliance warn alert.",
    payloadSchema: Type.Object({
      eventId: id,
      visitId: id,
      postingMembershipId: id,
      detectionSignals: Type.Array(Type.String()),
    }),
    declaredConsumers: ["m20"],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── missing-EVV resolution (§2.2.4 D6 / §4.10) ──────────────────────────────────────────────────────────
  {
    eventName: "m18.evv.late_check_out_detected",
    moduleOwner: "m18",
    description:
      "The late-check sweep opened an `evv_missing_resolution` (no checkout within scheduled_ended_at + grace) — M36 warns; M19 on-call triage attaches in Phase 2 (inert).",
    payloadSchema: Type.Object({
      visitId: id,
      missingResolutionId: id,
      hoursPastGrace: Type.Number(),
      hasCheckIn: Type.Boolean(),
    }),
    declaredConsumers: ["m19"],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m18.evv.late_check_resolved",
    moduleOwner: "m18",
    description:
      "An `evv_missing_resolution` closed (clinician-attest / supervisor-override / system) — flows to M17 / M8 / M23. `resolutionReason` is denylisted in audit.",
    payloadSchema: Type.Object({
      missingResolutionId: id,
      visitId: id,
      resolvedByMembershipId: nullableId,
      status: id,
      resolutionReason: Type.String(),
    }),
    // F-140 (#248) — m8 removed: same seam-pull reasoning as `check_in_recorded` above.
    declaredConsumers: ["m17", "m23"],
    isOutboxOnly: true,
  },
  // ── device lifecycle (§4.10) ────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m18.evv.device_pending_approval",
    moduleOwner: "m18",
    description:
      "A clinician self-registered a device (→ pending_approval) — the M36 supervisor approval prompt.",
    payloadSchema: Type.Object({
      deviceId: id,
      membershipId: id,
      platform: Type.Union([Type.Literal("ios"), Type.Literal("android")]),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m18.evv.device_approved",
    moduleOwner: "m18",
    description:
      "A pending device was approved — the device may now post EVV captures (M2 attestation context).",
    payloadSchema: Type.Object({
      deviceId: id,
      membershipId: id,
      approvedByMembershipId: id,
    }),
    // F-142 (#248) — m2 dropped: M18's own spec (§2.2.3) states the two rows are INDEPENDENT —
    // `evv_device.m2_device_attestation_id` is a logical FK M18 reads FROM M2 (a seam/FK pull at
    // check-in time), never a push M2 needs back. M2's own spec has zero mentions of `evv_device` or
    // this approval lifecycle.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m18.evv.device_suspended",
    moduleOwner: "m18",
    description:
      "A device was suspended — the M36 warn alert to the clinician + supervisor; the device cannot capture.",
    payloadSchema: Type.Object({
      deviceId: id,
      membershipId: id,
      reason: Type.String(),
    }),
    // F-142 (#248) — m2 dropped: same reasoning as `device_approved` above.
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m18.evv.geofence_policy_changed",
    moduleOwner: "m18",
    description:
      "The tenant default policy or a per-address override was edited (tighten-only) — the audit-warn compliance trail.",
    payloadSchema: Type.Object({
      scope: Type.Union([Type.Literal("tenant"), Type.Literal("per_address")]),
      patientAddressId: Type.Optional(nullableId),
      oldRadiusM: Type.Integer(),
      newRadiusM: Type.Integer(),
      oldMaxAccuracyM: Type.Integer(),
      newMaxAccuracyM: Type.Integer(),
      setByMembershipId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m4"],
    isOutboxOnly: true,
  },
  // ── per-state aggregator submission (§2.2.5 D7 / §7.8 / §7.9 / §4.10) ────────────────────────────────────
  {
    eventName: "m18.evv.aggregator_submitted",
    moduleOwner: "m18",
    description:
      "A submission reached `submitted` (the per-state worker posted to the aggregator) — operational visibility.",
    payloadSchema: Type.Object({
      submissionId: id,
      visitId: id,
      stateCode: id,
      aggregatorVendor: id,
      aggregatorTransactionId: nullableId,
    }),
    // F-140 (#248) — m24 removed: M24's own authoritative `M24_SUBSCRIPTION_MAP` names no M18
    // aggregator-state event at all — only `m18.evv.compliance_changed` (a vapor name, already filed
    // `no-such-event`) — and this event's own description is only "operational visibility".
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m18.evv.aggregator_accepted",
    moduleOwner: "m18",
    description:
      "A submission reached `accepted` — billing-substantiation complete; triggers the M22 verification-PDF render (D11) and M24 claim readiness.",
    payloadSchema: Type.Object({
      submissionId: id,
      visitId: id,
      stateCode: id,
      aggregatorTransactionId: nullableId,
      acceptedAt: isoInstant,
    }),
    // F-140 (#248) — m24 removed: M24's own D9 decision explicitly rejects "M24 owns its own EVV gate
    // without consuming M18's seam" as a boundary violation — the real mechanism is
    // `EvvComplianceReader.bracketStateForVisit`, a SEAM PULL at claim assembly, never a push. Not in
    // `M24_SUBSCRIPTION_MAP`.
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m18.evv.aggregator_rejected",
    moduleOwner: "m18",
    description:
      "A submission was rejected — the M36 billing-ops warn alert; M25 denial-management attaches in Phase 2 (inert). `rejectionReason` is denylisted in audit.",
    payloadSchema: Type.Object({
      submissionId: id,
      visitId: id,
      stateCode: id,
      rejectionCode: id,
      rejectionReason: Type.String(),
    }),
    declaredConsumers: ["m25"],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m18.evv.aggregator_timeout",
    moduleOwner: "m18",
    description:
      "A submission timed out awaiting the aggregator — the M36 critical alert to billing-ops + platform-ops.",
    payloadSchema: Type.Object({
      submissionId: id,
      visitId: id,
      stateCode: id,
      attemptCount: Type.Integer(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m18.evv.aggregator_cancelled",
    moduleOwner: "m18",
    description:
      "An operator cancelled a non-terminal submission — operational visibility. `reason` is denylisted in audit.",
    payloadSchema: Type.Object({
      submissionId: id,
      visitId: id,
      stateCode: id,
      cancelledByMembershipId: id,
      reason: Type.String(),
    }),
    // F-140 (#248) — m24 removed: same reasoning as `aggregator_submitted` above — operational
    // visibility only, and not in `M24_SUBSCRIPTION_MAP`.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m18.evv.verification_pdf_requested",
    moduleOwner: "m18",
    description:
      "The M22 PDF-render trigger for a state that requires a paper-trail confirmation artifact (D11) — M18 emits the typed payload, M22 renders (M18 has no PDF code).",
    payloadSchema: Type.Object({
      visitId: id,
      checkInEventId: id,
      checkOutEventId: id,
      requestedByMembershipId: id,
      format: id,
    }),
    // F-166 (#248) — m22 removed: this event's own description duplicates `aggregator_accepted`'s
    // ("triggers the M22 verification-PDF render (D11)") for the SAME D11 artifact, and checked against
    // the real code rather than either description — this one is VAPOR. No file under `18-evv/` publishes
    // it (grepped every non-catalog/non-test source); `aggregator-submission.ts`'s pure decider is the
    // only real emit site and it only ever publishes `aggregator_accepted`. That event is now the live
    // M22 trigger (the F-100 "event NAME is the template" shape). Record-only.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
];
