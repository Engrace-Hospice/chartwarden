// apps/backend/src/modules/14-idg/events-by-m14.ts — Module 14's outbox-event contributions
// (M14-T06, spec §4.4). The full `m14.*` taxonomy keyed on M14's own tables, under the `m14.` namespace
// (M01 D8 outbox_event_catalog / M03 D9 / M04 D9), plus the ONE cross-namespace canonical seam event
// `idg.decision_recorded` — the M7/M11/M12/M16-future consumer contract whose name PREDATES the `m14.`
// namespace and stays the locked seam identifier (§4.4; M7 D4). That single legacy name is ratified in
// `check-fitness-gaps.ts`'s SYSTEM_EVENT_ALLOWLIST (the deliberate, ADR-referenced exception the gate's
// `mN.<resource>.<verb>` scan otherwise rejects); every other event here keeps the canonical prefix.
// check-fitness-gaps.ts scans this file for naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m14'),
// and valid declared consumers (real module ids).
//
// The canonical wire `eventName`s mirror `M14_EVENT_NAMES` in @wardenx/types (the closed §4.4 set the
// schedule worker / meeting lifecycle / packet builder / decision + action-item write paths / minutes
// finalize + amendment / the per-patient review-clock cron may emit). Each entry adds the TypeBox
// `payloadSchema` + declared consumers the dispatcher validates each publish against, so "DB updated but the
// event never went out" is closed in the same transaction as the mutation (M1 §25.5/§25.6).
//
// M14 publishes every catalogued event without calling consumer routes. `idg.decision_recorded` is the
// command seam for M7/M11/M12/M16 only. M22 rendering uses the dedicated packet/minutes events, while
// M28/M30/M33 read M14's published provider seams; listing those readers here would invent outbox work.
import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import type { ModuleEventContribution, ModuleToken } from "@wardenx/types";
import { IDG_DECISION_PAYLOAD_SCHEMA } from "./decision-payload-schema";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const nullableId = Type.Union([id, Type.Null()]);

// The §4.4 wire names mirror `M14_EVENT_NAMES` (@wardenx/types) EXACTLY. The locked cross-namespace
// `idg.decision_recorded` does NOT match the stricter `OutboxEventName` template (`m${number}.…`), so
// `eventName` is relaxed to `string` here (every other field stays fully type-checked) and the array is cast
// once to `ModuleEventContribution` — the M13 events-by-m13.ts precedent.
interface M14OutboxEntry {
  readonly eventName: string;
  readonly moduleOwner: ModuleToken;
  readonly description: string;
  readonly payloadSchema: TSchema;
  readonly declaredConsumers: readonly ModuleToken[];
  readonly seamConsumers?: readonly ModuleToken[];
  readonly isOutboxOnly: boolean;
}

const M14_OUTBOX_ENTRIES: readonly M14OutboxEntry[] = [
  // ── schedule materialisation + meeting scheduling (§2.2 / §4.4) ─────────────────────────────────────────
  {
    eventName: "m14.schedule.materialised",
    moduleOwner: "m14",
    description: "The recurring-policy schedule worker materialised the next window of meetings.",
    payloadSchema: Type.Object({
      recurringPolicyId: id,
      meetingsCreated: Type.Integer({ minimum: 0 }),
      windowEndIso: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m14.meeting.scheduled",
    moduleOwner: "m14",
    description: "A meeting was scheduled (route create or schedule worker) at a location/time.",
    payloadSchema: Type.Object({
      meetingId: id,
      locationId: id,
      scheduledStart: isoInstant,
      scheduledEnd: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── packet build pipeline (§2.4 / §4.4) ─────────────────────────────────────────────────────────────────
  {
    eventName: "m14.packets.build_started",
    moduleOwner: "m14",
    description:
      "The `BUILD_PACKETS` transition began building per-patient packets for the meeting.",
    payloadSchema: Type.Object({
      meetingId: id,
      includedPatientCount: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m14.packets.build_failed_for_patient",
    moduleOwner: "m14",
    description:
      "The packet builder caught a per-patient build failure; M36 warns, the build may retry.",
    payloadSchema: Type.Object({
      meetingId: id,
      patientId: id,
      reason: Type.String(),
      willRetry: Type.Boolean(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m14.packets.ready",
    moduleOwner: "m14",
    description:
      "The `PACKETS_READY` transition finished the build; M36 fans out the T-24h reminder.",
    payloadSchema: Type.Object({
      meetingId: id,
      builtPacketCount: Type.Integer({ minimum: 0 }),
      scheduledAttendees: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m14.packet.render_requested",
    moduleOwner: "m14",
    description:
      "Mirror of `packets.ready` per patient — asks M22 to render the packet PDF (§7.2 W2 handshake).",
    payloadSchema: Type.Object({
      meetingId: id,
      patientId: id,
      packetId: id,
      renderPayload: Type.Unknown(),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  // ── meeting lifecycle + attendance (§2.2 / §4.4) ────────────────────────────────────────────────────────
  {
    eventName: "m14.meeting.started",
    moduleOwner: "m14",
    description: "The `START` transition opened the live meeting.",
    payloadSchema: Type.Object({ meetingId: id, startedByMembershipId: id, startedAt: isoInstant }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m14.attendance.checked_in",
    moduleOwner: "m14",
    description:
      "An attendee checked in to the meeting (tardiness flagged for the quorum snapshot).",
    payloadSchema: Type.Object({
      meetingId: id,
      attendanceId: id,
      membershipId: id,
      discipline: id,
      checkedInAt: isoInstant,
      isTardy: Type.Boolean(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── decisions + action items (§2.6 / §2.7 / §4.4) ───────────────────────────────────────────────────────
  {
    eventName: "m14.decision.recorded_open",
    moduleOwner: "m14",
    description:
      "A decision was recorded during the live meeting (pre-adjournment); the canonical `idg.decision_recorded` fans out at ADJOURN.",
    payloadSchema: Type.Object({
      decisionId: id,
      meetingId: id,
      patientId: id,
      decisionKind: id,
      wasQuorate: Type.Boolean(),
      recordedByMembershipId: id,
      recordedAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m14.action_item.created",
    moduleOwner: "m14",
    description: "`POST /action-items` created an action item; M36 DMs the assignee.",
    payloadSchema: Type.Object({
      actionItemId: id,
      meetingId: id,
      decisionId: nullableId,
      patientId: nullableId,
      assignedToMembershipId: id,
      dueDate: isoInstant,
      linkedArtifactKind: nullableId,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m14.action_item.status_changed",
    moduleOwner: "m14",
    description:
      "`PATCH /action-items/:id` changed an action-item status; M36 notifies on completion.",
    payloadSchema: Type.Object({
      actionItemId: id,
      fromStatus: id,
      toStatus: id,
      actorMembershipId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m14.action_item.auto_closed",
    moduleOwner: "m14",
    description:
      "A §4.5 consumer (M7/M8/M11/M12 absorbing-state event) auto-closed a linked action item (D8).",
    payloadSchema: Type.Object({
      actionItemId: id,
      linkedArtifactKind: id,
      linkedArtifactId: id,
      closeTrigger: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m14.action_item.carry_forward",
    moduleOwner: "m14",
    description:
      "The T-24h cron of the next meeting carried an open action item forward; ≥3 carries is a compliance alert.",
    payloadSchema: Type.Object({
      priorActionItemId: id,
      newAgendaItemId: id,
      carryForwardCount: Type.Integer({ minimum: 1 }),
      isComplianceAlert: Type.Boolean(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  // ── the canonical cross-module decision seam (§4.4; locked legacy name, M7 D4) ───────────────────────────
  {
    eventName: "idg.decision_recorded",
    moduleOwner: "m14",
    description:
      "ADJOURNMENT-time emitter (one per actionable decision) — the canonical M7/M11/M12/M16-future consumer contract carrying the schema-versioned `IdgDecisionRecordedPayload`.",
    payloadSchema: Type.Object({
      decisionId: id,
      meetingId: id,
      patientId: id,
      organizationId: id,
      decisionKind: id,
      payload: IDG_DECISION_PAYLOAD_SCHEMA,
      payloadSchemaVersion: Type.Literal("2026-01-v1"),
      recordedByMembershipId: id,
      recordedAt: isoInstant,
      meetingAdjournedAt: isoInstant,
      wasQuorate: Type.Boolean(),
      quorumSnapshot: Type.Unknown(),
    }),
    declaredConsumers: ["m7", "m11", "m12", "m16"],
    isOutboxOnly: true,
  },
  // ── adjournment + cancel/reschedule (§2.2 / §4.4) ───────────────────────────────────────────────────────
  {
    eventName: "m14.meeting.adjourned",
    moduleOwner: "m14",
    description:
      "The `ADJOURN` transition closed the meeting (the decision/action-item commit burst already fired).",
    payloadSchema: Type.Object({
      meetingId: id,
      adjournedByMembershipId: id,
      adjournedAt: isoInstant,
      decisionsEmittedCount: Type.Integer({ minimum: 0 }),
      actionItemsAssignedCount: Type.Integer({ minimum: 0 }),
      attendanceSnapshot: Type.Unknown(),
    }),
    declaredConsumers: ["m22", "m28", "m30"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m14.meeting.cancelled",
    moduleOwner: "m14",
    description: "The `CANCEL` transition cancelled a scheduled meeting; M36 warns the attendees.",
    payloadSchema: Type.Object({
      meetingId: id,
      cancelledBy: id,
      cancellationReason: Type.String(),
      cancelledAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m14.meeting.rescheduled",
    moduleOwner: "m14",
    description:
      "The `RESCHEDULE` transition moved a meeting (new meeting row); M36 notifies attendees.",
    payloadSchema: Type.Object({
      priorMeetingId: id,
      newMeetingId: id,
      newScheduledStart: isoInstant,
      reason: Type.String(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  // ── M14-F01 / ADR-0018 D2 — per-patient 15-day review-clock floor (§4.4) ────────────────────────────────
  {
    eventName: "m14.review_floor.override_recorded",
    moduleOwner: "m14",
    description:
      "A CANCEL/RESCHEDULE breached the per-patient review floor under audited override (M14-F01); M36 warns Compliance, M30 logs cadence adherence.",
    payloadSchema: Type.Object({
      meetingId: id,
      actorMembershipId: id,
      reason: Type.String(),
      breachingPatients: Type.Array(Type.Object({ patientId: id, floorAt: isoInstant })),
      overriddenAt: isoInstant,
    }),
    declaredConsumers: ["m30"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m14.review_clock.escalated",
    moduleOwner: "m14",
    description:
      "The `idg.review-clock-sweep` cron escalated a patient's 15-day review clock (T-3 / T-0 / T+1, M14-F01).",
    payloadSchema: Type.Object({
      admissionId: id,
      patientId: id,
      locationId: id,
      lastIdgReviewedAt: nullableId,
      floorAt: isoInstant,
      stage: Type.Union([
        Type.Literal("t_minus_3"),
        Type.Literal("t_zero"),
        Type.Literal("t_plus_1"),
      ]),
      severity: Type.Union([Type.Literal("clinical_routine"), Type.Literal("critical")]),
    }),
    declaredConsumers: ["m30"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  // ── minutes finalize + amendment + packet freeze (§2.2 / §4.4) ──────────────────────────────────────────
  {
    eventName: "m14.minutes.signed",
    moduleOwner: "m14",
    description:
      "Adjournment-time mirror of `meeting.adjourned` — asks M22 to render the minutes PDF.",
    payloadSchema: Type.Object({
      minutesId: id,
      meetingId: id,
      finalizedByMembershipId: id,
      renderPayload: Type.Unknown(),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m14.minutes.amended",
    moduleOwner: "m14",
    description:
      "`POST /amendments` approved a minutes amendment; M22 re-renders, M28 re-projects.",
    payloadSchema: Type.Object({
      amendmentId: id,
      minutesId: id,
      requestedByMembershipId: id,
      approvedByMembershipId: id,
      amendmentReasonHash: id,
    }),
    declaredConsumers: ["m22", "m28"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m14.packet.frozen",
    moduleOwner: "m14",
    description: "The `ADJOURN` transition froze each patient packet against rebuild (W-PKT-02).",
    payloadSchema: Type.Object({
      meetingId: id,
      patientId: id,
      packetId: id,
      frozenAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
];

/** Module 14's §4.4 outbox-event catalog contribution (the boot UPSERTs each into `outbox_event_catalog`). */
export const M14_OUTBOX_EVENTS: ModuleEventContribution =
  M14_OUTBOX_ENTRIES as unknown as ModuleEventContribution;
