import { requireIdempotencyKey } from "@chartwarden/shared/route-kit";
import { ValidationError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { ReturnTypeMedicaidEraReviewWorkflow } from "../ingest/medicaid-era-review-service";
import { actorOf, writeActorOf } from "./actor";
import { P } from "./guards";
import { clampLimit } from "./m25-typebox";
import {
  MedicaidEraDispositionResultSchema,
  MedicaidEraDispositionSchema,
  MedicaidEraEvaluateParamsSchema,
  MedicaidEraEvaluateResultSchema,
  MedicaidEraNoteSchema,
  MedicaidEraReviewDetailSchema,
  MedicaidEraReviewHistorySchema,
  MedicaidEraReviewPageSchema,
  MedicaidEraReviewQuerySchema,
} from "./medicaid-era-review.schemas";

const READ = P("remittance.read");
const MATCH_REVIEW = P("remittance.match_review");
const FINANCIAL_REVIEW = P("remittance.financial_review");
const IDEMPOTENT = requireIdempotencyKey();
const ReviewParams = Type.Object({ id: Type.String({ format: "uuid" }) });

function idempotencyKey(request: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 8 || value.length > 128)
    throw new ValidationError("a valid Idempotency-Key is required", []);
  return value;
}

export function registerMedicaidEraReviewRoutes(
  app: FastifyInstance,
  service: ReturnTypeMedicaidEraReviewWorkflow,
): void {
  app.get(
    "/api/v1/remittance/medicaid-era-reviews",
    {
      schema: {
        querystring: MedicaidEraReviewQuerySchema,
        response: { 200: MedicaidEraReviewPageSchema },
      },
      preHandler: [READ],
      config: { auditRead: { resourceKind: "medicaid_era_review", list: true } },
    },
    async (request, reply) => {
      const query = request.query as { limit?: string; cursor?: string };
      const page = await service.list(actorOf(request), clampLimit(query.limit), query.cursor);
      return reply.send(page);
    },
  );

  app.get(
    "/api/v1/remittance/medicaid-era-reviews/:id",
    {
      schema: { params: ReviewParams, response: { 200: MedicaidEraReviewDetailSchema } },
      preHandler: [READ, FINANCIAL_REVIEW],
      config: { auditRead: { resourceKind: "medicaid_era_review", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await service.detail(actorOf(request), id));
    },
  );

  app.get(
    "/api/v1/remittance/medicaid-era-reviews/:id/history",
    {
      schema: { params: ReviewParams, response: { 200: MedicaidEraReviewHistorySchema } },
      preHandler: [READ],
      config: { auditRead: { resourceKind: "medicaid_era_review", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send({ items: await service.history(actorOf(request), id) });
    },
  );

  app.post(
    "/api/v1/remittance/medicaid-era-artifacts/:artifactId/evaluate",
    {
      schema: {
        params: MedicaidEraEvaluateParamsSchema,
        response: { 200: MedicaidEraEvaluateResultSchema },
      },
      preHandler: [MATCH_REVIEW, IDEMPOTENT],
      config: {
        auditRead: { resourceKind: "medicaid_era_artifact", resourceIdParam: "artifactId" },
      },
    },
    async (request, reply) => {
      const { artifactId } = request.params as { artifactId: string };
      return reply.send(
        await service.evaluate(writeActorOf(request), artifactId, idempotencyKey(request)),
      );
    },
  );

  app.post(
    "/api/v1/remittance/medicaid-era-reviews/:id/reassess",
    {
      schema: {
        params: ReviewParams,
        response: { 200: MedicaidEraEvaluateResultSchema },
      },
      preHandler: [MATCH_REVIEW, IDEMPOTENT],
      config: {
        auditRead: { resourceKind: "medicaid_era_review", resourceIdParam: "id" },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const actor = writeActorOf(request);
      const artifactReference = await service.reassessmentArtifactReference(actor, id);
      if (!artifactReference)
        return reply.send({ status: "held", reasonCode: "REASSESSMENT_SOURCE_UNAVAILABLE" });
      return reply.send(await service.evaluate(actor, artifactReference, idempotencyKey(request)));
    },
  );

  app.post(
    "/api/v1/remittance/medicaid-era-reviews/:id/disposition",
    {
      schema: {
        params: ReviewParams,
        body: MedicaidEraDispositionSchema,
        response: { 200: MedicaidEraDispositionResultSchema },
      },
      preHandler: [FINANCIAL_REVIEW, IDEMPOTENT],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        expectedVersion: number;
        state: "investigating" | "follow_up_required" | "reviewed_not_posted" | "reopened";
        reasonCode: string;
      };
      return reply.send(
        await service.transition(
          writeActorOf(request),
          id,
          body.expectedVersion,
          body.state,
          body.reasonCode,
          idempotencyKey(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/remittance/medicaid-era-reviews/:id/notes",
    {
      schema: {
        params: ReviewParams,
        body: MedicaidEraNoteSchema,
        response: { 200: MedicaidEraDispositionResultSchema },
      },
      preHandler: [FINANCIAL_REVIEW, IDEMPOTENT],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { expectedVersion: number; reasonCode: string };
      return reply.send(
        await service.addNote(
          writeActorOf(request),
          id,
          body.expectedVersion,
          body.reasonCode,
          idempotencyKey(request),
        ),
      );
    },
  );
}
