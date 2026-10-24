// apps/backend/src/modules/36-messaging/routes/ack-broadcast-routes.ts - M36 WP 6.8 (ADR-0097, PROPOSED): acknowledge-required broadcast.
//
//   POST /api/v1/messaging/announcements/:messageId/ack-broadcast   the AUTHOR requires acknowledgment (messaging.announce; 201 / 200 already)
//   GET  /api/v1/messaging/announcements/:messageId/ack-broadcast   the CREATOR's who-has-not-acknowledged list (messaging.announce; anyone else: 404)
//   GET  /api/v1/messaging/ack-broadcasts                           the caller's OWN broadcasts with counts (messaging.announce)
//   GET  /api/v1/messaging/ack-broadcasts/mine                      the caller's OWN broadcasts, waiting first (messaging.read)
//   POST /api/v1/messaging/announcements/:messageId/ack             the caller's own explicit acknowledgment (messaging.read; idempotent)
//
// The tenant flag `messaging.ack_broadcast` (absent = off) is checked BEFORE the request is parsed: off is a uniform 404, the same answer
// as any unknown route, so a malformed request cannot tell a flag-off tenant from a flag-on one. Org and actor are the server-side
// request context; the acknowledgment has no user field at all (nobody acknowledges for someone else). Responses are never cached.
import { requirePermission } from "@chartwarden/auth";
import { NotFoundError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AckBroadcastService } from "../ack-broadcast/ack-broadcast-service";
import {
  AckBroadcastAcknowledgedSchema,
  AckBroadcastCreatedSchema,
  AckBroadcastDetailQuerySchema,
  AckBroadcastDetailSchema,
  AckBroadcastListSchema,
  AckBroadcastMineSchema,
  AckBroadcastParamsSchema,
} from "./ack-broadcast-typebox";
import { parse } from "./messaging-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AckBroadcastRouteDeps {
  readonly service: AckBroadcastService;
  /** Optional per-route budget, run after the permission and before the flag (ADR-0097 D10). */
  readonly rateLimit?: PreHandler | undefined;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

const ANNOUNCE = requirePermission("messaging.announce") as PreHandler;
const READ = requirePermission("messaging.read") as PreHandler;

export function registerAckBroadcastRoutes(app: FastifyInstance, deps: AckBroadcastRouteDeps): void {
  const { service } = deps;
  /** Flag off (or unreadable) => the uniform 404, before anything is parsed. */
  const flagOn: PreHandler = async (request) => {
    const { organizationId } = actorOf(request);
    // A flag-store error is indistinguishable from "off": fail closed (the death board does the same).
    const on = await service.enabled(organizationId).catch(() => false);
    if (!on) throw new NotFoundError("Not found");
  };
  const guards = (permission: PreHandler): PreHandler[] => [
    permission,
    ...(deps.rateLimit ? [deps.rateLimit] : []),
    flagOn,
  ];
  const noStore = (reply: FastifyReply): void => {
    void reply.header("Cache-Control", "no-store");
  };

  app.post(
    "/api/v1/messaging/announcements/:messageId/ack-broadcast",
    {
      preHandler: guards(ANNOUNCE),
      schema: { response: { 200: AckBroadcastCreatedSchema, 201: AckBroadcastCreatedSchema } },
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { messageId } = parse(AckBroadcastParamsSchema, request.params);
      const out = await service.create(organizationId, { userId, messageId });
      noStore(reply);
      return reply.code(out.created ? 201 : 200).send(out);
    },
  );

  app.get(
    "/api/v1/messaging/announcements/:messageId/ack-broadcast",
    {
      preHandler: guards(ANNOUNCE),
      schema: { response: { 200: AckBroadcastDetailSchema } },
      // Names which staff have not acknowledged: accounted like the WP 2.9 receipts read, keyed on the message.
      config: { auditRead: { resourceKind: "message", resourceIdParam: "messageId" } },
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { messageId } = parse(AckBroadcastParamsSchema, request.params);
      const q = parse(AckBroadcastDetailQuerySchema, request.query);
      noStore(reply);
      return service.detail(organizationId, {
        userId,
        messageId,
        filter: q.filter ?? "pending",
        limit: q.limit ?? 100,
        offset: q.offset ?? 0,
      });
    },
  );

  app.get(
    "/api/v1/messaging/ack-broadcasts",
    {
      preHandler: guards(ANNOUNCE),
      schema: { response: { 200: AckBroadcastListSchema } },
      config: { auditRead: { none: "counts per announcement: no person, no message text" } },
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      noStore(reply);
      return { broadcasts: await service.list(organizationId, { userId }) };
    },
  );

  app.get(
    "/api/v1/messaging/ack-broadcasts/mine",
    {
      preHandler: guards(READ),
      schema: { response: { 200: AckBroadcastMineSchema } },
      config: { auditRead: { none: "the caller's own acknowledgment list: ids and instants only" } },
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      noStore(reply);
      return { items: await service.mine(organizationId, { userId }) };
    },
  );

  app.post(
    "/api/v1/messaging/announcements/:messageId/ack",
    {
      preHandler: guards(READ),
      schema: { response: { 200: AckBroadcastAcknowledgedSchema } },
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { messageId } = parse(AckBroadcastParamsSchema, request.params);
      noStore(reply);
      return service.acknowledge(organizationId, { userId, messageId });
    },
  );
}
