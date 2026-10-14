// apps/backend/src/modules/36-messaging/routes/poll-routes.ts - WP 2.10 polls (NON-CLINICAL, single choice, named votes).
//
//   POST /api/v1/messaging/channels/:id/polls                            create a poll AS a message (messaging.send +
//                                                                        channel_visibility, announcement guard,
//                                                                        Idempotency-Key required); 201
//   GET  /api/v1/messaging/channels/:id/messages/:messageId/poll         results + who voted + the caller's own vote
//   PUT  /api/v1/messaging/channels/:id/messages/:messageId/poll/vote    cast or change the caller's vote (idempotent)
//   POST /api/v1/messaging/channels/:id/messages/:messageId/poll/close   close (author, or a channel manager); idempotent
//
// Every route is the channel's own: the guards are the ones a message send / read uses, so a non-member, a removed
// member and another organisation get the 403 a random channel id gets (a denied `channel_visibility`), and a poll or
// message that is not there is a 404 for everyone.
//
// ANNOUNCEMENT CHANNELS (decision): only CREATING a poll sits behind the announcement guard (`messaging.announce`), because
// that is posting into a broadcast channel. VOTING is participation by the people the notice is for (the same as reading
// or reacting), and refusing it would make an announcement poll unanswerable. CLOSING is not widened either: the service
// allows only the author or a channel manager, so a voter can never end the poll. Org and user come from the request context, never a
// param or the body. Polls are refused in a patient-linked channel (422 POLL_NOT_ALLOWED_IN_PATIENT_CHANNEL). The
// poll detail names voters, so it is read-audited like a message read; responses are never cached.
import { requireAbac, requirePermission } from "@wardenx/auth";
import type { AnnouncementService, MessagingRouteService } from "@wardenx/messaging";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { MessagePollService } from "../polls/poll-service-db";
import { announcementSendGuard } from "./announcement-routes";
import { CHANNEL_VISIBILITY_PREDICATE, REQUIRE_IDEMPOTENCY_KEY } from "./messaging-routes";
import { parse } from "./messaging-typebox";
import {
  CreatePollBodySchema,
  PollChannelParamsSchema,
  PollMessageParamsSchema,
  VotePollBodySchema,
} from "./poll-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const READ = requirePermission("messaging.read") as PreHandler;
const SEND = requirePermission("messaging.send") as PreHandler;
const VIEW_CHANNEL = requireAbac("messaging.read", CHANNEL_VISIBILITY_PREDICATE) as PreHandler;
const SEND_TO_CHANNEL = requireAbac("messaging.send", CHANNEL_VISIBILITY_PREDICATE) as PreHandler;

export interface PollRouteDeps {
  readonly service: MessagePollService;
  /** The announcement-channel send guard (fails closed: required, like the message route). */
  readonly announcements: AnnouncementService;
  /** The existing channel-manager predicate (`channel_member_admin`) decides who besides the author may close. */
  readonly canManageMembers: MessagingRouteService["canManageMembers"];
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

export function registerPollRoutes(app: FastifyInstance, deps: PollRouteDeps): void {
  const { service } = deps;
  if (!deps.announcements) {
    throw new Error("registerPollRoutes: `announcements` is required (the guard fails closed)");
  }
  const announceGuard = announcementSendGuard(deps.announcements);
  const channelId = requireUuidParams("id");
  const messageIds = requireUuidParams("id", "messageId");

  app.post(
    "/api/v1/messaging/channels/:id/polls",
    { preHandler: [channelId, SEND, SEND_TO_CHANNEL, announceGuard, REQUIRE_IDEMPOTENCY_KEY] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(PollChannelParamsSchema, request.params);
      const body = parse(CreatePollBodySchema, request.body);
      const created = await service.createPoll(organizationId, {
        userId,
        channelId: id,
        question: body.question,
        options: body.options,
        clientMessageId: body.clientMessageId,
      });
      return reply.code(201).header("Cache-Control", "no-store").send(created);
    },
  );

  app.get(
    "/api/v1/messaging/channels/:id/messages/:messageId/poll",
    {
      preHandler: [messageIds, READ, VIEW_CHANNEL],
      // Voters are named: account the read. The resource id param is required or the audit insert is swallowed.
      config: { auditRead: { resourceKind: "message_poll", resourceIdParam: "messageId" } },
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const p = parse(PollMessageParamsSchema, request.params);
      const poll = await service.getPoll(organizationId, {
        userId,
        channelId: p.id,
        messageId: p.messageId,
      });
      return reply.header("Cache-Control", "no-store").send(poll);
    },
  );

  app.put(
    "/api/v1/messaging/channels/:id/messages/:messageId/poll/vote",
    { preHandler: [messageIds, SEND, SEND_TO_CHANNEL] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const p = parse(PollMessageParamsSchema, request.params);
      const { optionId } = parse(VotePollBodySchema, request.body);
      const result = await service.vote(organizationId, {
        userId,
        channelId: p.id,
        messageId: p.messageId,
        optionId,
      });
      return reply.header("Cache-Control", "no-store").send(result);
    },
  );

  app.post(
    "/api/v1/messaging/channels/:id/messages/:messageId/poll/close",
    { preHandler: [messageIds, SEND, SEND_TO_CHANNEL] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const p = parse(PollMessageParamsSchema, request.params);
      const ctx = request.context;
      const canManage = await deps.canManageMembers(
        organizationId,
        {
          kind: "user",
          userId,
          roles: [...ctx.roles],
          locationIds: [...ctx.locationIds],
        },
        p.id,
      );
      const result = await service.closePoll(organizationId, {
        userId,
        channelId: p.id,
        messageId: p.messageId,
        canManage,
      });
      return reply.header("Cache-Control", "no-store").send(result);
    },
  );
}
