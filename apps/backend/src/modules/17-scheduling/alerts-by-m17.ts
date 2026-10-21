// apps/backend/src/modules/17-scheduling/alerts-by-m17.ts — Module 17's M36 alert-payload contribution
// (M17-T08, spec §4.9). The typed alert payloads M17 OWNS under the `m17.` prefix, registered onto M36's
// Foundation alert-payload registry at M17 boot (NO import edge into M36 — M36 is foundation-tier and never
// imports M17; the registry is the mutable seam). Notification COMPOSITION + recipient resolution is M36's
// (ADR-0024): M17 emits these deterministic, PHI-free payloads (IDs + structural facts), and M36 resolves
// recipient PHI per permission scope and never re-templates. The payload TYPES mirror the
// `SchedulingAlertPayload` discriminated union in @chartwarden/types (§4.9). The platform-floor severity/cadence
// may be TIGHTENED by a tenant, never loosened (D11). check-fitness-gaps.ts enforces the same
// `mN.<resource>.<verb>` ownership the outbox catalog uses (here only the `m17.` prefix is required).
import { Type } from "@sinclair/typebox";
import type { ModuleAlertContribution } from "@chartwarden/types";

const orgId = Type.String({ minLength: 1 });
const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const isoDate = Type.String({ minLength: 1 });

export const M17_ALERT_PAYLOADS: ModuleAlertContribution = [
  {
    payloadType: "m17.visit.assigned",
    moduleOwner: "m17",
    severity: "INFO",
    defaultChannels: ["inbox", "socket_push"],
    defaultRecipientResolver: "scheduling_assigned_clinician",
    payloadSchema: Type.Object({
      organizationId: orgId,
      visitId: id,
      clinicianMembershipId: id,
      patientId: id,
      scheduledStartedAt: isoInstant,
    }),
    requiresResponseTracking: false,
    description: "A visit was assigned to a clinician — the day-view-ready notice to the assignee.",
  },
  {
    payloadType: "m17.visit.rescheduled",
    moduleOwner: "m17",
    severity: "INFO",
    defaultChannels: ["inbox", "socket_push"],
    defaultRecipientResolver: "scheduling_assigned_clinician",
    payloadSchema: Type.Object({
      organizationId: orgId,
      visitId: id,
      oldStartedAt: isoInstant,
      newStartedAt: isoInstant,
    }),
    requiresResponseTracking: false,
    description: "A visit moved to a new time — the reschedule notice to the affected clinician.",
  },
  {
    payloadType: "m17.visit.cancelled",
    moduleOwner: "m17",
    severity: "INFO",
    defaultChannels: ["inbox"],
    defaultRecipientResolver: "scheduling_assigned_clinician",
    payloadSchema: Type.Object({
      organizationId: orgId,
      visitId: id,
      reason: Type.String(),
      reasonCode: id,
    }),
    requiresResponseTracking: false,
    description: "A visit was cancelled — the cancellation notice to the affected clinician.",
  },
  {
    payloadType: "m17.visit.no_show",
    moduleOwner: "m17",
    severity: "WARN",
    defaultChannels: ["inbox", "socket_push"],
    defaultRecipientResolver: "scheduling_clinical_supervisor",
    payloadSchema: Type.Object({
      organizationId: orgId,
      visitId: id,
      patientId: id,
      clinicianMembershipId: id,
    }),
    requiresResponseTracking: false,
    description:
      "A visit was marked no-show — the supervisor warning (M19 on-call triage in Phase 2).",
  },
  {
    payloadType: "m17.reassignment_needed",
    moduleOwner: "m17",
    severity: "WARN",
    defaultChannels: ["inbox", "socket_push"],
    defaultRecipientResolver: "scheduling_scheduler_inbox",
    payloadSchema: Type.Object({
      organizationId: orgId,
      visitId: id,
      reason: Type.Union([
        Type.Literal("pto_approved"),
        Type.Literal("clinician_credential_expired"),
        Type.Literal("volunteer_gate_expired"),
      ]),
      affectedClinicianMembershipId: id,
    }),
    requiresResponseTracking: true,
    description:
      "A published visit's clinician became ineligible — the scheduler warning to reassign.",
  },
  {
    payloadType: "m17.time_off.requested",
    moduleOwner: "m17",
    severity: "INFO",
    defaultChannels: ["inbox"],
    defaultRecipientResolver: "scheduling_time_off_approver",
    payloadSchema: Type.Object({
      organizationId: orgId,
      timeOffId: id,
      requestingMembershipId: id,
      conflictingVisitCount: Type.Integer({ minimum: 0 }),
    }),
    requiresResponseTracking: true,
    description: "A PTO request was filed — the approval-queue notice with the conflict count.",
  },
  {
    payloadType: "m17.time_off.approved",
    moduleOwner: "m17",
    severity: "INFO",
    defaultChannels: ["inbox"],
    defaultRecipientResolver: "scheduling_time_off_requester",
    payloadSchema: Type.Object({
      organizationId: orgId,
      timeOffId: id,
      reassignmentTaskCount: Type.Integer({ minimum: 0 }),
    }),
    requiresResponseTracking: false,
    description:
      "A PTO request was approved — the confirmation to the requester with the reassignment count.",
  },
  {
    payloadType: "m17.time_off.denied",
    moduleOwner: "m17",
    severity: "WARN",
    defaultChannels: ["inbox"],
    defaultRecipientResolver: "scheduling_time_off_requester",
    payloadSchema: Type.Object({
      organizationId: orgId,
      timeOffId: id,
      reason: Type.String(),
    }),
    requiresResponseTracking: false,
    description: "A PTO request was denied — the notice to the requester with the reason.",
  },
  {
    payloadType: "m17.route_optimized",
    moduleOwner: "m17",
    severity: "INFO",
    defaultChannels: ["inbox"],
    defaultRecipientResolver: "scheduling_assigned_clinician",
    payloadSchema: Type.Object({
      organizationId: orgId,
      membershipId: id,
      serviceDate: isoDate,
      totalProposedMiles: Type.Number(),
      totalProposedDriveMinutes: Type.Number(),
    }),
    requiresResponseTracking: false,
    description:
      "A day route was optimised — the optimisation-completed notice (route_optimization ON only).",
  },
  {
    payloadType: "m17.route_unoptimized",
    moduleOwner: "m17",
    severity: "WARN",
    defaultChannels: ["inbox"],
    defaultRecipientResolver: "scheduling_scheduler_inbox",
    payloadSchema: Type.Object({
      organizationId: orgId,
      membershipId: id,
      serviceDate: isoDate,
      reason: Type.Union([Type.Literal("osrm_unavailable"), Type.Literal("no_visits")]),
    }),
    requiresResponseTracking: false,
    description:
      "Day-route optimisation fell back to the degraded path — the §7.9 unoptimised notice.",
  },
  {
    payloadType: "m17.stale_visit_detected",
    moduleOwner: "m17",
    severity: "WARN",
    defaultChannels: ["inbox", "socket_push"],
    defaultRecipientResolver: "scheduling_clinical_supervisor",
    payloadSchema: Type.Object({
      organizationId: orgId,
      visitId: id,
      hoursStuck: Type.Number(),
    }),
    requiresResponseTracking: false,
    description: "A visit is stuck in_visit > 48h — the operator warning to resolve the bracket.",
  },
  {
    payloadType: "m17.caregiver_visit_reminder",
    moduleOwner: "m17",
    severity: "INFO",
    defaultChannels: ["sms", "email"],
    defaultRecipientResolver: "scheduling_caregiver_contact",
    payloadSchema: Type.Object({
      organizationId: orgId,
      visitId: id,
      patientId: id,
      scheduledStartedAt: isoInstant,
      channel: Type.Union([Type.Literal("sms"), Type.Literal("email")]),
    }),
    requiresResponseTracking: false,
    description:
      "An opted-in visit is ~24h out — the caregiver reminder (rendered by M22, delivered by M36).",
  },
];
