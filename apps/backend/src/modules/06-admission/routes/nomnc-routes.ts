// apps/backend/src/modules/06-admission/routes/nomnc-routes.ts — milestone 10a NOMNC delivery + BFCC-QIO expedited
// review record-keeping. Every route hangs off the ADMISSION path, so the existing `admission.scope` ABAC predicate
// scopes it on `:id` with no new resolver (the election-addendum precedent); the service binds each notice / review /
// deadline id to that admission (one of another admission reads as 404). Nothing here blocks a discharge or sends
// anything: staff record facts and type deadlines.
//
//   GET    /api/v1/admissions/:id/nomnc                                           notice, history, review, deadlines, prompts
//   POST   /api/v1/admissions/:id/nomnc                                           record (optionally superseding the active one)
//   PATCH  /api/v1/admissions/:id/nomnc/:noticeId                                 acknowledgement / copy / delivery note
//   POST   /api/v1/admissions/:id/nomnc/:noticeId/withdraw
//   POST   /api/v1/admissions/:id/nomnc/:noticeId/expedited-review                open the QIO review (publishes opened)
//   POST   /api/v1/admissions/:id/nomnc/:noticeId/deadlines                       type an appeal-request / other deadline
//   PATCH  /api/v1/admissions/:id/expedited-reviews/:reviewId                     DENC / records facts, decision
//   POST   /api/v1/admissions/:id/expedited-reviews/:reviewId/withdraw
//   POST   /api/v1/admissions/:id/expedited-reviews/:reviewId/deadlines           type a DENC / records / decision deadline
//   PATCH  /api/v1/admissions/:id/expedited-deadlines/:deadlineId                 edit or satisfy
import { requireAbac, requirePermission } from "@chartwarden/auth";
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { admissionScopeAccessOf } from "../abac-predicates";
import type { NomncService } from "../nomnc/service";
import { IdParamsSchema, parse } from "./admission-typebox";
import {
  AddDeadlineSchema,
  DeadlineParamsSchema,
  DeadlineViewSchema,
  NoticeParamsSchema,
  NoticeViewSchema,
  NomncOverviewQuerySchema,
  NomncOverviewSchema,
  OpenReviewSchema,
  PatchDeadlineSchema,
  PatchNoticeSchema,
  PatchReviewSchema,
  RecordNoticeSchema,
  ReviewParamsSchema,
  ReviewViewSchema,
  WithdrawNoticeSchema,
  WithdrawReviewSchema,
} from "./nomnc-typebox";
import { ResourceNotFoundError } from "./service";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const NOMNC_READ = P("nomnc.read");
const NOMNC_RECORD = P("nomnc.record");
/** `admission.scope` on the path's admission id (404 on deny — the §2.2 existence non-leak). */
const scope = (action: string): PreHandler =>
  requireAbac(action, "admission.scope", {
    notFoundOnDeny: true,
    getTarget: (request) => ({
      ...(typeof request.params === "object" && request.params ? request.params : {}),
      access: admissionScopeAccessOf(action),
    }),
  }) as PreHandler;

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

export interface NomncRouteDeps {
  readonly service: NomncService;
}

export function registerNomncRoutes(app: FastifyInstance, deps: NomncRouteDeps): void {
  const { service } = deps;
  const write = { preHandler: [NOMNC_RECORD, scope("nomnc.record")] };

  app.get(
    "/api/v1/admissions/:id/nomnc",
    {
      preHandler: [NOMNC_READ, scope("nomnc.read")],
      schema: { response: { 200: NomncOverviewSchema } },
      config: { auditRead: { resourceKind: "nomnc_notice", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const { dischargeReason } = parse(NomncOverviewQuerySchema, request.query);
      const ov = await service.overview(organizationId, id, dischargeReason);
      if (!ov) throw new ResourceNotFoundError(id);
      return ov;
    },
  );

  app.post(
    "/api/v1/admissions/:id/nomnc",
    { ...write, schema: { response: { 201: NoticeViewSchema } } },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const body = parse(RecordNoticeSchema, request.body);
      const view = await service.recordNotice(organizationId, id, body, userId);
      return reply.code(201).send(view);
    },
  );

  app.patch(
    "/api/v1/admissions/:id/nomnc/:noticeId",
    { ...write, schema: { response: { 200: NoticeViewSchema } } },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id, noticeId } = parse(NoticeParamsSchema, request.params);
      return service.patchNotice(
        organizationId,
        id,
        noticeId,
        parse(PatchNoticeSchema, request.body),
        userId,
      );
    },
  );

  app.post(
    "/api/v1/admissions/:id/nomnc/:noticeId/withdraw",
    { ...write, schema: { response: { 200: NoticeViewSchema } } },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id, noticeId } = parse(NoticeParamsSchema, request.params);
      return service.withdrawNotice(
        organizationId,
        id,
        noticeId,
        parse(WithdrawNoticeSchema, request.body),
        userId,
      );
    },
  );

  app.post(
    "/api/v1/admissions/:id/nomnc/:noticeId/expedited-review",
    { ...write, schema: { response: { 201: ReviewViewSchema } } },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id, noticeId } = parse(NoticeParamsSchema, request.params);
      const view = await service.openReview(
        organizationId,
        id,
        noticeId,
        parse(OpenReviewSchema, request.body),
        userId,
      );
      return reply.code(201).send(view);
    },
  );

  app.post(
    "/api/v1/admissions/:id/nomnc/:noticeId/deadlines",
    { ...write, schema: { response: { 201: DeadlineViewSchema } } },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id, noticeId } = parse(NoticeParamsSchema, request.params);
      const view = await service.addNoticeDeadline(
        organizationId,
        id,
        noticeId,
        parse(AddDeadlineSchema, request.body),
        userId,
      );
      return reply.code(201).send(view);
    },
  );

  app.patch(
    "/api/v1/admissions/:id/expedited-reviews/:reviewId",
    { ...write, schema: { response: { 200: ReviewViewSchema } } },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id, reviewId } = parse(ReviewParamsSchema, request.params);
      return service.patchReview(
        organizationId,
        id,
        reviewId,
        parse(PatchReviewSchema, request.body),
        userId,
      );
    },
  );

  app.post(
    "/api/v1/admissions/:id/expedited-reviews/:reviewId/withdraw",
    { ...write, schema: { response: { 200: ReviewViewSchema } } },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id, reviewId } = parse(ReviewParamsSchema, request.params);
      return service.withdrawReview(
        organizationId,
        id,
        reviewId,
        parse(WithdrawReviewSchema, request.body),
        userId,
      );
    },
  );

  app.post(
    "/api/v1/admissions/:id/expedited-reviews/:reviewId/deadlines",
    { ...write, schema: { response: { 201: DeadlineViewSchema } } },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id, reviewId } = parse(ReviewParamsSchema, request.params);
      const view = await service.addReviewDeadline(
        organizationId,
        id,
        reviewId,
        parse(AddDeadlineSchema, request.body),
        userId,
      );
      return reply.code(201).send(view);
    },
  );

  app.patch(
    "/api/v1/admissions/:id/expedited-deadlines/:deadlineId",
    { ...write, schema: { response: { 200: DeadlineViewSchema } } },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id, deadlineId } = parse(DeadlineParamsSchema, request.params);
      return service.patchDeadline(
        organizationId,
        id,
        deadlineId,
        parse(PatchDeadlineSchema, request.body),
        userId,
      );
    },
  );
}
