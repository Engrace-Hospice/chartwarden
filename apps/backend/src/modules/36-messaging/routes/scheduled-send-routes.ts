// apps/backend/src/modules/36-messaging/routes/scheduled-send-routes.ts — M36 WP 2.6 scheduled send.
//
//   POST   /api/v1/messaging/channels/:id/scheduled-messages   schedule a message (messaging.send + channel_visibility,
//                                                              messaging.announce for the announcement channel,
//                                                              Idempotency-Key required); 201
//   GET    /api/v1/messaging/scheduled-messages?channelId=     the caller's OWN scheduled messages
//   PATCH  /api/v1/messaging/scheduled-messages/:id            reschedule (pending or blocked -> pending)
//   DELETE /api/v1/messaging/scheduled-messages/:id            cancel before dispatch; idempotent, { cancelled }
//
// The SEND itself is authorised again by the dispatcher at the moment it is due (membership, messaging.send, channel
// state), so these routes only decide who may QUEUE. List/cancel need only messaging.read: a user who lost access must
// still be able to see and withdraw what they queued. Org and user come from the request context, never a param or the
// body; the service keys on them and RLS pins the owner again. Responses are never cached (they carry message text).
import { requireAbac, requirePermission } from "@chartwarden/auth";
import type { AnnouncementService, ScheduledSendService } from "@chartwarden/messaging";
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { announcementSendGuard } from "./announcement-routes";
import { CHANNEL_VISIBILITY_PREDICATE, REQUIRE_IDEMPOTENCY_KEY } from "./messaging-routes";
import { ChannelParamsSchema, parse } from "./messaging-typebox";
import {
  CreateScheduledBodySchema,
  RescheduleBodySchema,
  ScheduledListQuerySchema,
  ScheduledMessageParamsSchema,
} from "./scheduled-send-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const READ = requirePermission("messaging.read") as PreHandler;
const SEND = requirePermission("messaging.send") as PreHandler;
const SEND_TO_CHANNEL = requireAbac("messaging.send", CHANNEL_VISIBILITY_PREDICATE) as PreHandler;
const CHANNEL_ID = requireUuidParams("id");

export interface ScheduledSendRouteDeps {
  readonly service: ScheduledSendService;
  /** The announcement-channel send guard (fails closed: required, like the message route). */
  readonly announcements: AnnouncementService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

export function registerScheduledSendRoutes(
  app: FastifyInstance,
  deps: ScheduledSendRouteDeps,
): void {
  const { service } = deps;
  if (!deps.announcements) {
    throw new Error(
      "registerScheduledSendRoutes: `announcements` is required (the guard fails closed)",
    );
  }
  const announceGuard = announcementSendGuard(deps.announcements);
  const MESSAGE_ID = requireUuidParams("id");

  app.post(
    "/api/v1/messaging/channels/:id/scheduled-messages",
    { preHandler: [CHANNEL_ID, SEND, SEND_TO_CHANNEL, announceGuard, REQUIRE_IDEMPOTENCY_KEY] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const body = parse(CreateScheduledBodySchema, request.body);
      const created = await service.create(organizationId, {
        userId,
        channelId: id,
        parentMessageId: body.parentMessageId,
        body: body.body,
        scheduledFor: body.scheduledFor,
        timeZone: body.timeZone,
        clientMessageId: body.clientMessageId,
      });
      return reply.code(201).header("Cache-Control", "no-store").send(created);
    },
  );

  app.get(
    "/api/v1/messaging/scheduled-messages",
    {
      preHandler: [READ],
      // Returns the caller's own queued text; account the read (a list, so no single resource id).
      config: { auditRead: { resourceKind: "scheduled_message", list: true } },
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { channelId } = parse(ScheduledListQuerySchema, request.query);
      const scheduledMessages = await service.listMine(organizationId, { userId, channelId });
      return reply.header("Cache-Control", "no-store").send({ scheduledMessages });
    },
  );

  app.patch(
    "/api/v1/messaging/scheduled-messages/:id",
    { preHandler: [MESSAGE_ID, SEND] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ScheduledMessageParamsSchema, request.params);
      const { scheduledFor } = parse(RescheduleBodySchema, request.body);
      const view = await service.reschedule(organizationId, { userId, id, scheduledFor });
      return reply.header("Cache-Control", "no-store").send(view);
    },
  );

  app.delete(
    "/api/v1/messaging/scheduled-messages/:id",
    { preHandler: [MESSAGE_ID, READ] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ScheduledMessageParamsSchema, request.params);
      const result = await service.cancel(organizationId, { userId, id });
      return reply.header("Cache-Control", "no-store").send(result);
    },
  );
}
