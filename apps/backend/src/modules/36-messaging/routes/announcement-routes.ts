// apps/backend/src/modules/36-messaging/routes/announcement-routes.ts — M36 WP 2.9 routes.
//
//   GET  /api/v1/messaging/announcements/:messageId/receipts   who has read one announcement (messaging.announce)
//   POST /api/v1/messaging/department-channels                 find-or-create a discipline/location channel
//                                                              (messaging.announce, i.e. org_admin; 201 created / 200 found)
//
// Plus `announcementSendGuard`, the preHandler that keeps SENDING into the announcement channel org_admin-only on the
// generic channel send route as well (the channel is org-wide visible, so channel_visibility alone lets every member
// post). Org and actor are always the server-side request context.
import { requirePermission } from "@wardenx/auth";
import type { AnnouncementService } from "@wardenx/messaging";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AnnouncementParamsSchema,
  CreateDepartmentChannelBodySchema,
} from "./announcement-typebox";
import { ChannelParamsSchema, parse } from "./messaging-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const ANNOUNCE = requirePermission("messaging.announce") as PreHandler;

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

/** Sending into the announcement channel needs `messaging.announce`; every other channel passes untouched. */
export function announcementSendGuard(announcements: AnnouncementService): PreHandler {
  return async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(ChannelParamsSchema, request.params);
    if (await announcements.isAnnouncementChannel(organizationId, userId, id)) {
      await ANNOUNCE(request, reply);
    }
  };
}

export function registerAnnouncementRoutes(
  app: FastifyInstance,
  announcements: AnnouncementService,
): void {
  app.get(
    "/api/v1/messaging/announcements/:messageId/receipts",
    {
      preHandler: [ANNOUNCE],
      // Names which staff read an org-wide notice: accounted like any other read, keyed on the message.
      config: { auditRead: { resourceKind: "message", resourceIdParam: "messageId" } },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { messageId } = parse(AnnouncementParamsSchema, request.params);
      return announcements.listAnnouncementReceipts(organizationId, { userId, messageId });
    },
  );

  app.post(
    "/api/v1/messaging/department-channels",
    { preHandler: [ANNOUNCE] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(CreateDepartmentChannelBodySchema, request.body);
      const result = await announcements.createDepartmentChannel(organizationId, {
        creatorUserId: userId,
        kind: body.kind,
        subjectId: body.subjectId,
        title: body.title,
      });
      return reply.code(result.created ? 201 : 200).send(result);
    },
  );
}
