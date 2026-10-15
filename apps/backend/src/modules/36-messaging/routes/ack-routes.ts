// apps/backend/src/modules/36-messaging/routes/ack-routes.ts - WP 4.2 acknowledgment requests (ADR-0069).
//
//   POST /api/v1/messaging/escalations                        ask one qualified colleague to respond to a message the caller wrote
//                                                              (messaging.send + messaging.urgent.send + Idempotency-Key + rate limit)
//   GET  /api/v1/messaging/escalations/:id                    one request + its history           (messaging.read; the channel must be visible)
//   GET  /api/v1/messaging/channels/:id/escalations           the requests of one channel          (messaging.read + channel_visibility)
//   POST /api/v1/messaging/escalations/:id/acknowledge        the assignee takes clinical responsibility (messaging.urgent.receive)
//   POST /api/v1/messaging/escalations/:id/reassign           the sender or assignee names someone else (messaging.read; rate limit)
//   POST /api/v1/messaging/escalations/:id/resolve            the assignee closes it after acknowledging (messaging.urgent.receive)
//
// Acknowledgment is an explicit POST by the assigned, still-qualified user. No GET, no read receipt, no reaction and no deep-link
// open ever writes here. The tenant flag `messaging.ack_requests` gates CREATING a request (off => the uniform 404); a request that
// already exists can always be settled, because stranding an open safety item would be worse than the flag being a hard off. A missing,
// malformed, other-tenant or hidden-channel id is ONE 404. Org and actor are always the request context. No timers, tiers or paging.
import { requirePermission } from "@wardenx/auth";
import {
  NotFoundError,
  URGENT_RECEIVE_PERMISSION,
  URGENT_SEND_PERMISSION,
  UnauthorizedError,
} from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AckActorRef, AckService } from "../ack-requests/ack-service";
import {
  AckParamsSchema,
  CreateAckBodySchema,
  EmptyAckBodySchema,
  ReassignAckBodySchema,
} from "./ack-typebox";
import { ChannelParamsSchema, parse } from "./messaging-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AckRouteDeps {
  readonly service: AckService;
  /** Per-user / per-org / per-pair limiter (fail closed) on the two routes that notify somebody. */
  readonly rateLimit?: PreHandler;
}

/** The guards `registerMessagingRoutes` already built (passed in to avoid an import cycle). */
export interface AckRouteGuards {
  readonly read: PreHandler;
  readonly viewChannel: PreHandler;
  readonly send: PreHandler;
  readonly requireIdempotencyKey: PreHandler;
}

const OFF = async (): Promise<never> => {
  throw new NotFoundError("escalation");
};

/** Used when the boot supplies none: every route answers the uniform 404 (nothing exists to settle). */
export const DISABLED_ACK: AckRouteDeps = {
  service: {
    create: OFF,
    createForUrgentSend: OFF,
    get: OFF,
    listForChannel: OFF,
    acknowledge: OFF,
    reassign: OFF,
    resolve: OFF,
  },
};

function actorOf(request: FastifyRequest): AckActorRef {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { orgId: ctx.organizationId, userId: ctx.userId };
}

const PATIENT_AUDIT = {
  resourceKind: "message_acknowledgment_request",
  resourceIdPayloadPath: "request.id",
  patientIdPayloadPath: "request.patient_id",
} as const;

export function registerAckRoutes(
  app: FastifyInstance,
  deps: AckRouteDeps,
  guards: AckRouteGuards,
): void {
  const { service, rateLimit } = deps;
  const limited = rateLimit ? [rateLimit] : [];
  const urgentSend = requirePermission(URGENT_SEND_PERMISSION) as PreHandler;
  const urgentReceive = requirePermission(URGENT_RECEIVE_PERMISSION) as PreHandler;
  // A malformed id is the same 404 a missing request gets (never a uuid-cast 500).
  const idParam: PreHandler = async (request) => {
    parseOr404(request.params);
  };
  const parseOr404 = (params: unknown): string => {
    try {
      return parse(AckParamsSchema, params).id;
    } catch {
      throw new NotFoundError("escalation");
    }
  };

  app.post(
    "/api/v1/messaging/escalations",
    {
      preHandler: [guards.send, urgentSend, guards.requireIdempotencyKey, ...limited],
      config: { auditRead: PATIENT_AUDIT },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const body = parse(CreateAckBodySchema, request.body);
      const result = await service.create(actor, {
        messageId: body.message_id,
        assigneeUserId: body.assigned_user_id,
      });
      return reply.code(result.created ? 201 : 200).send(result);
    },
  );

  app.get(
    "/api/v1/messaging/escalations/:id",
    {
      preHandler: [idParam, guards.read],
      config: {
        auditRead: {
          resourceKind: "message_acknowledgment_request",
          resourceIdParam: "id",
          patientIdPayloadPath: "request.patient_id",
        },
      },
    },
    async (request) => service.get(actorOf(request), parseOr404(request.params)),
  );

  app.get(
    "/api/v1/messaging/channels/:id/escalations",
    {
      preHandler: [requireUuidParams("id"), guards.read, guards.viewChannel],
      config: { auditRead: { resourceKind: "channel", resourceIdParam: "id" } },
    },
    async (request) => {
      const { id } = parse(ChannelParamsSchema, request.params);
      return service.listForChannel(actorOf(request), id);
    },
  );

  app.post(
    "/api/v1/messaging/escalations/:id/acknowledge",
    { preHandler: [idParam, guards.read, urgentReceive], config: { auditRead: PATIENT_AUDIT } },
    async (request) => {
      parse(EmptyAckBodySchema, request.body ?? {});
      return service.acknowledge(actorOf(request), parseOr404(request.params));
    },
  );

  app.post(
    "/api/v1/messaging/escalations/:id/reassign",
    { preHandler: [idParam, guards.read, ...limited], config: { auditRead: PATIENT_AUDIT } },
    async (request) => {
      const body = parse(ReassignAckBodySchema, request.body);
      return service.reassign(actorOf(request), parseOr404(request.params), body.assigned_user_id);
    },
  );

  app.post(
    "/api/v1/messaging/escalations/:id/resolve",
    { preHandler: [idParam, guards.read, urgentReceive], config: { auditRead: PATIENT_AUDIT } },
    async (request) => {
      parse(EmptyAckBodySchema, request.body ?? {});
      return service.resolve(actorOf(request), parseOr404(request.params));
    },
  );
}
