// apps/backend/src/modules/14-idg/routes/idg-routes.ts — M14-T05 the §4.1 route inventory behind the REAL
// Authorization Contract (`requirePermission`/`requireAbac` from @wardenx/auth, M3) on the §4.6 keys M14
// registers into M3's catalog (M14_CONTRIBUTED_PERMISSIONS). Org binding is server-side (`request.context`,
// never the body). Handlers compose over the injected IdgRouteService (in-memory slice; Drizzle in prod under
// `withOrgContext` so RLS backstops).
//
// §4.7 wiring: per-meeting routes carry `requireAbac('idg_meeting_scope')` (target = the meeting `:id` /
// `:meetingId`); the decision-record route ALSO carries `requireAbac('quorate_decision')` (target = meeting
// `:id`); the cancel/reschedule routes ALSO carry `requireAbac('per_patient_review_floor_clear')` with a custom
// target lifting the body's `proposedTransition` + `newScheduledStart` (the audited override —
// `idg.override_review_floor` + step-up — is composed at the route). The location-scoped list routes
// (`GET /idg/schedule`, `GET /idg/action-items`) scope server-side (caller org/location/assignee) rather than
// through the meeting-specific predicate.
import { type AbacTarget, requireAbac, requirePermission } from "@wardenx/auth";
import type { IdgActionItemStatus, IdgAttendanceStatus } from "@wardenx/types";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ActionItemListQuerySchema,
  AddAgendaItemRequest,
  AdjournMeetingRequest,
  CancelMeetingRequest,
  CreateActionItemRequest,
  IdParamsSchema,
  MeetingPacketParamsSchema,
  PatientIdParamsSchema,
  RecordAttendanceRequest,
  RecordDecisionRequest,
  RecurringPolicyRequest,
  RescheduleMeetingRequest,
  ScheduleQuerySchema,
  SubmitAmendmentRequest,
  SupersedeDecisionRequest,
  UpdateActionItemRequest,
  UpdateAgendaItemRequest,
  UpdateAttendanceRequest,
  UpdateDecisionRequest,
  parse,
} from "./idg-typebox";
import type { IdgRouteService } from "./service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface IdgRouteDeps {
  service: IdgRouteService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  // `userId` here is the acting MEMBERSHIP id (see idg-route-service-db.ts's own header comment:
  // "the acting membership is the passed `userId`, stored on coordinator/recorded_by/etc.") — every
  // downstream write lands it in a `*_membership_id` column. This used to read `ctx.userId` (the
  // raw Better Auth user id, a different id space), FK-violating every write.
  const membershipId = ctx?.attributes.membershipId;
  if (!ctx?.organizationId || typeof membershipId !== "string") throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: membershipId };
}

// Static permission guards (§4.6).
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("idg.read");
const ATTEND = P("idg.attend");
const COORDINATE = P("idg.coordinate");
const DECIDE = P("idg.decide");
const ACT = P("idg.act");
const SCHEDULE = P("idg.schedule");
const AMEND = P("idg.amend_minutes");

// §4.7 ABAC guards. `idg_meeting_scope` defaults its target to the route params (`:id` / `:meetingId`).
const SCOPE = (action: string): PreHandler =>
  requireAbac(action, "idg_meeting_scope") as PreHandler;
const ABAC_QUORATE = requireAbac("idg.decide", "quorate_decision") as PreHandler;

// The cancel/reschedule target lifts the body's `proposedTransition` + `newScheduledStart` so
// `per_patient_review_floor_clear` resolves at authz time; the meeting `:id` comes from the params.
const reviewFloorTarget = (request: {
  readonly params?: unknown;
  readonly body?: unknown;
}): AbacTarget => {
  const params = (request.params ?? {}) as { id?: unknown };
  const body = (request.body ?? {}) as {
    proposedTransition?: unknown;
    newScheduledStart?: unknown;
  };
  const target: Record<string, unknown> = {};
  if (typeof params.id === "string") target.id = params.id;
  if (typeof body.proposedTransition === "string")
    target.proposedTransition = body.proposedTransition;
  if (typeof body.newScheduledStart === "string") target.newScheduledStart = body.newScheduledStart;
  return target;
};
const ABAC_REVIEW_FLOOR = requireAbac("idg.schedule", "per_patient_review_floor_clear", {
  getTarget: reviewFloorTarget,
}) as PreHandler;

/** The fresh step-up assertion the ADJOURN route requires (§2.2 D13). The header is set by the M2 step-up flow;
 * the in-mem slice treats its presence as the fresh-step-up signal (the pure machine raises STEP_UP_REQUIRED
 * when absent). */
const stepUpFreshOf = (request: FastifyRequest): boolean =>
  request.headers["x-step-up"] === "fresh";

export function registerIdgRoutes(app: FastifyInstance, deps: IdgRouteDeps): void {
  const { service } = deps;

  // 1 — list the meeting schedule for a location/range (location-scoped server-side).
  app.get(
    "/api/v1/idg/schedule",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "idg_meeting", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(ScheduleQuerySchema, request.query);
      return service.listSchedule(organizationId, { location: q.location, from: q.from, to: q.to });
    },
  );

  // 2 — create a recurring policy (tenant-admin scope).
  app.post("/api/v1/idg/recurring-policies", { preHandler: [SCHEDULE] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const b = parse(RecurringPolicyRequest, request.body);
    const res = await service.createRecurringPolicy(organizationId, userId, b);
    return reply.code(201).send(res);
  });

  // 3 — update a recurring policy.
  app.patch("/api/v1/idg/recurring-policies/:id", { preHandler: [SCHEDULE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    const b = parse(RecurringPolicyRequest, request.body);
    return service.updateRecurringPolicy(organizationId, userId, id, b);
  });

  // 4 — read one meeting.
  app.get(
    "/api/v1/idg/meetings/:id",
    {
      preHandler: [READ, SCOPE("idg.read")],
      config: { auditRead: { resourceKind: "idg_meeting", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.getMeeting(organizationId, id);
    },
  );

  // 5 — cancel a meeting (per_patient_review_floor_clear ABAC; override composed at the route).
  app.post(
    "/api/v1/idg/meetings/:id/cancel",
    { preHandler: [SCHEDULE, SCOPE("idg.schedule"), ABAC_REVIEW_FLOOR] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(CancelMeetingRequest, request.body);
      return service.cancelMeeting(organizationId, userId, id, b.reason);
    },
  );

  // 6 — reschedule a meeting (per_patient_review_floor_clear ABAC; override composed at the route).
  app.post(
    "/api/v1/idg/meetings/:id/reschedule",
    { preHandler: [SCHEDULE, SCOPE("idg.schedule"), ABAC_REVIEW_FLOOR] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(RescheduleMeetingRequest, request.body);
      return service.rescheduleMeeting(organizationId, userId, id, {
        reason: b.reason,
        newScheduledStart: b.newScheduledStart,
        newScheduledEnd: b.newScheduledEnd,
      });
    },
  );

  // 7 — trigger the packet build.
  app.post(
    "/api/v1/idg/meetings/:id/packets/build",
    { preHandler: [COORDINATE, SCOPE("idg.coordinate")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.buildPackets(organizationId, userId, id);
    },
  );

  // 8 — start the meeting (opens the decision/action-item write path).
  app.post(
    "/api/v1/idg/meetings/:id/start",
    { preHandler: [COORDINATE, SCOPE("idg.coordinate")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.startMeeting(organizationId, userId, id);
    },
  );

  // 9 — adjourn the meeting (commit point; fresh step-up required, D13).
  app.post(
    "/api/v1/idg/meetings/:id/adjourn",
    { preHandler: [COORDINATE, SCOPE("idg.coordinate")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      parse(AdjournMeetingRequest, request.body);
      return service.adjournMeeting(organizationId, userId, id, stepUpFreshOf(request));
    },
  );

  // 10 — self check-in attendance.
  app.post(
    "/api/v1/idg/meetings/:id/attendance",
    { preHandler: [ATTEND, SCOPE("idg.attend")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(RecordAttendanceRequest, request.body);
      const res = await service.recordAttendance(organizationId, userId, id, {
        membershipId: b.membershipId,
        discipline: b.discipline,
        status: b.status as IdgAttendanceStatus | undefined,
        checkedInAt: b.checkedInAt,
      });
      return reply.code(201).send(res);
    },
  );

  // 11 — coordinator amends an attendance row.
  app.patch("/api/v1/idg/attendance/:id", { preHandler: [COORDINATE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    const b = parse(UpdateAttendanceRequest, request.body);
    return service.updateAttendance(organizationId, userId, id, b.status as IdgAttendanceStatus);
  });

  // 12 — coordinator removes an erroneous attendance row (pre-start only; enforced in service).
  app.delete("/api/v1/idg/attendance/:id", { preHandler: [COORDINATE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    return service.removeAttendance(organizationId, userId, id);
  });

  // 13 — list a meeting's packets.
  app.get(
    "/api/v1/idg/meetings/:id/packets",
    {
      preHandler: [READ, SCOPE("idg.read")],
      config: { auditRead: { resourceKind: "idg_packet", resourceIdParam: "id", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.listPackets(organizationId, id);
    },
  );

  // 14 — read one patient's packet (SUD redaction applied in the read path, W-SUD-01).
  app.get(
    "/api/v1/idg/meetings/:meetingId/packets/:patientId",
    {
      preHandler: [READ, SCOPE("idg.read")],
      config: { auditRead: { resourceKind: "idg_packet", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { meetingId, patientId } = parse(MeetingPacketParamsSchema, request.params);
      return service.getPacket(organizationId, meetingId, patientId);
    },
  );

  // 14b — patient-scoped IDG review history (patient-chart "IDG History" tab). Gated by idg.read; no
  // per-meeting idg_meeting_scope ABAC (the target is a patient, not one meeting). Metadata only — no
  // packet/decision narrative — so there is no SUD payload to redact. A patient never on an agenda → empty.
  app.get(
    "/api/v1/patients/:patientId/idg-history",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "idg_history", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientIdParamsSchema, request.params);
      return service.getPatientIdgHistory(organizationId, patientId);
    },
  );

  // 15 — add an agenda item.
  app.post(
    "/api/v1/idg/meetings/:id/agenda",
    { preHandler: [COORDINATE, SCOPE("idg.coordinate")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(AddAgendaItemRequest, request.body);
      const res = await service.addAgendaItem(organizationId, userId, id, {
        kind: b.kind,
        patientId: b.patientId,
      });
      return reply.code(201).send(res);
    },
  );

  // 16 — update an agenda item.
  app.patch("/api/v1/idg/agenda/:id", { preHandler: [COORDINATE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    parse(UpdateAgendaItemRequest, request.body);
    return service.updateAgendaItem(organizationId, userId, id);
  });

  // 17 — delete an agenda item.
  app.delete("/api/v1/idg/agenda/:id", { preHandler: [COORDINATE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    return service.removeAgendaItem(organizationId, userId, id);
  });

  // 18 — record a decision (quorate_decision ABAC; target = meeting :id).
  app.post(
    "/api/v1/idg/meetings/:id/decisions",
    { preHandler: [DECIDE, SCOPE("idg.decide"), ABAC_QUORATE] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(RecordDecisionRequest, request.body);
      const res = await service.recordDecision(organizationId, userId, id, {
        patientId: b.patientId,
        agendaItemId: b.agendaItemId,
        decisionKind: b.payload.kind,
        payload: b.payload,
      });
      return reply.code(201).send(res);
    },
  );

  // 19 — update an open decision (open status only; enforced in service).
  app.patch("/api/v1/idg/decisions/:id", { preHandler: [DECIDE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    const b = parse(UpdateDecisionRequest, request.body);
    return service.updateDecision(organizationId, userId, id, b.payload);
  });

  // 20 — supersede a prior decision (a new row in a later meeting; §2.8).
  app.post(
    "/api/v1/idg/decisions/:id/supersede",
    { preHandler: [DECIDE] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      parse(SupersedeDecisionRequest, request.body);
      const res = await service.supersedeDecision(organizationId, userId, id);
      return reply.code(201).send(res);
    },
  );

  // 21 — create an action item.
  app.post(
    "/api/v1/idg/meetings/:id/action-items",
    { preHandler: [COORDINATE, SCOPE("idg.coordinate")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(CreateActionItemRequest, request.body);
      const res = await service.createActionItem(organizationId, userId, id, {
        decisionId: b.decisionId,
        patientId: b.patientId,
        assignedToMembershipId: b.assignedToMembershipId,
        dueDate: b.dueDate,
        linkedArtifactKind: b.linkedArtifactKind,
      });
      return reply.code(201).send(res);
    },
  );

  // 22 — update an action item (assignee self-service via idg.act, or coordinator).
  app.patch("/api/v1/idg/action-items/:id", { preHandler: [ACT] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    const b = parse(UpdateActionItemRequest, request.body);
    return service.updateActionItem(organizationId, userId, id, b.status);
  });

  // 23 — delete an action item (pre-adjourn only; enforced in service).
  app.delete("/api/v1/idg/action-items/:id", { preHandler: [COORDINATE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    return service.removeActionItem(organizationId, userId, id);
  });

  // 24 — list action items (assignee self-scoped; location-scoped server-side).
  app.get(
    "/api/v1/idg/action-items",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "idg_action_item", list: true } },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const q = parse(ActionItemListQuerySchema, request.query);
      return service.listActionItems(organizationId, userId, {
        assignee: q.assignee,
        status: q.status as IdgActionItemStatus | undefined,
      });
    },
  );

  // 25 — read a meeting's minutes.
  app.get(
    "/api/v1/idg/meetings/:id/minutes",
    {
      preHandler: [READ, SCOPE("idg.read")],
      config: { auditRead: { resourceKind: "idg_minutes", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.getMinutes(organizationId, id);
    },
  );

  // 26 — submit a minutes amendment (final minutes only; tenant-admin / compliance scope).
  app.post(
    "/api/v1/idg/minutes/:id/amendments",
    { preHandler: [AMEND] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(SubmitAmendmentRequest, request.body);
      const res = await service.submitAmendment(organizationId, userId, id, b.amendmentReason);
      return reply.code(201).send(res);
    },
  );
}
