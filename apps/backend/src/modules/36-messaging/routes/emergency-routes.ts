// apps/backend/src/modules/36-messaging/routes/emergency-routes.ts - M36 ADR-0106 (PROPOSED): emergency message.
//
//   POST /api/v1/messaging/messages/:messageId/emergency   the AUTHOR declares their message an emergency (messaging.send; 201 / 200 already)
//   GET  /api/v1/messaging/messages/:messageId/emergency   the AUTHOR's who-has-acknowledged list (messaging.send; anyone else: 404)
//   GET  /api/v1/messaging/emergencies                     the caller's OWN emergencies with counts (messaging.send)
//   GET  /api/v1/messaging/emergencies/mine                the caller's OWN alarms, waiting first (messaging.read)
//   POST /api/v1/messaging/emergencies/:emergencyId/ack    the caller's own explicit acknowledgment (messaging.read; idempotent)
//
// The tenant flag `messaging.emergency` (absent = off) is checked BEFORE the request is parsed: off is a uniform 404, the same answer as any
// unknown route. Org and actor are the server-side request context; the acknowledgment has no user field (nobody acknowledges for someone
// else). Responses are never cached.
import { requirePermission } from "@chartwarden/auth";
import { NotFoundError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { EmergencyService } from "../emergency/emergency-service";
import {
  EmergencyAcknowledgedSchema,
  EmergencyCreatedSchema,
  EmergencyDetailSchema,
  EmergencyListSchema,
  EmergencyMessageParamsSchema,
  EmergencyMineSchema,
  EmergencyParamsSchema,
} from "./emergency-typebox";
import { parse } from "./messaging-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface EmergencyRouteDeps {
  readonly service: EmergencyService;
  /** Optional per-route budget, run after the permission and before the flag. */
  readonly rateLimit?: PreHandler | undefined;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

const SEND = requirePermission("messaging.send") as PreHandler;
const READ = requirePermission("messaging.read") as PreHandler;

export function registerEmergencyRoutes(app: FastifyInstance, deps: EmergencyRouteDeps): void {
  const { service } = deps;
  /** Flag off (or unreadable) => the uniform 404, before anything is parsed. A flag-store error fails closed. */
  const flagOn: PreHandler = async (request) => {
    const { organizationId } = actorOf(request);
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
    "/api/v1/messaging/messages/:messageId/emergency",
    {
      preHandler: guards(SEND),
      schema: { response: { 200: EmergencyCreatedSchema, 201: EmergencyCreatedSchema } },
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { messageId } = parse(EmergencyMessageParamsSchema, request.params);
      const out = await service.declare(organizationId, { userId, messageId });
      noStore(reply);
      return reply.code(out.created ? 201 : 200).send(out);
    },
  );

  app.get(
    "/api/v1/messaging/messages/:messageId/emergency",
    {
      preHandler: guards(SEND),
      schema: { response: { 200: EmergencyDetailSchema } },
      // Names which staff have not acknowledged: accounted like the receipts read, keyed on the message.
      config: { auditRead: { resourceKind: "message", resourceIdParam: "messageId" } },
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { messageId } = parse(EmergencyMessageParamsSchema, request.params);
      noStore(reply);
      return service.detail(organizationId, { userId, messageId });
    },
  );

  app.get(
    "/api/v1/messaging/emergencies",
    {
      preHandler: guards(SEND),
      schema: { response: { 200: EmergencyListSchema } },
      config: { auditRead: { none: "counts per emergency: no person, no message text" } },
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      noStore(reply);
      return { emergencies: await service.list(organizationId, { userId }) };
    },
  );

  app.get(
    "/api/v1/messaging/emergencies/mine",
    {
      preHandler: guards(READ),
      schema: { response: { 200: EmergencyMineSchema } },
      config: { auditRead: { none: "the caller's own alarm list: ids and instants only" } },
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      noStore(reply);
      return { items: await service.mine(organizationId, { userId }) };
    },
  );

  app.post(
    "/api/v1/messaging/emergencies/:emergencyId/ack",
    {
      preHandler: guards(READ),
      schema: { response: { 200: EmergencyAcknowledgedSchema } },
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { emergencyId } = parse(EmergencyParamsSchema, request.params);
      noStore(reply);
      return service.acknowledge(organizationId, { userId, emergencyId });
    },
  );
}
