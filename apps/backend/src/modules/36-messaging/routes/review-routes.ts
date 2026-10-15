// apps/backend/src/modules/36-messaging/routes/review-routes.ts - WP 3.8 lifecycle review queue (ADR-0065).
//
//   GET  /api/v1/messaging/review-items?state&limit                      the supervisor queue   (messaging.read + messaging.review + patient.read)
//   POST /api/v1/messaging/review-items/:reviewItemId/reassign           {to_user_id}           (same guards)
//   POST /api/v1/messaging/review-items/:reviewItemId/close              {reason}               (same guards)
//
// The tenant flag `messaging.tasks` gates the queue: off => the uniform 404 on both actions and `200 {enabled:false,
// items:[]}` on the list, so the web can hide the tab. Org and actor are always the request context. A missing, foreign,
// restricted (Part 2) or flag-off item is ONE 404. Nothing is ever deleted; no request header is read here.
//
// READ AUDIT: `list:true` records one aggregate event and IGNORES `patientIdsPayload` (the plugin's list branch never
// reads it), which would leave the patients this queue discloses out of the Section 164.528 accounting. So the list is
// audited as a multi-patient single read: one `messaging_review_item.viewed` event per distinct patient disclosed, all
// against the first item's id. A restricted row carries no patient id and is skipped by construction.
import { requirePermission } from "@wardenx/auth";
import { REVIEW_LIST_DEFAULT } from "@wardenx/messaging";
import { NotFoundError, UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ReviewActorRef, ReviewService } from "../review/review-service";
import { parse } from "./messaging-typebox";
import {
  CloseReviewBodySchema,
  ListReviewItemsQuerySchema,
  ReassignReviewBodySchema,
  ReviewParamsSchema,
} from "./review-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface ReviewRouteDeps {
  /** The tenant flag `messaging.tasks`. A throw reads as off (fail closed). */
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly service: ReviewService;
}

/** The channel guards `registerMessagingRoutes` already built (passed in to avoid an import cycle). */
export interface ReviewRouteGuards {
  readonly read: PreHandler;
  readonly send: PreHandler;
}

const OFF = async (): Promise<never> => {
  throw new Error("the review queue is not bound");
};

/** Used when the boot supplies none: flag off, so every route 404s and the list answers disabled. */
export const DISABLED_REVIEW: ReviewRouteDeps = {
  isEnabled: async () => false,
  service: { list: OFF, reassign: OFF, close: OFF },
};

const notFound = (): NotFoundError => new NotFoundError("messaging_review_item");

function actorOf(request: FastifyRequest): ReviewActorRef {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { orgId: ctx.organizationId, userId: ctx.userId };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed item id is the same 404 a missing item gets (never a uuid-cast 500). */
const reviewIdParam: PreHandler = async (request) => {
  const id = (request.params as { reviewItemId?: unknown } | undefined)?.reviewItemId;
  if (typeof id !== "string" || !UUID.test(id)) throw notFound();
};

export function registerReviewRoutes(
  app: FastifyInstance,
  deps: ReviewRouteDeps,
  guards: ReviewRouteGuards,
): void {
  const { service } = deps;
  const PATIENT_READ = requirePermission("patient.read") as PreHandler;
  const REVIEW = requirePermission("messaging.review") as PreHandler;
  const flagOn = (orgId: string): Promise<boolean> => deps.isEnabled(orgId).catch(() => false);
  const requireFlag = async (actor: ReviewActorRef): Promise<void> => {
    if (!(await flagOn(actor.orgId))) throw notFound();
  };
  // Every route answers patient labels, so each re-checks `patient.read` beside the dedicated queue permission.
  const readGuards = [guards.read, REVIEW, PATIENT_READ];
  const actionGuards = [reviewIdParam, guards.read, REVIEW, PATIENT_READ];
  const actionAudit = {
    auditRead: {
      resourceKind: "messaging_review_item",
      resourceIdParam: "reviewItemId",
      patientIdPayloadPath: "item.patient_id",
    },
  } as const;

  app.get(
    "/api/v1/messaging/review-items",
    {
      preHandler: readGuards,
      config: {
        auditRead: {
          resourceKind: "messaging_review_item",
          resourceIdPayloadPath: "items.0.id",
          patientIdsPayload: { path: "items", key: "patient_id" },
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      if (!(await flagOn(actor.orgId))) return { enabled: false, items: [] };
      const q = parse(ListReviewItemsQuerySchema, request.query);
      const items = await service.list(actor, {
        state: q.state ?? "open",
        limit: q.limit ?? REVIEW_LIST_DEFAULT,
      });
      return { enabled: true, items };
    },
  );

  app.post(
    "/api/v1/messaging/review-items/:reviewItemId/reassign",
    { preHandler: actionGuards, config: actionAudit },
    async (request) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      const { reviewItemId } = parse(ReviewParamsSchema, request.params);
      const body = parse(ReassignReviewBodySchema, request.body);
      return { item: await service.reassign(actor, reviewItemId, body.to_user_id) };
    },
  );

  app.post(
    "/api/v1/messaging/review-items/:reviewItemId/close",
    { preHandler: actionGuards, config: actionAudit },
    async (request) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      const { reviewItemId } = parse(ReviewParamsSchema, request.params);
      const body = parse(CloseReviewBodySchema, request.body);
      return { item: await service.close(actor, reviewItemId, body.reason) };
    },
  );
}
