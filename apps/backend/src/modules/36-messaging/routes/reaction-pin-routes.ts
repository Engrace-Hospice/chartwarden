// apps/backend/src/modules/36-messaging/routes/reaction-pin-routes.ts - WP 2.4 reactions and pins.
//
// Channel-scoped like the thread read: the guards passed in are the channel's own (`messaging.read|send` plus the
// `channel_visibility` ABAC predicate on `:id`), so a non-member, a removed member and another organisation get the
// 404 a random id gets; the service then re-scopes the message to that channel. Reactions are NON-CLINICAL: they
// are not a sign-off, they write no receipt, and there is deliberately no route that turns one into the
// other. PUT/DELETE are naturally idempotent (a repeat is a no-op), so no Idempotency-Key is required. Pin and unpin
// are audited by the `message_pin` write-audit trigger. The pin list is a decrypted-body read, so it is read-audited
// like the channel history (one aggregate list-read event; a single-resource read would need `resourceIdParam`).
import type { MessagingRouteService } from "@wardenx/messaging";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ChannelParamsSchema, parse } from "./messaging-typebox";
import { PinParamsSchema, ReactionParamsSchema } from "./reaction-pin-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The channel guards `registerMessagingRoutes` already built; passed in to avoid an import cycle. */
export interface ChannelGuards {
  readonly read: PreHandler;
  readonly send: PreHandler;
  readonly viewChannel: PreHandler;
  readonly sendToChannel: PreHandler;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

export function registerReactionPinRoutes(
  app: FastifyInstance,
  service: MessagingRouteService,
  guards: ChannelGuards,
): void {
  const write = [guards.send, guards.sendToChannel];

  app.put(
    "/api/v1/messaging/channels/:id/messages/:messageId/reactions/:emoji",
    { preHandler: write },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const p = parse(ReactionParamsSchema, request.params);
      return service.setReaction(organizationId, {
        userId,
        channelId: p.id,
        messageId: p.messageId,
        emoji: p.emoji,
        present: true,
      });
    },
  );

  app.delete(
    "/api/v1/messaging/channels/:id/messages/:messageId/reactions/:emoji",
    { preHandler: write },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const p = parse(ReactionParamsSchema, request.params);
      return service.setReaction(organizationId, {
        userId,
        channelId: p.id,
        messageId: p.messageId,
        emoji: p.emoji,
        present: false,
      });
    },
  );

  app.put(
    "/api/v1/messaging/channels/:id/messages/:messageId/pin",
    { preHandler: write },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const p = parse(PinParamsSchema, request.params);
      return service.pinMessage(organizationId, {
        userId,
        channelId: p.id,
        messageId: p.messageId,
      });
    },
  );

  app.delete(
    "/api/v1/messaging/channels/:id/messages/:messageId/pin",
    { preHandler: write },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const p = parse(PinParamsSchema, request.params);
      await service.unpinMessage(organizationId, {
        userId,
        channelId: p.id,
        messageId: p.messageId,
      });
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/v1/messaging/channels/:id/pins",
    {
      preHandler: [guards.read, guards.viewChannel],
      config: {
        auditRead: {
          resourceKind: "message",
          list: true,
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      return service.listPins(organizationId, { userId, channelId: id });
    },
  );
}
