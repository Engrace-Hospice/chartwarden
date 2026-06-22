// apps/backend/src/modules/14-idg/alerts-by-m14.ts — Module 14's M36 alert-payload contribution
// (M14-T06, spec §4.10). The six typed alert payloads M14 OWNS under the `m14.` prefix, registered onto
// M36's Foundation alert-payload registry at M14 boot (NO import edge into M36 — M36 is foundation-tier and
// never imports M14; the registry is the mutable seam). Notification COMPOSITION + recipient resolution moved
// to M36 per ADR-0024 (§4.11 superseded): M14 emits these deterministic, PHI-free payloads (IDs + structural
// facts + a `bodyTemplate`); M36 resolves recipient PHI per permission scope and never re-templates. The
// payload TYPES mirror the `M14AlertPayload` discriminated union in @wardenx/types. The platform-floor
// severity/cadence may be TIGHTENED by a tenant, never loosened — `m14.action_item.created` and
// `m14.review_clock.escalated` carry their own in-payload escalation that the D11 override tightens against.
// check-fitness-gaps.ts enforces the same `mN.<resource>.<verb>` ownership the outbox catalog uses.
import { Type } from "@sinclair/typebox";
import type { ModuleAlertContribution } from "@wardenx/types";

const orgId = Type.String({ minLength: 1 });
const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });

export const M14_ALERT_PAYLOADS: ModuleAlertContribution = [
  {
    payloadType: "m14.packets.ready",
    moduleOwner: "m14",
    severity: "INFO", // T-24h reminder fanout to scheduled attendees
    defaultChannels: ["inbox", "socket_push"],
    defaultRecipientResolver: "idg_meeting_attendees",
    payloadSchema: Type.Object({
      organizationId: orgId,
      meetingId: id,
      scheduledStart: isoInstant,
      packetCount: Type.Integer({ minimum: 0 }),
      recipients: Type.Object({ attendeesByMembershipId: Type.Array(id) }),
      bodyTemplate: Type.String(),
    }),
    requiresResponseTracking: false,
    description: "Packets for an upcoming IDG meeting are built — the T-24h reminder to scheduled attendees.",
  },
  {
    payloadType: "m14.action_item.created",
    moduleOwner: "m14",
    severity: "INFO", // floor; the in-payload `severity: attention` tightens the routing
    defaultChannels: ["inbox"],
    defaultRecipientResolver: "idg_action_item_assignee",
    payloadSchema: Type.Object({
      organizationId: orgId,
      actionItemId: id,
      patientId: Type.Union([id, Type.Null()]),
      assignedToMembershipId: id,
      dueDate: isoInstant,
      severity: Type.Union([Type.Literal("info"), Type.Literal("attention")]),
      bodyTemplate: Type.String(),
    }),
    requiresResponseTracking: false,
    description: "An IDG action item was assigned — the DM to the assignee with its due date.",
  },
  {
    payloadType: "m14.action_item.carry_forward.compliance",
    moduleOwner: "m14",
    severity: "CRITICAL", // carry-forward count >= 3 (D8 / §2.7)
    defaultChannels: ["inbox", "socket_push", "email"],
    defaultRecipientResolver: "idg_compliance_inbox",
    payloadSchema: Type.Object({
      organizationId: orgId,
      priorActionItemId: id,
      carryForwardCount: Type.Integer({ minimum: 3 }),
      severity: Type.Literal("critical"),
      recipients: Type.Object({
        complianceInbox: Type.Literal(true),
        idgCoordinatorMembershipId: id,
        clinicalSupervisorMembershipId: id,
      }),
      bodyTemplate: Type.String(),
    }),
    requiresResponseTracking: true,
    description: "An action item carried forward ≥3 meetings — the compliance escalation to coordinator + supervisor.",
  },
  {
    payloadType: "m14.decision.non_quorate",
    moduleOwner: "m14",
    severity: "INFO", // low-severity notice when a decision was recorded without quorum
    defaultChannels: ["inbox"],
    defaultRecipientResolver: "idg_meeting_coordinator",
    payloadSchema: Type.Object({
      organizationId: orgId,
      meetingId: id,
      decisionId: id,
      missingDisciplines: Type.Array(Type.String()),
      severity: Type.Literal("low"),
      bodyTemplate: Type.String(),
    }),
    requiresResponseTracking: false,
    description: "A decision was recorded without quorum — the low-severity notice to the IDG coordinator.",
  },
  {
    payloadType: "m14.review_clock.escalated",
    moduleOwner: "m14",
    severity: "HIGH", // clinical_routine floor at T-3; the T-0/T+1 cron tightens to CRITICAL
    defaultChannels: ["inbox", "email"],
    defaultRecipientResolver: "idg_meeting_coordinator",
    payloadSchema: Type.Object({
      organizationId: orgId,
      admissionId: id,
      patientId: id,
      locationId: id,
      lastIdgReviewedAt: Type.Union([isoInstant, Type.Null()]),
      floorAt: isoInstant,
      stage: Type.Union([Type.Literal("t_minus_3"), Type.Literal("t_zero"), Type.Literal("t_plus_1")]),
      severity: Type.Union([Type.Literal("clinical_routine"), Type.Literal("critical")]),
      recipients: Type.Object({
        idgCoordinatorMembershipId: id,
        clinicalSupervisorMembershipId: Type.Optional(id),
        complianceInbox: Type.Optional(Type.Boolean()),
      }),
      bodyTemplate: Type.String(),
    }),
    requiresResponseTracking: true,
    description: "A patient's 15-day review clock is escalating (T-3/T-0/T+1, M14-F01) — the per-patient cadence alert.",
  },
  {
    payloadType: "m14.review_floor.override_recorded",
    moduleOwner: "m14",
    severity: "MEDIUM", // an audited CANCEL/RESCHEDULE override of the review-floor guard
    defaultChannels: ["inbox", "email"],
    defaultRecipientResolver: "idg_compliance_inbox",
    payloadSchema: Type.Object({
      organizationId: orgId,
      meetingId: id,
      actorMembershipId: id,
      reason: Type.String(),
      breachingPatients: Type.Array(Type.Object({ patientId: id, floorAt: isoInstant })),
      severity: Type.Literal("attention"),
      recipients: Type.Object({ complianceInbox: Type.Literal(true), clinicalSupervisorMembershipId: id }),
      bodyTemplate: Type.String(),
    }),
    requiresResponseTracking: true,
    description: "A CANCEL/RESCHEDULE breached the per-patient review floor under override (M14-F01) — the compliance audit alert.",
  },
];
