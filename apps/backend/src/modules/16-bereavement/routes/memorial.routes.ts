import { NotFoundError } from "@chartwarden/types";
// apps/backend/src/modules/16-bereavement/routes/memorial.routes.ts — M16 (ADR-0109 D10, PR 3) routes 67-76: memorial services.
//
//   `bereavement.memorial.rsvp`   the service list / one service (oversight or any bereavement-capable discipline: no family named), and a family's
//                                  phone RSVP plus their invitations on the contact screen (the family's window: their counselor or oversight).
//   `bereavement.memorial.manage` create / edit / publish (set-based invitations + the invitation mailing run) / close, the invitation list and
//                                  attendance: oversight only (an invitation list names every recently bereaved family).
// Every write needs `Idempotency-Key`; every state change on a service needs `If-Match`. The invitation list and a contact's invitations declare
// their M4 read audit with `resourceIdParam`.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import { ABAC_OVERSIGHT, ABAC_PROGRAM_STAFF, ABAC_WINDOW_CONTACT, P } from "./guards";
import { ContactParams, parse, parseQuery } from "./m16-typebox";
import type { M16MemorialService } from "./memorial-service";
import {
  CloseMemorialBody,
  ContactInvitationParams,
  MemorialAttendanceBody,
  MemorialFieldsBody,
  MemorialInvitationParams,
  MemorialListQuerySchema,
  MemorialParams,
  MemorialRsvpBody,
} from "./memorial-typebox";

export interface MemorialRouteDeps {
  readonly memorialService: M16MemorialService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();
const NO_PHI = {
  auditRead: {
    none: "agency memorial-service programming (title, time, place, counts); no family is named",
  },
} as const;
const MANAGE = "bereavement.memorial.manage";
const RSVP = "bereavement.memorial.rsvp";
const oversight = (key: string) => [P(key), ABAC_OVERSIGHT(key)] as const;

export function registerBereavementMemorialRoutes(
  app: FastifyInstance,
  deps: MemorialRouteDeps,
): void {
  const { memorialService } = deps;

  // 67 — services, newest start first.
  app.get(
    "/api/v1/bereavement/memorials",
    { preHandler: [P(RSVP), ABAC_PROGRAM_STAFF(RSVP), NO_OFFSET], config: NO_PHI },
    async (request) =>
      memorialService.listMemorials(
        actorOf(request),
        parseQuery(MemorialListQuerySchema, request.query),
      ),
  );

  // 68 — a draft service.
  app.post(
    "/api/v1/bereavement/memorials",
    { preHandler: [...oversight(MANAGE), IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(MemorialFieldsBody, request.body);
      return reply
        .code(201)
        .send(await memorialService.createMemorial(writeActorOf(request), body));
    },
  );

  // 69 — one service (with its meeting link).
  app.get(
    "/api/v1/bereavement/memorials/:serviceId",
    { preHandler: [P(RSVP), ABAC_PROGRAM_STAFF(RSVP)], config: NO_PHI },
    async (request) => {
      const { serviceId } = parse(MemorialParams, request.params);
      const svc = await memorialService.getMemorial(actorOf(request), serviceId);
      if (!svc) throw new NotFoundError("memorial service not found");
      return svc;
    },
  );

  // 70 — edit a draft or published service.
  app.patch(
    "/api/v1/bereavement/memorials/:serviceId",
    { preHandler: [...oversight(MANAGE), IDEMPOTENT] },
    async (request) => {
      const { serviceId } = parse(MemorialParams, request.params);
      const body = parse(MemorialFieldsBody, request.body);
      return memorialService.updateMemorial(writeActorOf(request), serviceId, {
        ...body,
        expectedVersion: ifMatchVersion(request, true) as number,
      });
    },
  );

  // 71 — publish: invite the families of deaths in the window (set-based) and draft the invitation mailing run.
  app.post(
    "/api/v1/bereavement/memorials/:serviceId/publish",
    { preHandler: [...oversight(MANAGE), IDEMPOTENT] },
    async (request) => {
      const { serviceId } = parse(MemorialParams, request.params);
      return memorialService.publishMemorial(writeActorOf(request), serviceId, {
        expectedVersion: ifMatchVersion(request, true) as number,
      });
    },
  );

  // 72 — held (once started) or cancelled.
  app.post(
    "/api/v1/bereavement/memorials/:serviceId/close",
    { preHandler: [...oversight(MANAGE), IDEMPOTENT] },
    async (request) => {
      const { serviceId } = parse(MemorialParams, request.params);
      const body = parse(CloseMemorialBody, request.body);
      return memorialService.closeMemorial(writeActorOf(request), serviceId, {
        status: body.status,
        expectedVersion: ifMatchVersion(request, true) as number,
      });
    },
  );

  // 73 — every invitation (names families: oversight only, and the read event names the service).
  app.get(
    "/api/v1/bereavement/memorials/:serviceId/invitations",
    {
      preHandler: [...oversight(MANAGE)],
      config: {
        auditRead: { resourceKind: "bereavement_memorial_service", resourceIdParam: "serviceId" },
      },
    },
    async (request) => {
      const { serviceId } = parse(MemorialParams, request.params);
      const rows = await memorialService.listInvitations(actorOf(request), serviceId);
      if (!rows) throw new NotFoundError("memorial service not found");
      return rows;
    },
  );

  // 74 — a family's answer taken by phone (their counselor or oversight).
  app.put(
    "/api/v1/bereavement/contacts/:contactId/memorial-invitations/:invitationId/rsvp",
    { preHandler: [P(RSVP), ABAC_WINDOW_CONTACT(RSVP), IDEMPOTENT] },
    async (request) => {
      const { contactId, invitationId } = parse(ContactInvitationParams, request.params);
      const body = parse(MemorialRsvpBody, request.body);
      return memorialService.recordStaffRsvp(writeActorOf(request), contactId, invitationId, body);
    },
  );

  // 75 — attended (a contact-log activity row) or a no-show, once the service has started.
  app.post(
    "/api/v1/bereavement/memorials/:serviceId/invitations/:invitationId/attendance",
    { preHandler: [...oversight(MANAGE), IDEMPOTENT] },
    async (request) => {
      const { serviceId, invitationId } = parse(MemorialInvitationParams, request.params);
      const body = parse(MemorialAttendanceBody, request.body);
      return memorialService.recordAttendance(writeActorOf(request), serviceId, invitationId, body);
    },
  );

  // 76 — one contact's invitations (the contact screen).
  app.get(
    "/api/v1/bereavement/contacts/:contactId/memorial-invitations",
    {
      preHandler: [P(RSVP), ABAC_WINDOW_CONTACT(RSVP)],
      config: { auditRead: { resourceKind: "bereaved_contact", resourceIdParam: "contactId" } },
    },
    async (request) => {
      const { contactId } = parse(ContactParams, request.params);
      const rows = await memorialService.contactInvitations(actorOf(request), contactId);
      if (!rows) throw new NotFoundError("contact not found");
      return rows;
    },
  );
}
