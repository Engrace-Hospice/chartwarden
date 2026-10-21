// apps/backend/src/modules/36-messaging/routes/promotion-routes.ts - WP 3.7 chart promotion (ADR-0063).
//
//   POST /api/v1/messaging/channels/:id/messages/:messageId/chart-promotions   propose a message for the chart
//                                                                (messaging.send + messaging.promote + patient.read)
//   GET  /api/v1/messaging/channels/:id/messages/:messageId/chart-promotions   proposals on that message  (messaging.read + patient.read)
//   GET  /api/v1/messaging/chart-promotions?status&limit                       my proposals                 (messaging.read)
//   GET  /api/v1/messaging/chart-promotions/:promotionId                       one proposal                 (messaging.read + patient.read)
//   POST /api/v1/messaging/chart-promotions/:promotionId/withdraw              take it back (requester only) (messaging.send + messaging.promote + patient.read)
//
// The tenant flag `messaging.promotions` gates every route: off => the uniform 404 on every single-resource, per-message and
// write route, and the list answers 200 `{enabled:false,promotions:[]}` so the web can hide the UI. Org and actor are
// always the request context. Reader rules (requester, or a channel viewer who passes the Part 2 gate), the target
// allow-list and the state machine live in the service; a missing proposal, a hidden channel, a Part 2 denial and a
// non-reader are ONE 404. M36 never decides accepted/rejected: that arrives from the owning module as an outbox event.
// No `Idempotency-Key`: idempotency is the partial unique index (one proposed request per message and target), so no
// request header is read here.
import { requirePermission } from "@chartwarden/auth";
import { NotFoundError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PromotionActorRef, PromotionService } from "../promotions/promotion-service";
import { ThreadParamsSchema, parse } from "./messaging-typebox";
import {
  ListPromotionsQuerySchema,
  PromotionParamsSchema,
  RequestPromotionBodySchema,
} from "./promotion-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export const PROMOTION_LIST_DEFAULTS = { status: "active", limit: 50 } as const;

export interface PromotionRouteDeps {
  /** The tenant flag `messaging.promotions`. A throw reads as off (fail closed). */
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly service: PromotionService;
}

/** The channel guards `registerMessagingRoutes` already built (passed in to avoid an import cycle). */
export interface PromotionRouteGuards {
  readonly read: PreHandler;
  readonly send: PreHandler;
  readonly sendToChannel: PreHandler;
}

const OFF = async (): Promise<never> => {
  throw new Error("chart promotions are not bound");
};

/** Used when the boot supplies none: flag off, so every route 404s and the list answers disabled. */
export const DISABLED_PROMOTIONS: PromotionRouteDeps = {
  isEnabled: async () => false,
  service: {
    request: OFF,
    listForMessage: OFF,
    listMine: OFF,
    get: OFF,
    withdraw: OFF,
    applyOutcome: OFF,
  },
};

const notFound = (): NotFoundError => new NotFoundError("chart_promotion_request");

function actorOf(request: FastifyRequest): PromotionActorRef {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { orgId: ctx.organizationId, userId: ctx.userId };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed promotion id is the same 404 a missing proposal gets (never a uuid-cast 500). */
const promotionIdParam: PreHandler = async (request) => {
  const promotionId = (request.params as { promotionId?: unknown } | undefined)?.promotionId;
  if (typeof promotionId !== "string" || !UUID.test(promotionId)) throw notFound();
};

export function registerPromotionRoutes(
  app: FastifyInstance,
  deps: PromotionRouteDeps,
  guards: PromotionRouteGuards,
): void {
  const { service } = deps;
  const PATIENT_READ = requirePermission("patient.read") as PreHandler;
  const PROMOTE = requirePermission("messaging.promote") as PreHandler;
  const flagOn = (orgId: string): Promise<boolean> => deps.isEnabled(orgId).catch(() => false);
  const requireFlag = async (actor: PromotionActorRef): Promise<void> => {
    if (!(await flagOn(actor.orgId))) throw notFound();
  };
  const channelParams = requireUuidParams("id", "messageId");
  // A proposal names its patient: every route that answers one re-checks patient.read, and the reply is read-audited
  // against that patient (a POST is only GOVERNED when it declares this config).
  const postAudit = {
    auditRead: {
      resourceKind: "chart_promotion_request",
      resourceIdPayloadPath: "promotion.id",
      patientIdPayloadPath: "promotion.patient_id",
    },
  } as const;

  app.post(
    "/api/v1/messaging/channels/:id/messages/:messageId/chart-promotions",
    {
      preHandler: [channelParams, guards.send, guards.sendToChannel, PROMOTE, PATIENT_READ],
      config: postAudit,
    },
    async (request, reply) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      const p = parse(ThreadParamsSchema, request.params);
      const body = parse(RequestPromotionBodySchema, request.body);
      const result = await service.request(actor, {
        channelId: p.id,
        messageId: p.messageId,
        targetModule: body.target_module,
        targetKind: body.target_kind,
        suggestedTargetRef: body.suggested_target_ref ?? null,
      });
      return reply.code(result.created ? 201 : 200).send(result);
    },
  );

  app.get(
    "/api/v1/messaging/channels/:id/messages/:messageId/chart-promotions",
    {
      preHandler: [channelParams, guards.read, PATIENT_READ],
      config: {
        auditRead: {
          resourceKind: "chart_promotion_request",
          list: true,
          patientIdPayloadPath: "promotions.0.patient_id",
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      const p = parse(ThreadParamsSchema, request.params);
      return { promotions: await service.listForMessage(actor, p.id, p.messageId) };
    },
  );

  // Static paths are registered before `/chart-promotions/:promotionId`.
  app.get(
    "/api/v1/messaging/chart-promotions",
    {
      preHandler: [guards.read],
      config: { auditRead: { resourceKind: "chart_promotion_request", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      if (!(await flagOn(actor.orgId))) return { enabled: false, promotions: [] };
      const q = parse(ListPromotionsQuerySchema, request.query);
      const promotions = await service.listMine(actor, {
        state: q.status ?? PROMOTION_LIST_DEFAULTS.status,
        limit: q.limit ?? PROMOTION_LIST_DEFAULTS.limit,
      });
      return { enabled: true, promotions };
    },
  );

  app.get(
    "/api/v1/messaging/chart-promotions/:promotionId",
    {
      preHandler: [promotionIdParam, guards.read, PATIENT_READ],
      config: {
        auditRead: {
          resourceKind: "chart_promotion_request",
          resourceIdParam: "promotionId",
          patientIdPayloadPath: "promotion.patient_id",
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      const { promotionId } = parse(PromotionParamsSchema, request.params);
      return { promotion: await service.get(actor, promotionId) };
    },
  );

  app.post(
    "/api/v1/messaging/chart-promotions/:promotionId/withdraw",
    {
      preHandler: [promotionIdParam, guards.send, PROMOTE, PATIENT_READ],
      config: postAudit,
    },
    async (request) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      const { promotionId } = parse(PromotionParamsSchema, request.params);
      return { promotion: await service.withdraw(actor, promotionId) };
    },
  );
}
