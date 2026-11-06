import { NotFoundError } from "@chartwarden/types";
// apps/backend/src/modules/16-bereavement/routes/group.routes.ts — M16 (ADR-0109 D10, PR 3) routes 53-66: support groups.
//
//   read    (`bereavement.group.read`)   the group list, one group, its sessions: oversight OR any bereavement-capable discipline (no family named).
//   manage  (`bereavement.group.manage`) create (oversight), edit / open / close / sessions (oversight or the group's STAFF facilitator):
//           `bereavement_group_scope` mode `manage`.
//   enroll  (`bereavement.group.enroll`) enroll / withdraw a family: the contact's own counselor or oversight (`bereavement_window`).
//   run     (`bereavement.group.run`)    the roster and attendance: oversight, the staff facilitator, or a VOLUNTEER facilitator who passes the 418.78
//           gates right now (`bereavement_group_scope` mode `run`); a volunteer gets the reduced roster.
// Every write needs `Idempotency-Key`; every state change on an existing group / session needs `If-Match`. The roster and a contact's enrollments
// declare their M4 read audit with `resourceIdParam` (they name families); the program-level reads name nobody and say so.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import type { M16GroupService } from "./group-service";
import {
  AddGroupSessionBody,
  CloseGroupBody,
  CreateGroupBody,
  EnrollContactBody,
  GroupContactParams,
  GroupListQuerySchema,
  GroupParams,
  GroupSessionParams,
  RecordAttendanceBody,
  UpdateGroupBody,
  WithdrawEnrollmentBody,
} from "./group-typebox";
import {
  ABAC_GROUP,
  ABAC_OVERSIGHT,
  ABAC_PROGRAM_STAFF,
  ABAC_WINDOW_BODY_CONTACT,
  ABAC_WINDOW_CONTACT,
  P,
} from "./guards";
import { ContactParams, parse, parseQuery } from "./m16-typebox";

export interface GroupRouteDeps {
  readonly groupService: M16GroupService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();
const NO_PHI = {
  auditRead: {
    none: "agency support-group programming (name, schedule, facilitators, counts); no family is named",
  },
} as const;
const READ = "bereavement.group.read";
const MANAGE = "bereavement.group.manage";
const ENROLL = "bereavement.group.enroll";
const RUN = "bereavement.group.run";

export function registerBereavementGroupRoutes(app: FastifyInstance, deps: GroupRouteDeps): void {
  const { groupService } = deps;

  // 53 — groups, newest first.
  app.get(
    "/api/v1/bereavement/groups",
    { preHandler: [P(READ), ABAC_PROGRAM_STAFF(READ), NO_OFFSET], config: NO_PHI },
    async (request) =>
      groupService.listGroups(actorOf(request), parseQuery(GroupListQuerySchema, request.query)),
  );

  // 54 — create a draft group (oversight only: there is no group to facilitate yet).
  app.post(
    "/api/v1/bereavement/groups",
    { preHandler: [P(MANAGE), ABAC_OVERSIGHT(MANAGE), IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(CreateGroupBody, request.body);
      const created = await groupService.createGroup(writeActorOf(request), {
        ...body,
        joinUrl: body.joinUrl,
      });
      return reply.code(201).send(created);
    },
  );

  // 55 — one group (with the decrypted meeting link).
  app.get(
    "/api/v1/bereavement/groups/:groupId",
    { preHandler: [P(READ), ABAC_PROGRAM_STAFF(READ)], config: NO_PHI },
    async (request) => {
      const { groupId } = parse(GroupParams, request.params);
      const group = await groupService.getGroup(actorOf(request), groupId);
      if (!group) throw new NotFoundError("support group not found");
      return group;
    },
  );

  // 56 — edit a draft or open group.
  app.patch(
    "/api/v1/bereavement/groups/:groupId",
    { preHandler: [P(MANAGE), ABAC_GROUP(MANAGE, "manage"), IDEMPOTENT] },
    async (request) => {
      const { groupId } = parse(GroupParams, request.params);
      const body = parse(UpdateGroupBody, request.body);
      return groupService.updateGroup(writeActorOf(request), groupId, {
        ...body,
        joinUrl: body.joinUrl,
        recurrence: body.recurrence,
        expectedVersion: ifMatchVersion(request, true) as number,
      });
    },
  );

  // 57 — open: materialize a recurring group's sessions; a volunteer facilitator must pass the 418.78 gates now.
  app.post(
    "/api/v1/bereavement/groups/:groupId/open",
    { preHandler: [P(MANAGE), ABAC_GROUP(MANAGE, "manage"), IDEMPOTENT] },
    async (request) => {
      const { groupId } = parse(GroupParams, request.params);
      return groupService.openGroup(writeActorOf(request), groupId, {
        expectedVersion: ifMatchVersion(request, true) as number,
      });
    },
  );

  // 58 — complete or cancel: live enrollments are withdrawn, future sessions cancelled.
  app.post(
    "/api/v1/bereavement/groups/:groupId/close",
    { preHandler: [P(MANAGE), ABAC_GROUP(MANAGE, "manage"), IDEMPOTENT] },
    async (request) => {
      const { groupId } = parse(GroupParams, request.params);
      const body = parse(CloseGroupBody, request.body);
      return groupService.closeGroup(writeActorOf(request), groupId, {
        status: body.status,
        expectedVersion: ifMatchVersion(request, true) as number,
      });
    },
  );

  // 59 — every session, by start.
  app.get(
    "/api/v1/bereavement/groups/:groupId/sessions",
    { preHandler: [P(READ), ABAC_PROGRAM_STAFF(READ)], config: NO_PHI },
    async (request) => {
      const { groupId } = parse(GroupParams, request.params);
      const sessions = await groupService.listSessions(actorOf(request), groupId);
      if (!sessions) throw new NotFoundError("support group not found");
      return sessions;
    },
  );

  // 60 — add one session.
  app.post(
    "/api/v1/bereavement/groups/:groupId/sessions",
    { preHandler: [P(MANAGE), ABAC_GROUP(MANAGE, "manage"), IDEMPOTENT] },
    async (request, reply) => {
      const { groupId } = parse(GroupParams, request.params);
      const body = parse(AddGroupSessionBody, request.body);
      return reply
        .code(201)
        .send(await groupService.addSession(writeActorOf(request), groupId, body));
    },
  );

  // 61 — cancel a scheduled session.
  app.post(
    "/api/v1/bereavement/groups/:groupId/sessions/:sessionId/cancel",
    { preHandler: [P(MANAGE), ABAC_GROUP(MANAGE, "manage"), IDEMPOTENT] },
    async (request) => {
      const { groupId, sessionId } = parse(GroupSessionParams, request.params);
      return groupService.cancelSession(writeActorOf(request), groupId, sessionId, {
        expectedVersion: ifMatchVersion(request, true) as number,
      });
    },
  );

  // 62 — the roster (staff or volunteer projection). It names families, so the read event names the group.
  app.get(
    "/api/v1/bereavement/groups/:groupId/roster",
    {
      preHandler: [P(RUN), ABAC_GROUP(RUN, "run")],
      config: {
        auditRead: { resourceKind: "bereavement_support_group", resourceIdParam: "groupId" },
      },
    },
    async (request) => {
      const { groupId } = parse(GroupParams, request.params);
      const roster = await groupService.roster(actorOf(request), groupId);
      if (!roster) throw new NotFoundError("support group not found");
      return roster;
    },
  );

  // 63 — enroll a program family (the contact's counselor or oversight).
  app.post(
    "/api/v1/bereavement/groups/:groupId/enrollments",
    { preHandler: [P(ENROLL), ABAC_WINDOW_BODY_CONTACT(ENROLL), IDEMPOTENT] },
    async (request) => {
      const { groupId } = parse(GroupParams, request.params);
      const { contactId } = parse(EnrollContactBody, request.body);
      return groupService.enroll(writeActorOf(request), groupId, contactId);
    },
  );

  // 64 — withdraw a contact's live enrollment.
  app.post(
    "/api/v1/bereavement/groups/:groupId/enrollments/:contactId/withdraw",
    { preHandler: [P(ENROLL), ABAC_WINDOW_CONTACT(ENROLL), IDEMPOTENT] },
    async (request) => {
      const { groupId, contactId } = parse(GroupContactParams, request.params);
      const body = parse(WithdrawEnrollmentBody, request.body);
      return groupService.withdraw(writeActorOf(request), groupId, contactId, body);
    },
  );

  // 65 — record who attended a session (idempotent per contact). Each new attendee gets a contact-log activity row (no cadence item).
  app.post(
    "/api/v1/bereavement/groups/:groupId/sessions/:sessionId/attendance",
    { preHandler: [P(RUN), ABAC_GROUP(RUN, "run"), IDEMPOTENT] },
    async (request) => {
      const { groupId, sessionId } = parse(GroupSessionParams, request.params);
      const { contactIds } = parse(RecordAttendanceBody, request.body);
      return groupService.recordAttendance(writeActorOf(request), groupId, sessionId, contactIds);
    },
  );

  // 66 — one contact's enrollments (the contact screen's groups panel).
  app.get(
    "/api/v1/bereavement/contacts/:contactId/support-groups",
    {
      preHandler: [P(ENROLL), ABAC_WINDOW_CONTACT(ENROLL)],
      config: { auditRead: { resourceKind: "bereaved_contact", resourceIdParam: "contactId" } },
    },
    async (request) => {
      const { contactId } = parse(ContactParams, request.params);
      const rows = await groupService.contactEnrollments(actorOf(request), contactId);
      if (!rows) throw new NotFoundError("contact not found");
      return rows;
    },
  );
}
