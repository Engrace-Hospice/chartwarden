// apps/backend/src/modules/36-messaging/routes/role-send-routes.ts - ADR-0081 (PROPOSED): role-based send ("message the on-call RN").
//
//   GET  /api/v1/messaging/channels/:id/role-send/resolution?role&patient_id   who covers the role NOW (the sender confirms this person)
//        (messaging.read + messaging.urgent.send + messaging.oncall.send + channel_visibility + the chart-read gate on patient_id)
//   POST /api/v1/messaging/channels/:id/role-send                              send an urgent message to the CONFIRMED covering person
//        (messaging.send + messaging.urgent.send + messaging.oncall.send + channel_visibility + the chart-read gate + Idempotency-Key + rate limit)
//
// The patient gate is the SAME one the on-call directory uses (`buildPatientGate`: patient.read + caseload_or_scope, no break-glass, then
// the org-scoped existence check, one identical 404). The send is the ordinary urgent send; the service re-resolves tier 1 at send time
// and refuses (409) when the confirmed person no longer covers, and refuses (422) a gap or an unconnected roster with the telephone
// procedure wording. The tenant flag `messaging.role_send` off is the uniform 404 (decided in the service, before any router call). The
// resolution is never cached. Org and actor are always the request context.
import { requirePermission } from "@chartwarden/auth";
import {
  NotFoundError,
  type OnCallDirectoryRole,
  ROLE_SEND_PERMISSION,
  URGENT_SEND_PERMISSION,
  UnauthorizedError,
} from "@chartwarden/types";
import type { RichBody } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RoleSendService } from "../oncall-directory/role-send-service";
import type { ValidateLinks } from "../urgent/urgent-service";
import { ChannelParamsSchema, parse } from "./messaging-typebox";
import { type OnCallRouteDeps, buildPatientGate } from "./oncall-routes";
import {
  RoleSendResolutionQuerySchema,
  RoleSendResolutionResponseSchema,
  RoleSendResponseSchema,
  SendRoleMessageBodySchema,
} from "./role-send-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface RoleSendRouteDeps {
  readonly service: RoleSendService;
  readonly patientExists: OnCallRouteDeps["patientExists"];
  /** The urgent route's limiter (per user, per org, per sender-recipient pair; fail closed), reused so the budgets are shared. */
  readonly rateLimit?: PreHandler;
}

/** The guards `registerMessagingRoutes` already built for the urgent routes. */
export interface RoleSendRouteGuards {
  readonly read: PreHandler;
  readonly viewChannel: PreHandler;
  readonly send: PreHandler;
  readonly sendToChannel: PreHandler;
  readonly requireIdempotencyKey: PreHandler;
  readonly validateLinks: (
    request: FastifyRequest,
    richBody: RichBody | undefined,
  ) => ReturnType<ValidateLinks>;
}

/** Used when the boot supplies none: the uniform 404. */
export const DISABLED_ROLE_SEND: RoleSendRouteDeps = {
  patientExists: async () => false,
  service: {
    resolve: async () => {
      throw new NotFoundError("channel");
    },
    send: async () => {
      throw new NotFoundError("channel");
    },
  },
};

function actorOf(request: FastifyRequest): { orgId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { orgId: ctx.organizationId, userId: ctx.userId };
}

export function registerRoleSendRoutes(
  app: FastifyInstance,
  deps: RoleSendRouteDeps,
  guards: RoleSendRouteGuards,
): void {
  const urgentSend = requirePermission(URGENT_SEND_PERMISSION) as PreHandler;
  const roleSend = requirePermission(ROLE_SEND_PERMISSION) as PreHandler;
  const limited = deps.rateLimit ? [deps.rateLimit] : [];

  // A malformed query/body is a 422 BEFORE the patient gate sees it (the predicate must never get a non-uuid).
  const validQuery: PreHandler = async (request) => {
    parse(RoleSendResolutionQuerySchema, request.query);
  };
  const validBody: PreHandler = async (request) => {
    parse(SendRoleMessageBodySchema, request.body);
  };
  const [queryScope, queryExists] = buildPatientGate(
    (request) => (request.query as { patient_id?: unknown } | undefined)?.patient_id,
    deps.patientExists,
  );
  const [bodyScope, bodyExists] = buildPatientGate(
    (request) => (request.body as { patient_id?: unknown } | undefined)?.patient_id,
    deps.patientExists,
  );

  app.get(
    "/api/v1/messaging/channels/:id/role-send/resolution",
    {
      preHandler: [
        requireUuidParams("id"),
        guards.read,
        urgentSend,
        roleSend,
        guards.viewChannel,
        validQuery,
        queryScope,
        queryExists,
      ],
      schema: { response: { 200: RoleSendResolutionResponseSchema } },
      // The resolution discloses who covers a role for this patient: read-audited against the patient.
      config: {
        auditRead: {
          resourceKind: "oncall_role_resolution",
          resourceIdParam: "id",
          patientIdQueryParam: "patient_id",
          fields: ["role", "resolved_person"],
        },
      },
    },
    async (request, reply) => {
      const { id } = parse(ChannelParamsSchema, request.params);
      const q = parse(RoleSendResolutionQuerySchema, request.query);
      const out = await deps.service.resolve(actorOf(request), {
        channelId: id,
        patientId: q.patient_id,
        role: q.role as OnCallDirectoryRole,
      });
      return reply.header("Cache-Control", "no-store").send(out);
    },
  );

  app.post(
    "/api/v1/messaging/channels/:id/role-send",
    {
      preHandler: [
        requireUuidParams("id"),
        guards.send,
        urgentSend,
        roleSend,
        guards.sendToChannel,
        validBody,
        bodyScope,
        bodyExists,
        guards.requireIdempotencyKey,
        ...limited,
      ],
      schema: { response: { 200: RoleSendResponseSchema, 201: RoleSendResponseSchema } },
      // Who addressed which role for which patient: the message, the patient and (in the response) the resolved person.
      config: {
        auditRead: {
          resourceKind: "message",
          resourceIdPayloadPath: "message_id",
          patientIdPayloadPath: "patient_id",
          fields: ["role", "resolved_person"],
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const body = parse(SendRoleMessageBodySchema, request.body);
      const result = await deps.service.send(
        actor,
        {
          channelId: id,
          patientId: body.patient_id,
          role: body.role as OnCallDirectoryRole,
          recipientUserId: body.recipient_user_id,
          bodyDoc: body.body_doc,
          clientMessageId: body.client_message_id,
          correlationId: request.context.correlationId,
        },
        (richBody) => guards.validateLinks(request, richBody),
      );
      return reply.code(result.created ? 201 : 200).send(result);
    },
  );
}
