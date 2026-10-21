// apps/backend/src/modules/36-messaging/routes/urgent-routes.ts - WP 4.1 "Urgent clinical" (ADR-0068).
//
//   POST /api/v1/messaging/channels/:id/urgent-messages          send an SBAR message to ONE qualified colleague, marked urgent
//                                                                (messaging.send + messaging.urgent.send + channel_visibility + Idempotency-Key)
//   GET  /api/v1/messaging/channels/:id/urgent-messages/options  who can be chosen; flag state  (messaging.read + channel_visibility)
//
// The ONLY writer of `message.urgency`. It does not page, escalate or track a response from anyone, and the message text is never
// inspected. Flag off (`messaging.urgent_clinical` AND `messaging.sbar`): POST is the uniform 404; the options read answers
// 200 `{enabled:false}`. Org and actor are always the request context.
import { requirePermission } from "@chartwarden/auth";
import { NotFoundError, URGENT_SEND_PERMISSION, UnauthorizedError } from "@chartwarden/types";
import type { RichBody } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UrgentActorRef, UrgentService, ValidateLinks } from "../urgent/urgent-service";
import { ChannelParamsSchema, parse } from "./messaging-typebox";
import { SendUrgentMessageBodySchema } from "./urgent-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface UrgentRouteDeps {
  readonly service: UrgentService;
  /** WP 4.1: the per-user / per-org / per-pair limiter (fail closed), run after authorisation and before the send. */
  readonly rateLimit?: PreHandler;
}

/** The guards and link validator `registerMessagingRoutes` already built (passed in to avoid an import cycle). */
export interface UrgentRouteGuards {
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

/** Used when the boot supplies none: POST is the uniform 404 and the options read answers disabled. */
export const DISABLED_URGENT: UrgentRouteDeps = {
  service: {
    send: async () => {
      throw new NotFoundError("channel");
    },
    options: async () => ({ enabled: false }),
  },
};

function actorOf(request: FastifyRequest): UrgentActorRef {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { orgId: ctx.organizationId, userId: ctx.userId };
}

export function registerUrgentRoutes(
  app: FastifyInstance,
  deps: UrgentRouteDeps,
  guards: UrgentRouteGuards,
): void {
  const { service, rateLimit } = deps;
  const urgentSend = requirePermission(URGENT_SEND_PERMISSION) as PreHandler;

  app.post(
    "/api/v1/messaging/channels/:id/urgent-messages",
    {
      preHandler: [
        requireUuidParams("id"),
        guards.send,
        urgentSend,
        guards.sendToChannel,
        guards.requireIdempotencyKey,
        ...(rateLimit ? [rateLimit] : []),
      ],
      config: {
        auditRead: {
          resourceKind: "message",
          resourceIdPayloadPath: "message_id",
          patientIdPayloadPath: "patient_id",
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const body = parse(SendUrgentMessageBodySchema, request.body);
      const result = await service.send(
        actor,
        {
          channelId: id,
          bodyDoc: body.body_doc,
          recipientUserId: body.recipient_user_id,
          clientMessageId: body.client_message_id,
          correlationId: request.context.correlationId,
        },
        (richBody) => guards.validateLinks(request, richBody),
      );
      return reply.code(result.created ? 201 : 200).send(result);
    },
  );

  app.get(
    "/api/v1/messaging/channels/:id/urgent-messages/options",
    {
      preHandler: [requireUuidParams("id"), guards.read, guards.viewChannel],
      config: {
        auditRead: {
          resourceKind: "channel",
          resourceIdParam: "id",
          patientIdPayloadPath: "patient_id",
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      return service.options(actor, id);
    },
  );
}
