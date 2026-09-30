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
    description:
      "Packets for an upcoming IDG meeting are built — the T-24h reminder to scheduled attendees.",
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
    severity: "CRITICAL", // the carry-forward count CROSSING 3 (D8 / §2.7) — once per action item
    defaultChannels: ["inbox", "socket_push", "email"],
    defaultRecipientResolver: "idg_compliance_inbox",
    payloadSchema: Type.Object({
      organizationId: orgId,
      priorActionItemId: id,
      carryForwardCount: Type.Integer({ minimum: 3 }),
      severity: Type.Literal("critical"),
      // The audience is RESOLVED by M36 (role_set: compliance_officer + clinical_supervisor + org_admin, plus the
      // target meeting's coordinator via `coordinatorUserId`); the membership ids here are informational and
      // optional — the supervisor is a role audience, not a single membership.
      recipients: Type.Object({
        complianceInbox: Type.Literal(true),
        idgCoordinatorMembershipId: Type.Optional(id),
        clinicalSupervisorMembershipId: Type.Optional(id),
      }),
      bodyTemplate: Type.String(),
    }),
    requiresResponseTracking: true,
    description:
      "An action item carried forward ≥3 meetings — the compliance escalation to coordinator + supervisor.",
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
    description:
      "A decision was recorded without quorum — the low-severity notice to the IDG coordinator.",
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
      stage: Type.Union([
        Type.Literal("t_minus_3"),
        Type.Literal("t_zero"),
        Type.Literal("t_plus_1"),
      ]),
      severity: Type.Union([Type.Literal("clinical_routine"), Type.Literal("critical")]),
      // `idgCoordinatorMembershipId` is OPTIONAL: the location may have no scheduled meeting and no active recurring
      // policy to name a coordinator (the supervisor / compliance tiers are role audiences and must still fire).
      recipients: Type.Object({
        idgCoordinatorMembershipId: Type.Optional(id),
        clinicalSupervisorMembershipId: Type.Optional(id),
        complianceInbox: Type.Optional(Type.Boolean()),
      }),
      bodyTemplate: Type.String(),
    }),
    requiresResponseTracking: true,
    description:
      "A patient's 15-day review clock is escalating (T-3/T-0/T+1, M14-F01) — the per-patient cadence alert.",
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
      // OPTIONAL and deliberately OMITTED by M36's consumer: the override reason is free text (PHI risk) and lives in
      // the audit_event / outbox event; the alert carries ids + the breaching floor dates only.
      reason: Type.Optional(Type.String()),
      breachingPatients: Type.Array(Type.Object({ patientId: id, floorAt: isoInstant })),
      severity: Type.Literal("attention"),
      // The supervisor is a ROLE audience (role_set), not a single membership — optional, informational.
      recipients: Type.Object({
        complianceInbox: Type.Literal(true),
        clinicalSupervisorMembershipId: Type.Optional(id),
      }),
      bodyTemplate: Type.String(),
    }),
    requiresResponseTracking: true,
    description:
      "A CANCEL/RESCHEDULE breached the per-patient review floor under override (M14-F01) — the compliance audit alert.",
  },
];
