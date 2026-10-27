import type { AlertEmitter, AlertSeverity } from "@chartwarden/messaging";
import type { AlertPayloadEntry } from "@chartwarden/types";
// apps/backend/src/modules/36-messaging/outbox-consumers/idg-alerts.ts — M36's consumers of M14's remaining typed
// alerts (M14 §4.10, catalog in 14-idg/alerts-by-m14.ts). Sibling of `idg-carry-forward-compliance.ts` (the precedent:
// same design, same guarantees) — five alert families that share one shape, so one file with a table:
//
//   event (M14 outbox)                   -> typed alert                          audience (platform `alert_rule`)
//   m14.packets.ready                    -> m14.packets.ready                    expected attendees of the meeting
//   m14.action_item.created              -> m14.action_item.created              the assignee
//   m14.decision.recorded_open (!quorate)-> m14.decision.non_quorate             the meeting's coordinator
//   m14.review_clock.escalated           -> m14.review_clock.escalated           coordinator; +supervisor T-0; +compliance T+1
//   m14.review_floor.override_recorded   -> m14.review_floor.override_recorded   compliance + clinical supervisor
//
// RECIPIENTS (ADR-0024: resolution is M36's). The catalog names resolvers that are NOT values of the closed
// `alert_recipient_resolver` enum (`idg_meeting_attendees`, `idg_action_item_assignee`, `idg_meeting_coordinator`,
// `idg_compliance_inbox`). No migration: each is realised as the platform `alert_rule` for the alert type (seed in
// packages/messaging/src/seed/alert-rules.ts) — a `role_set` over role keys plus `userIdPaths` (payload keys holding
// ACTIVE org members' USER ids, resolved HERE, in the relay, org-explicitly under `withOrgContext`) and, for the
// review-clock tiers, `roleKeysPath` (the tier's extra role keys, chosen here from the stage).
//
// CATALOG VALIDATION + FAILURE. M36 never imports M14: the composition root hands each consumer the registered
// `AlertPayloadEntry` map. The payload is checked against the entry's TypeBox schema BEFORE emit; an unregistered type,
// a malformed event or a failing payload THROWS (relay retry -> DLQ — a visible failure, never a silently dropped
// alert). A legitimately empty audience (no expected attendees, a departed assignee) is NOT a failure: nothing to send.
//
// IDEMPOTENCY. Every alert has a deterministic correlation id; `alert` is UNIQUE on (organization_id, correlation_id),
// so a relay redelivery, a second tick or a re-emit can never page twice:
//   packets.ready       m14.packets.ready:<meetingId>                     one per MEETING (never per packet)
//   action_item.created m14.action_item.created:<actionItemId>
//   non_quorate         m14.decision.non_quorate:<decisionId>
//   review_clock        m14.review_clock:<patientId>:<stage>:<floorAt>    per (patient, tier, clock cycle): a new review
//                                                                          moves `floorAt`, which starts a new cycle
//   override            m14.review_floor.override_recorded:<meetingId>    cancel/reschedule are terminal: once per meeting
//
// NO PHI: ids, counts, dates and constant body text only (no names, no action-item title, no override reason — free
// text lives in the audit record). A `deepLink` is added only where an id-based web route exists
// (`/idg/meetings/:id`); otherwise the id-less list routes.
//
// RELAY, NOT A REQUEST: `handle` runs in the outbox relay and opens no tenant reads itself — `alerts.emit` and each
// lookup wrap their own `withOrgContext` with the event's org id.
import { Value } from "@sinclair/typebox/value";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export interface IdgAlertDeps {
  readonly alerts: AlertEmitter;
  /** The registered alert-payload catalog (payloadType -> entry), built by the composition root. */
  readonly catalog: ReadonlyMap<string, AlertPayloadEntry>;
  /** Resolve a membership id to its ACTIVE user id in the org, or null (departed / unknown). */
  readonly membershipUserId: (
    organizationId: string,
    membershipId: string,
  ) => Promise<string | null>;
  /** The expected attendees (membership + user ids) of an IDG meeting at a location (derived roster). */
  readonly meetingAttendees: (
    organizationId: string,
    locationId: string,
  ) => Promise<readonly { membershipId: string; userId: string }[]>;
}

interface AlertPlan {
  readonly severity: AlertSeverity;
  readonly correlationId: string;
  readonly payload: Record<string, unknown>;
}

interface IdgAlertFamily {
  readonly consumerName: string;
  readonly eventName: string;
  readonly payloadType: string;
  /** Build the alert from the event, or return null when there is nothing to raise (not applicable / empty audience). */
  plan(
    event: DispatchableOutboxEvent,
    p: Record<string, unknown>,
    deps: IdgAlertDeps,
    fail: (msg: string) => never,
  ): Promise<AlertPlan | null>;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ── constant, PHI-free copy (M36 composes the final text from the catalog payload; it never re-templates) ──────
export const IDG_PACKETS_READY_BODY =
  "Patient packets for an upcoming IDG meeting are built and ready to review.";
export const IDG_ACTION_ITEM_ASSIGNED_BODY =
  "An IDG action item has been assigned to you. Review it on your IDG action-item list.";
export const IDG_NON_QUORATE_BODY =
  "A decision was recorded at an IDG meeting without the required quorum. Review the meeting.";
export const IDG_REVIEW_FLOOR_OVERRIDE_BODY =
  "An IDG meeting was cancelled or rescheduled under an audited override of the per-patient 15-day review floor.";
export const IDG_REVIEW_CLOCK_BODY = {
  t_minus_3:
    "A patient's 15-day IDG review is due in 3 days and no covering meeting has completed. Schedule or confirm a covering IDG review.",
  t_zero:
    "A patient's 15-day IDG review is due today and no covering meeting has completed. Escalated to the clinical supervisor.",
  t_plus_1:
    "A patient's 15-day IDG review floor has been breached. Escalated to the clinical supervisor and the compliance inbox.",
} as const;

/** The review-clock audience tiers (M14 §4.9 / §7.14): T-3 coordinator only; T-0 + clinical supervisor; T+1 + the
 *  compliance inbox (`compliance_officer`, with the `org_admin` backstop `idg_compliance_inbox` uses elsewhere). */
export const IDG_REVIEW_CLOCK_AUDIENCE_ROLES = {
  t_minus_3: [],
  t_zero: ["clinical_supervisor"],
  t_plus_1: ["clinical_supervisor", "compliance_officer", "org_admin"],
} as const;

export const idgPacketsReadyCorrelationId = (meetingId: string): string =>
  `m14.packets.ready:${meetingId}`;
export const idgActionItemCreatedCorrelationId = (actionItemId: string): string =>
  `m14.action_item.created:${actionItemId}`;
export const idgNonQuorateCorrelationId = (decisionId: string): string =>
  `m14.decision.non_quorate:${decisionId}`;
export const idgReviewClockCorrelationId = (
  patientId: string,
  stage: string,
  floorAt: string,
): string => `m14.review_clock:${patientId}:${stage}:${floorAt}`;
export const idgReviewFloorOverrideCorrelationId = (meetingId: string): string =>
  `m14.review_floor.override_recorded:${meetingId}`;

const STAGES = ["t_minus_3", "t_zero", "t_plus_1"] as const;
type Stage = (typeof STAGES)[number];

const FAMILIES: readonly IdgAlertFamily[] = [
  {
    consumerName: "m36.idg-packets-ready-alert",
    eventName: "m14.packets.ready",
    payloadType: "m14.packets.ready",
    async plan(event, p, deps, fail) {
      const meetingId = str(p.meetingId) ?? fail("payload has no meetingId");
      const locationId = str(p.locationId) ?? fail("payload has no locationId");
      const scheduledStart = str(p.scheduledStart) ?? fail("payload has no scheduledStart");
      const packetCount = p.builtPacketCount;
      if (typeof packetCount !== "number" || !Number.isInteger(packetCount) || packetCount < 0) {
        fail(`builtPacketCount '${String(packetCount)}' is not a non-negative integer`);
      }
      // The expected roster = members who attend IDG at this location, plus the meeting's coordinator.
      const roster = new Map<string, string>(); // membershipId -> userId
      for (const a of await deps.meetingAttendees(event.organizationId, locationId)) {
        roster.set(a.membershipId, a.userId);
      }
      const coordinatorMembershipId = str(p.coordinatorMembershipId);
      if (coordinatorMembershipId !== null && !roster.has(coordinatorMembershipId)) {
        const uid = await deps.membershipUserId(event.organizationId, coordinatorMembershipId);
        if (uid !== null) roster.set(coordinatorMembershipId, uid);
      }
      if (roster.size === 0) return null; // nobody to remind (no attendee holds the IDG keys at this location)
      return {
        severity: "info",
        correlationId: idgPacketsReadyCorrelationId(meetingId),
        payload: {
          organizationId: event.organizationId,
          meetingId,
          scheduledStart,
          packetCount,
          recipients: { attendeesByMembershipId: [...roster.keys()] },
          bodyTemplate: IDG_PACKETS_READY_BODY,
          deepLink: `/idg/meetings/${meetingId}`,
          // Consumed by the platform rule's `role_set.userIdPaths` (ids only).
          attendeeUserIds: [...new Set(roster.values())],
        },
      };
    },
  },
  {
    consumerName: "m36.idg-action-item-assigned-alert",
    eventName: "m14.action_item.created",
    payloadType: "m14.action_item.created",
    async plan(event, p, deps, fail) {
      const actionItemId = str(p.actionItemId) ?? fail("payload has no actionItemId");
      const assignedToMembershipId =
        str(p.assignedToMembershipId) ?? fail("payload has no assignedToMembershipId");
      const dueDate = str(p.dueDate) ?? fail("payload has no dueDate");
      const assigneeUserId = await deps.membershipUserId(
        event.organizationId,
        assignedToMembershipId,
      );
      if (assigneeUserId === null) return null; // the assignee is no longer an active member
      return {
        severity: "info",
        correlationId: idgActionItemCreatedCorrelationId(actionItemId),
        payload: {
          organizationId: event.organizationId,
          actionItemId,
          patientId: str(p.patientId),
          assignedToMembershipId,
          dueDate,
          // The catalog's in-payload `attention` tightening has no source signal on the event; it stays `info`.
          severity: "info",
          bodyTemplate: IDG_ACTION_ITEM_ASSIGNED_BODY,
          deepLink: "/idg/action-items",
          assigneeUserId,
        },
      };
    },
  },
  {
    consumerName: "m36.idg-non-quorate-alert",
    eventName: "m14.decision.recorded_open",
    payloadType: "m14.decision.non_quorate",
    async plan(event, p, deps, fail) {
      // Every quorate decision lands here too — only the non-quorate one raises a notice.
      if (p.wasQuorate !== false) return null;
      const decisionId = str(p.decisionId) ?? fail("payload has no decisionId");
      const meetingId = str(p.meetingId) ?? fail("payload has no meetingId");
      const coordinatorMembershipId = str(p.coordinatorMembershipId);
      const coordinatorUserId =
        coordinatorMembershipId === null
          ? null
          : await deps.membershipUserId(event.organizationId, coordinatorMembershipId);
      if (coordinatorUserId === null) return null; // M14 §4.10: the notice is to the coordinator, and none is resolvable
      const missing = Array.isArray(p.missingDisciplines)
        ? p.missingDisciplines.filter((d): d is string => typeof d === "string")
        : [];
      return {
        severity: "info",
        correlationId: idgNonQuorateCorrelationId(decisionId),
        payload: {
          organizationId: event.organizationId,
          meetingId,
          decisionId,
          missingDisciplines: missing,
          severity: "low",
          bodyTemplate: IDG_NON_QUORATE_BODY,
          deepLink: `/idg/meetings/${meetingId}`,
          coordinatorUserId,
        },
      };
    },
  },
  {
    consumerName: "m36.idg-review-clock-alert",
    eventName: "m14.review_clock.escalated",
    payloadType: "m14.review_clock.escalated",
    async plan(event, p, deps, fail) {
      const stage = p.stage;
      if (!STAGES.includes(stage as Stage)) fail(`unknown stage '${String(stage)}'`);
      const s = stage as Stage;
      const patientId = str(p.patientId) ?? fail("payload has no patientId");
      const floorAt = str(p.floorAt) ?? fail("payload has no floorAt");
      const severity = p.severity;
      if (severity !== "clinical_routine" && severity !== "critical") {
        fail(`unknown severity '${String(severity)}'`);
      }
      const coordinatorMembershipId = str(p.coordinatorMembershipId);
      const coordinatorUserId =
        coordinatorMembershipId === null
          ? null
          : await deps.membershipUserId(event.organizationId, coordinatorMembershipId);
      return {
        severity: severity === "critical" ? "critical" : "warn",
        correlationId: idgReviewClockCorrelationId(patientId, s, floorAt),
        payload: {
          organizationId: event.organizationId,
          admissionId: str(p.admissionId),
          patientId,
          locationId: str(p.locationId),
          lastIdgReviewedAt: str(p.lastIdgReviewedAt),
          floorAt,
          stage: s,
          severity,
          recipients: {
            ...(coordinatorMembershipId === null
              ? {}
              : { idgCoordinatorMembershipId: coordinatorMembershipId }),
            ...(s === "t_plus_1" ? { complianceInbox: true } : {}),
          },
          bodyTemplate: IDG_REVIEW_CLOCK_BODY[s],
          deepLink: "/idg/schedule",
          // The platform rule's tier audience: `role_set.roleKeysPath` + `userIdPaths` (ids / role keys only).
          audienceRoleKeys: [...IDG_REVIEW_CLOCK_AUDIENCE_ROLES[s]],
          ...(coordinatorUserId === null ? {} : { coordinatorUserId }),
        },
      };
    },
  },
  {
    consumerName: "m36.idg-review-floor-override-alert",
    eventName: "m14.review_floor.override_recorded",
    payloadType: "m14.review_floor.override_recorded",
    async plan(event, p, _deps, fail) {
      const meetingId = str(p.meetingId) ?? fail("payload has no meetingId");
      const actorMembershipId =
        str(p.actorMembershipId) ?? fail("payload has no actorMembershipId");
      return {
        severity: "warn",
        correlationId: idgReviewFloorOverrideCorrelationId(meetingId),
        payload: {
          organizationId: event.organizationId,
          meetingId,
          actorMembershipId,
          // `reason` is free text (PHI risk): deliberately NOT carried onto the alert (catalog: optional).
          breachingPatients: p.breachingPatients,
          severity: "attention",
          recipients: { complianceInbox: true },
          bodyTemplate: IDG_REVIEW_FLOOR_OVERRIDE_BODY,
          deepLink: `/idg/meetings/${meetingId}`,
        },
      };
    },
  },
];

export const IDG_ALERT_CONSUMERS = FAMILIES.map((f) => ({
  consumerName: f.consumerName,
  eventName: f.eventName,
  payloadType: f.payloadType,
}));

function buildFamilyConsumer(family: IdgAlertFamily, deps: IdgAlertDeps): OutboxConsumerBinding {
  const name = family.consumerName;
  const fail = (msg: string): never => {
    throw new Error(`${name}: ${msg}`);
  };
  return {
    consumerName: name,
    consumerModule: "m36",
    eventTypes: [family.eventName],
    async handle(event) {
      const p = (event.payload ?? {}) as Record<string, unknown>;
      const entry = deps.catalog.get(family.payloadType);
      if (entry === undefined) fail(`'${family.payloadType}' is not in the alert payload catalog`);
      const planned = await family.plan(event, p, deps, fail);
      if (planned === null) return;
      const schema = (entry as AlertPayloadEntry).payloadSchema;
      if (!Value.Check(schema, planned.payload)) {
        const paths = [...Value.Errors(schema, planned.payload)].map((e) => e.path).join(", ");
        fail(`payload fails the '${family.payloadType}' catalog schema at: ${paths}`);
      }
      // Throws on an emitter failure => the relay retries; the correlation id dedupes a redelivery after success.
      await deps.alerts.emit(event.organizationId, {
        eventType: family.payloadType,
        severity: planned.severity,
        correlationId: planned.correlationId,
        payload: planned.payload,
      });
    },
  };
}

/** The five M36 consumers of M14's remaining typed alerts (one binding per alert family). */
export function buildIdgAlertConsumers(deps: IdgAlertDeps): OutboxConsumerBinding[] {
  return FAMILIES.map((f) => buildFamilyConsumer(f, deps));
}
