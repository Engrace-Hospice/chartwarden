import { actorOf, parse, rejectAiActor, requireIdempotencyKey } from "@chartwarden/shared/route-kit";
import type { FastifyInstance } from "fastify";
import { writeActorOf } from "./actor";
import { P, PROVIDER_SCOPE, STEP_UP, targetNoeId } from "./guards";
import type { NoeExceptionReviewService } from "./noe-exception-review-service";
import { AddNoeExceptionEvidenceSchema, CreateNoeExceptionReviewSchema, NoeExceptionPathSchema, NoeExceptionReviewPathSchema, RecordNoeExceptionDecisionSchema, RecordNoeExceptionRequestSchema } from "./noe-exception-review-typebox";

export function registerNoeExceptionReviewRoutes(app: FastifyInstance, service: NoeExceptionReviewService): void {
  const read = P("billing.noe.read");
  const write = P("billing.noe.submit");
  const scope = PROVIDER_SCOPE("billing.noe.submit", targetNoeId);
  const stepUp = STEP_UP("billing.noe.submit");
  const safeHuman = rejectAiActor();
  const idempotent = requireIdempotencyKey();
  const readScope = PROVIDER_SCOPE("billing.noe.read", targetNoeId);
  app.get("/api/v1/noe-records/:id/exception-reviews", { preHandler: [read, readScope], config: { auditRead: { resourceKind: "noe_exception_review", list: true } } }, async (request) => {
    const { id } = parse(NoeExceptionPathSchema, request.params);
    return { items: await service.list(actorOf(request), id) };
  });
  app.get("/api/v1/noe-records/:id/exception-reviews/:reviewId/history", { preHandler: [read, readScope], config: { auditRead: { resourceKind: "noe_exception_review", resourceIdParam: "reviewId" } } }, async (request) => {
    const { id, reviewId } = parse(NoeExceptionReviewPathSchema, request.params);
    return { items: await service.history(actorOf(request), id, reviewId) };
  });
  app.post("/api/v1/noe-records/:id/exception-reviews/:reviewId/evidence", { preHandler: [write, scope, safeHuman, idempotent] }, async (request) => {
    const { id, reviewId } = parse(NoeExceptionReviewPathSchema, request.params);
    const body = parse(AddNoeExceptionEvidenceSchema, request.body);
    return service.addEvidence(writeActorOf(request), { noeId: id, reviewId, ...body });
  });
  app.post("/api/v1/noe-records/:id/exception-reviews", { preHandler: [write, scope, safeHuman, idempotent] }, async (request, reply) => {
    const { id } = parse(NoeExceptionPathSchema, request.params);
    const body = parse(CreateNoeExceptionReviewSchema, request.body);
    return reply.code(201).send(await service.create(writeActorOf(request), { noeId: id, ...body }));
  });
  app.post("/api/v1/noe-records/:id/exception-reviews/:reviewId/record-request", { preHandler: [write, scope, stepUp, safeHuman, idempotent] }, async (request) => {
    const { id, reviewId } = parse(NoeExceptionReviewPathSchema, request.params);
    const body = parse(RecordNoeExceptionRequestSchema, request.body);
    return service.recordRequest(writeActorOf(request), { reviewId, noeId: id, ...body });
  });
  app.post("/api/v1/noe-records/:id/exception-reviews/:reviewId/record-decision", { preHandler: [write, scope, stepUp, safeHuman, idempotent] }, async (request) => {
    const { id, reviewId } = parse(NoeExceptionReviewPathSchema, request.params);
    const body = parse(RecordNoeExceptionDecisionSchema, request.body);
    return service.recordDecision(writeActorOf(request), { reviewId, noeId: id, ...body });
  });
}
