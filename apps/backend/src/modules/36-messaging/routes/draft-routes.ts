// apps/backend/src/modules/36-messaging/routes/draft-routes.ts — M36 WP 2.5 server-side drafts.
//
//   GET    /api/v1/messaging/channels/:id/draft?parentMessageId=   the caller's OWN draft, or { draft: null }
//   PUT    /api/v1/messaging/channels/:id/draft                    autosave (revision + device checked; an empty body
//                                                                  discards); 409 DRAFT_CONFLICT across devices
//   DELETE /api/v1/messaging/channels/:id/draft?parentMessageId=   discard / after send; idempotent, 204
//
// `parentMessageId` selects the thread-root draft; absent = the channel composer's. Channel authority is the same
// `channel_visibility` predicate every channel route uses (read to see a draft, send to write one). The draft is the
// caller's alone: the service keys every statement on the request-context user, never a param or body user id, and RLS
// enforces the owner a second time. The body is sealed at rest; responses are never cached.
import { requireAbac, requirePermission } from "@wardenx/auth";
import type { MessageDraftService } from "@wardenx/messaging";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DraftQuerySchema, SaveDraftBodySchema } from "./draft-typebox";
import { CHANNEL_VISIBILITY_PREDICATE } from "./messaging-routes";
import { ChannelParamsSchema, parse } from "./messaging-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const READ = requirePermission("messaging.read") as PreHandler;
const SEND = requirePermission("messaging.send") as PreHandler;
const VIEW_CHANNEL = requireAbac("messaging.read", CHANNEL_VISIBILITY_PREDICATE) as PreHandler;
const SEND_TO_CHANNEL = requireAbac("messaging.send", CHANNEL_VISIBILITY_PREDICATE) as PreHandler;
const CHANNEL_ID = requireUuidParams("id");

export interface DraftRouteDeps {
  readonly service: MessageDraftService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

export function registerDraftRoutes(app: FastifyInstance, deps: DraftRouteDeps): void {
  const { service } = deps;

  app.get(
    "/api/v1/messaging/channels/:id/draft",
    {
      preHandler: [CHANNEL_ID, READ, VIEW_CHANNEL],
      // A resourceIdParam is required (else the read event's resource id is empty and the audit insert is swallowed).
      config: { auditRead: { resourceKind: "message_draft", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const { parentMessageId } = parse(DraftQuerySchema, request.query);
      const draft = await service.getDraft(organizationId, {
        userId,
        channelId: id,
        parentMessageId,
      });
      return reply.header("Cache-Control", "no-store").send({ draft });
    },
  );

  app.put(
    "/api/v1/messaging/channels/:id/draft",
    { preHandler: [CHANNEL_ID, SEND, SEND_TO_CHANNEL] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const body = parse(SaveDraftBodySchema, request.body);
      const draft = await service.saveDraft(organizationId, { ...body, userId, channelId: id });
      return reply.header("Cache-Control", "no-store").send({ draft });
    },
  );

  app.delete(
    "/api/v1/messaging/channels/:id/draft",
    // Discarding one's OWN draft needs no channel access: a user who lost the channel must still be able to remove
    // what they typed there. Reading and writing stay gated; the service keys on the request user and RLS pins the owner.
    { preHandler: [CHANNEL_ID, SEND] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const { parentMessageId } = parse(DraftQuerySchema, request.query);
      await service.deleteDraft(organizationId, { userId, channelId: id, parentMessageId });
      return reply.code(204).send();
    },
  );
}
