// apps/backend/src/modules/36-messaging/routes/session-device-routes.ts - WP 5.5 (ADR-0083, PROPOSED): the device and session manager.
//
//   GET    /api/v1/devices                              the caller's OWN staff sessions ("devices"); the current one is marked
//   DELETE /api/v1/devices/:id                          revoke one of the caller's own sessions (the current one signs the caller out)
//   GET    /api/v1/messaging/governance/sessions?user_id    a security officer lists another user's sessions in the organisation
//        (messaging.sessions.manage; audited)
//   DELETE /api/v1/messaging/governance/sessions/:id    a security officer revokes one session in the organisation
//        (messaging.sessions.manage + a fresh step-up for `messaging.sessions.revoke`; audited)
//
// Self-service needs no permission key: it can only ever reach the caller's own sessions. A session that is not the caller's (admin: not in the
// caller's organisation), an unknown one and one already revoked are the same 404. Org, user and the current session id are the server-side
// request context, never the client's. Nothing returned is secret (no token, IP address, raw user agent or endpoint value).
import { requirePermission, requireStepUp } from "@wardenx/auth";
import {
  SESSIONS_MANAGE_PERMISSION,
  SESSIONS_REVOKE_STEP_UP_KEY,
  UnauthorizedError,
} from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SessionDeviceService } from "../session-devices/session-device-service";
import type { SessionDeviceActor } from "../session-devices/session-device-types";
import { parse } from "./messaging-typebox";
import {
  DeviceListResponseSchema,
  DeviceParamsSchema,
  DeviceRevokeResponseSchema,
  SessionAdminListQuerySchema,
} from "./session-device-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const MANAGE = requirePermission(SESSIONS_MANAGE_PERMISSION) as PreHandler;
const STEP_UP = requireStepUp(SESSIONS_REVOKE_STEP_UP_KEY) as PreHandler;

export interface SessionDeviceRouteDeps {
  readonly service: SessionDeviceService;
}

function actorOf(request: FastifyRequest): SessionDeviceActor {
  const ctx = request.context;
  const sessionId = ctx?.attributes?.sessionId;
  if (!ctx?.organizationId || !ctx.userId || typeof sessionId !== "string" || sessionId === "") {
    throw new UnauthorizedError();
  }
  return { organizationId: ctx.organizationId, userId: ctx.userId, sessionId };
}

// Self-service has no permission preHandler, so the authenticated, organisation-bound actor is the gate (a 401 otherwise, before any query).
const REQUIRE_ACTOR: PreHandler = async (request) => {
  actorOf(request);
};

export function registerSessionDeviceRoutes(
  app: FastifyInstance,
  deps: SessionDeviceRouteDeps,
): void {
  const { service } = deps;

  app.get(
    "/api/v1/devices",
    {
      preHandler: [REQUIRE_ACTOR],
      schema: { response: { 200: DeviceListResponseSchema } },
      config: {
        auditRead: {
          none: "the caller's own session list (coarse label, times, push flag); no patient data and no secret",
        },
      },
    },
    async (request, reply) =>
      reply.header("Cache-Control", "no-store").send(await service.listOwn(actorOf(request))),
  );

  app.delete(
    "/api/v1/devices/:id",
    {
      preHandler: [REQUIRE_ACTOR],
      schema: { response: { 200: DeviceRevokeResponseSchema } },
    },
    async (request, reply) => {
      const { id } = parse(DeviceParamsSchema, request.params);
      return reply
        .header("Cache-Control", "no-store")
        .send(await service.revokeOwn(actorOf(request), id));
    },
  );

  app.get(
    "/api/v1/messaging/governance/sessions",
    {
      preHandler: [MANAGE],
      schema: { response: { 200: DeviceListResponseSchema } },
      config: {
        auditRead: {
          none: "another user's session list for a security officer (coarse label, times, push flag); no patient data and no secret; the read is audited as m36.session.admin_listed",
        },
      },
    },
    async (request, reply) => {
      const { user_id } = parse(SessionAdminListQuerySchema, request.query);
      return reply
        .header("Cache-Control", "no-store")
        .send(await service.listForUser(actorOf(request), user_id));
    },
  );

  app.delete(
    "/api/v1/messaging/governance/sessions/:id",
    {
      preHandler: [MANAGE, STEP_UP],
      schema: { response: { 200: DeviceRevokeResponseSchema } },
    },
    async (request, reply) => {
      const { id } = parse(DeviceParamsSchema, request.params);
      return reply
        .header("Cache-Control", "no-store")
        .send(await service.revokeForUser(actorOf(request), id));
    },
  );
}
