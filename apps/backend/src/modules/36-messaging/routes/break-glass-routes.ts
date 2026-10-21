// apps/backend/src/modules/36-messaging/routes/break-glass-routes.ts - WP 5.8 (ADR-0087, PROPOSED): break-glass, a self-requested, time-limited,
// read-only grant on ONE channel that is always reviewed afterwards.
//
//   POST /api/v1/messaging/break-glass                      open a grant   (messaging.break_glass.invoke + a fresh step-up + the tenant flag)
//   GET  /api/v1/messaging/break-glass/mine                 my grants      (messaging.break_glass.invoke)
//   POST /api/v1/messaging/break-glass/:id/end              end a grant    (the holder, or a reviewer; no step-up)
//   GET  /api/v1/messaging/break-glass/reviews              the queue      (messaging.break_glass.review)
//   GET  /api/v1/messaging/break-glass/reviews/:id          one review + its audited reads (messaging.break_glass.review; read-audited)
//   POST /api/v1/messaging/break-glass/reviews/:id/complete complete it    (messaging.break_glass.review; never the grantee's own)
//
// The tenant flag `messaging.break_glass` gates ONLY the opening of a grant (off => the uniform 404, and before the step-up is asked for).
// Ending a grant and reviewing one never depend on it: accountability for a grant that exists must not stall because the feature was switched
// off. Org and user are the server-side request context, never the body. Nothing returned is a message body; the justification and a review
// note are reviewer-only text returned by the review routes alone.
import { requirePermission, requireStepUp, resolveActorPermissions } from "@chartwarden/auth";
import {
  BREAK_GLASS_INVOKE_STEP_UP_KEY,
  ForbiddenError,
  MESSAGING_BREAK_GLASS_INVOKE_PERMISSION,
  MESSAGING_BREAK_GLASS_REVIEW_PERMISSION,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BreakGlassActor, BreakGlassService } from "../break-glass/break-glass-service";
import {
  BreakGlassIdParamsSchema,
  CompleteReviewBodySchema,
  CreateBreakGlassBodySchema,
  GrantListResponseSchema,
  GrantResponseSchema,
  ListReviewsQuerySchema,
  ReviewDetailResponseSchema,
  ReviewListResponseSchema,
} from "./break-glass-typebox";
import { parse } from "./messaging-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const INVOKE = requirePermission(MESSAGING_BREAK_GLASS_INVOKE_PERMISSION) as PreHandler;
const REVIEW = requirePermission(MESSAGING_BREAK_GLASS_REVIEW_PERMISSION) as PreHandler;
const INVOKE_STEP_UP = requireStepUp(BREAK_GLASS_INVOKE_STEP_UP_KEY) as PreHandler;

export interface BreakGlassRouteDeps {
  readonly service: BreakGlassService;
}

function actorOf(request: FastifyRequest): BreakGlassActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

export function registerBreakGlassRoutes(app: FastifyInstance, deps: BreakGlassRouteDeps): void {
  const { service } = deps;
  const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store");

  /** Off => the uniform 404, before the step-up is asked for. */
  const FLAG_ON: PreHandler = async (request) => {
    const { organizationId } = actorOf(request);
    if (!(await service.isEnabled(organizationId))) {
      // The same body every other refusal to open a grant gets, so the flag is not readable from the answer.
      const channelId = (request.body as { channelId?: unknown } | null)?.channelId;
      throw new NotFoundError("channel", typeof channelId === "string" ? channelId : "");
    }
  };
  /** Ending: the holder (invoke) or a reviewer (review); either key suffices, and the service scopes the grant. */
  const END: PreHandler = async (request) => {
    const ctx = request.context;
    if (!ctx?.organizationId) throw new UnauthorizedError();
    const granted = await resolveActorPermissions(ctx);
    if (
      !granted.has(MESSAGING_BREAK_GLASS_INVOKE_PERMISSION) &&
      !granted.has(MESSAGING_BREAK_GLASS_REVIEW_PERMISSION)
    ) {
      throw new ForbiddenError(
        `requires permission '${MESSAGING_BREAK_GLASS_INVOKE_PERMISSION}' or '${MESSAGING_BREAK_GLASS_REVIEW_PERMISSION}'`,
      );
    }
  };

  app.post(
    "/api/v1/messaging/break-glass",
    {
      preHandler: [INVOKE, FLAG_ON, INVOKE_STEP_UP],
      schema: { response: { 201: GrantResponseSchema } },
    },
    async (request, reply) => {
      // The shared body coercion rounds a fractional number to an integer; a duration must be given as a whole number of minutes.
      const rawMinutes = (request.body as { durationMinutes?: unknown } | null)?.durationMinutes;
      if (rawMinutes !== undefined && !Number.isInteger(rawMinutes)) {
        throw new ValidationError("request validation failed", [
          { field: "durationMinutes", code: "INVALID", message: "a whole number of minutes" },
        ]);
      }
      const body = parse(CreateBreakGlassBodySchema, request.body);
      return noStore(reply)
        .code(201)
        .send(await service.create(actorOf(request), body));
    },
  );

  app.get(
    "/api/v1/messaging/break-glass/mine",
    {
      preHandler: [INVOKE],
      schema: { response: { 200: GrantListResponseSchema } },
      config: {
        auditRead: {
          none: "The caller's own grant metadata: ids, the channel kind, a closed reason code and instants. No patient, no name, no message and no free text",
        },
      },
    },
    async (request, reply) =>
      noStore(reply).send({ grants: await service.listMine(actorOf(request)) }),
  );

  app.post(
    "/api/v1/messaging/break-glass/:id/end",
    {
      preHandler: [requireUuidParams("id"), END],
      schema: { response: { 200: GrantResponseSchema } },
    },
    async (request, reply) => {
      const { id } = parse(BreakGlassIdParamsSchema, request.params);
      const canEndAny = (await resolveActorPermissions(request.context)).has(
        MESSAGING_BREAK_GLASS_REVIEW_PERMISSION,
      );
      return noStore(reply).send(await service.end(actorOf(request), id, { canEndAny }));
    },
  );

  app.get(
    "/api/v1/messaging/break-glass/reviews",
    {
      preHandler: [REVIEW],
      schema: { response: { 200: ReviewListResponseSchema } },
      config: { auditRead: { resourceKind: "message_break_glass_review", list: true } },
    },
    async (request, reply) => {
      const q = parse(ListReviewsQuerySchema, request.query);
      const reviews = await service.listReviews(actorOf(request), {
        status: q.status ?? "pending",
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      });
      return noStore(reply).send({ reviews });
    },
  );

  app.get(
    "/api/v1/messaging/break-glass/reviews/:id",
    {
      preHandler: [requireUuidParams("id"), REVIEW],
      schema: { response: { 200: ReviewDetailResponseSchema } },
      config: { auditRead: { resourceKind: "message_break_glass_review", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const { id } = parse(BreakGlassIdParamsSchema, request.params);
      return noStore(reply).send(await service.reviewDetail(actorOf(request), id));
    },
  );

  app.post(
    "/api/v1/messaging/break-glass/reviews/:id/complete",
    {
      preHandler: [requireUuidParams("id"), REVIEW],
      schema: { response: { 200: ReviewDetailResponseSchema } },
    },
    async (request, reply) => {
      const { id } = parse(BreakGlassIdParamsSchema, request.params);
      const body = parse(CompleteReviewBodySchema, request.body);
      return noStore(reply).send(await service.completeReview(actorOf(request), id, body));
    },
  );
}
