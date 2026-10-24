// apps/backend/src/modules/36-messaging/routes/alarm-ingest-routes.ts - WP 6.10 (ADR-0101, PROPOSED): alarm ingest, WATCH ONLY.
//
// STAFF (a workforce session; messaging.alarm_ingest.manage):
//   GET  /api/v1/messaging/alarm-sources                    list    (permission; never depends on the flag; the secret is never readable)
//   POST /api/v1/messaging/alarm-sources                    create  (permission + the tenant flag + a fresh step-up); the secret is returned ONCE
//   POST /api/v1/messaging/alarm-sources/:id/rotate-secret  rotate  (permission + flag + fresh step-up); the old secret stops verifying at once
//   POST /api/v1/messaging/alarm-sources/:id/disable        disable (permission + fresh step-up; never depends on the flag); one way
//
// INBOUND (NOT a user session: a machine proving a per-source HMAC; ADR-0101 D2). One refusal body for everything up to a wrong signature.
//   POST /api/v1/messaging/alarm-ingest/events   { eventId, alarmKind, severity?, occurredAt? }  -> 202 { status, outcome }
// The route reads three headers, all registered in scripts/check-request-header-auth.ts: x-wx-key-id (names WHICH secret to try; verified by the
// signature that follows), x-wx-signature (the HMAC itself, verified) and x-wx-timestamp (replay freshness only, and it is inside the signed text).
// The raw body is kept as a string for the HMAC and capped at ALARM_INGEST_MAX_BODY_BYTES by the framework before the handler runs.
import { requirePermission, requireStepUp } from "@chartwarden/auth";
import {
  ALARM_INGEST_MANAGE_PERMISSION,
  ALARM_INGEST_MANAGE_STEP_UP_KEY,
  ALARM_INGEST_MAX_BODY_BYTES,
  NotFoundError,
  UnauthorizedError,
} from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AlarmIngestService } from "../alarm-ingest/alarm-ingest-service";
import {
  AlarmIngestAcceptedResponseSchema,
  AlarmSourceCredentialResponseSchema,
  AlarmSourceIdParamsSchema,
  AlarmSourceListResponseSchema,
  AlarmSourceResponseSchema,
  CreateAlarmSourceBodySchema,
} from "./alarm-ingest-typebox";
import { parse } from "./messaging-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const MANAGE = requirePermission(ALARM_INGEST_MANAGE_PERMISSION) as PreHandler;
const MANAGE_STEP_UP = requireStepUp(ALARM_INGEST_MANAGE_STEP_UP_KEY) as PreHandler;

export interface AlarmIngestRouteDeps {
  readonly service: AlarmIngestService;
  /**
   * ADR-0096 D17, reused: false => the INBOUND route is not mounted (the framework's 404) because per-address budgets would be keyed on a proxy
   * address. Staff list and disable are always mounted; create and rotate answer 503 through the service. Default true.
   */
  readonly inboundRoute?: boolean | undefined;
}

function staffOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

export function registerAlarmIngestRoutes(app: FastifyInstance, deps: AlarmIngestRouteDeps): void {
  const { service } = deps;
  const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store");

  /** Off => the uniform 404, before the step-up is asked for. */
  const FLAG_ON: PreHandler = async (request) => {
    if (!(await service.isEnabled(staffOf(request).organizationId)))
      throw new NotFoundError("alarm source");
  };

  app.get(
    "/api/v1/messaging/alarm-sources",
    {
      preHandler: [MANAGE],
      schema: { response: { 200: AlarmSourceListResponseSchema } },
      config: {
        auditRead: {
          none: "Source rows: ids, a staff-chosen name, the mapping codes and counts of recent events by outcome. No secret, no cipher, no alarm detail, no patient",
        },
      },
    },
    async (request, reply) =>
      noStore(reply).send({ sources: await service.list(staffOf(request)) }),
  );

  app.post(
    "/api/v1/messaging/alarm-sources",
    {
      preHandler: [MANAGE, FLAG_ON, MANAGE_STEP_UP],
      schema: { response: { 201: AlarmSourceCredentialResponseSchema } },
    },
    async (request, reply) => {
      const body = parse(CreateAlarmSourceBodySchema, request.body);
      return noStore(reply).code(201).send(await service.create(staffOf(request), body));
    },
  );

  app.post(
    "/api/v1/messaging/alarm-sources/:id/rotate-secret",
    {
      preHandler: [requireUuidParams("id"), MANAGE, FLAG_ON, MANAGE_STEP_UP],
      schema: { response: { 200: AlarmSourceCredentialResponseSchema } },
    },
    async (request, reply) => {
      const { id } = parse(AlarmSourceIdParamsSchema, request.params);
      return noStore(reply).send(await service.rotate(staffOf(request), id));
    },
  );

  app.post(
    "/api/v1/messaging/alarm-sources/:id/disable",
    {
      preHandler: [requireUuidParams("id"), MANAGE, MANAGE_STEP_UP],
      schema: { response: { 200: AlarmSourceResponseSchema } },
    },
    async (request, reply) => {
      const { id } = parse(AlarmSourceIdParamsSchema, request.params);
      return noStore(reply).send(await service.disable(staffOf(request), id));
    },
  );

  if (deps.inboundRoute === false) return;

  // The inbound scope keeps the EXACT bytes (the HMAC is over them) instead of Fastify's parsed object. Encapsulated: no other route is affected.
  // The scope parameter is deliberately named `app`: the OpenAPI route scanner (scripts/openapi/scan-routes.ts) finds routes by the literal receiver name.
  void app.register(async (app) => {
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser(
      "application/json",
      { parseAs: "string", bodyLimit: ALARM_INGEST_MAX_BODY_BYTES },
      (_request, body, done) => done(null, body),
    );
    app.post(
      "/api/v1/messaging/alarm-ingest/events",
      {
        bodyLimit: ALARM_INGEST_MAX_BODY_BYTES,
        schema: { response: { 202: AlarmIngestAcceptedResponseSchema } },
      },
      async (request, reply) => {
        const result = await service.ingest({
          keyId: request.headers["x-wx-key-id"],
          timestamp: request.headers["x-wx-timestamp"],
          signature: request.headers["x-wx-signature"],
          rawBody: request.body,
          ip: request.ip || "unknown",
        });
        return noStore(reply).code(202).send(result);
      },
    );
  });
}
