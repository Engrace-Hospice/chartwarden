import { requireIdempotencyKey } from "@chartwarden/shared/route-kit";
import { NotFoundError, ValidationError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { ClaimMdEraReviewService } from "../ingest/claimmd-era-review";
import { actorOf, writeActorOf } from "./actor";
import {
  ClaimMdEraFinancialReviewDecisionRequestSchema,
  ClaimMdEraFinancialReviewDecisionResultSchema,
  ClaimMdEraHistoricalCandidatesSchema,
  ClaimMdEraMatchDecisionRequestSchema,
  ClaimMdEraMatchDecisionResultSchema,
  ClaimMdEraMatchReviewSchema,
  ClaimMdEraPostingActionRequestSchema,
  ClaimMdEraPostingActionResultSchema,
  ClaimMdEraPostingApprovalResultSchema,
  ClaimMdEraPostingHistorySchema,
  ClaimMdEraPostingPlanSchema,
  ClaimMdEraReviewDetailSchema,
  ClaimMdEraReviewPageSchema,
  ClaimMdEraReviewQuerySchema,
} from "./claimmd-era-review.schemas";
import { P, STEP_UP } from "./guards";
import { clampLimit } from "./m25-typebox";

const READ = P("remittance.read");
const MATCH_REVIEW = P("remittance.match_review");
const FINANCIAL_REVIEW = P("remittance.financial_review");
const POSTING_APPROVE = P("remittance.posting.approve");
const POSTING_EXECUTE = P("remittance.posting.execute");
const POSTING_STEP_UP = STEP_UP("remittance.posting.execute");
const IDEMPOTENT = requireIdempotencyKey();
const Params = Type.Object(
  { id: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
export function registerClaimMdEraReviewRoutes(
  app: FastifyInstance,
  service: ClaimMdEraReviewService,
): void {
  app.get(
    "/api/v1/remittance/claimmd-era",
    {
      schema: {
        querystring: ClaimMdEraReviewQuerySchema,
        response: { 200: ClaimMdEraReviewPageSchema },
      },
      preHandler: [READ],
      config: { auditRead: { resourceKind: "claimmd_era_m25_stage", list: true } },
    },
    async (request, reply) => {
      const query = request.query as {
        providerEntityId?: string;
        state?: string;
        payer?: string;
        fromDate?: string;
        toDate?: string;
        cursor?: string;
        limit?: string;
      };
      return reply.send(
        await service.list(
          actorOf(request),
          {
            providerEntityId: query.providerEntityId,
            state: query.state,
            payer: query.payer,
            fromDate: query.fromDate,
            toDate: query.toDate,
          },
          query.cursor,
          clampLimit(query.limit),
        ),
      );
    },
  );

  app.get(
    "/api/v1/remittance/claimmd-era/:id/posting-history",
    {
      schema: { params: Params, response: { 200: ClaimMdEraPostingHistorySchema } },
      preHandler: [READ],
      config: { auditRead: { resourceKind: "claimmd_era_m25_stage", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await service.postingHistory(actorOf(request), id));
    },
  );

  app.post(
    "/api/v1/remittance/claimmd-era/:id/posting-plan",
    {
      schema: { params: Params, response: { 200: ClaimMdEraPostingPlanSchema } },
      preHandler: [FINANCIAL_REVIEW],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await service.postingPlan(writeActorOf(request), id));
    },
  );

  app.post(
    "/api/v1/remittance/claimmd-era/:id/posting-plans/:planId/approval",
    {
      schema: {
        params: Type.Object({
          id: Type.String({ format: "uuid" }),
          planId: Type.String({ format: "uuid" }),
        }),
        body: ClaimMdEraPostingActionRequestSchema,
        response: { 200: ClaimMdEraPostingApprovalResultSchema },
      },
      preHandler: [POSTING_APPROVE, POSTING_STEP_UP, IDEMPOTENT],
    },
    async (request, reply) => {
      const { id, planId } = request.params as { id: string; planId: string };
      const body = request.body as { planDigest: string; reason: string };
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string") throw new ValidationError("An idempotency key is required.", []);
      return reply.send(
        await service.approvePostingPlan(writeActorOf(request), id, {
          ...body,
          planId,
          idempotencyKey: key,
        }),
      );
    },
  );

  app.post(
    "/api/v1/remittance/claimmd-era/:id/posting-plans/:planId/execution",
    {
      schema: {
        params: Type.Object({
          id: Type.String({ format: "uuid" }),
          planId: Type.String({ format: "uuid" }),
        }),
        body: ClaimMdEraPostingActionRequestSchema,
        response: { 200: ClaimMdEraPostingActionResultSchema },
      },
      preHandler: [POSTING_EXECUTE, POSTING_STEP_UP, IDEMPOTENT],
    },
    async (request, reply) => {
      const { id, planId } = request.params as { id: string; planId: string };
      const body = request.body as { planDigest: string; reason: string };
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string") throw new ValidationError("An idempotency key is required.", []);
      return reply.send(
        await service.executePostingPlan(writeActorOf(request), id, {
          ...body,
          planId,
          idempotencyKey: key,
        }),
      );
    },
  );

  app.post(
    "/api/v1/remittance/claimmd-era/:id/financial-review/decision",
    {
      schema: {
        params: Params,
        body: ClaimMdEraFinancialReviewDecisionRequestSchema,
        response: { 200: ClaimMdEraFinancialReviewDecisionResultSchema },
      },
      preHandler: [FINANCIAL_REVIEW, IDEMPOTENT],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        itemType: "era" | "claim";
        itemIndex: number;
        disposition: "note" | "follow_up" | "reviewed" | "reopened" | "completed";
        expectedVersion: number;
        reason: string;
      };
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string") throw new ValidationError("An idempotency key is required.", []);
      const result = await service.recordFinancialReviewDecision(writeActorOf(request), id, {
        ...body,
        idempotencyKey: key,
      });
      return reply.send({ ...result, financialPostingAuthorized: false });
    },
  );

  app.get(
    "/api/v1/remittance/claimmd-era/:id",
    {
      schema: { params: Params, response: { 200: ClaimMdEraReviewDetailSchema } },
      preHandler: [READ],
      config: { auditRead: { resourceKind: "claimmd_era_m25_stage", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const item = await service.get(actorOf(request), id);
      if (!item) throw new NotFoundError("Claim.MD staged remittance", id);
      return reply.send(item);
    },
  );

  app.get(
    "/api/v1/remittance/claimmd-era/:id/matching",
    {
      schema: { params: Params, response: { 200: ClaimMdEraMatchReviewSchema } },
      preHandler: [READ],
      config: { auditRead: { resourceKind: "claimmd_era_m25_stage", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const matching = await service.matching(actorOf(request), id);
      if (!matching) throw new NotFoundError("Claim.MD staged remittance", id);
      return reply.send(matching);
    },
  );

  app.post(
    "/api/v1/remittance/claimmd-era/:id/matching/claims/:claimIndex/decision",
    {
      schema: {
        params: Type.Object({
          id: Type.String({ format: "uuid" }),
          claimIndex: Type.String({ pattern: "^(0|[1-9][0-9]{0,2})$" }),
        }),
        body: ClaimMdEraMatchDecisionRequestSchema,
        response: { 200: ClaimMdEraMatchDecisionResultSchema },
      },
      preHandler: [MATCH_REVIEW, IDEMPOTENT],
    },
    async (request, reply) => {
      const params = request.params as { id: string; claimIndex: string };
      const body = request.body as {
        action: "confirm_identity" | "confirm_candidate" | "clear";
        expectedVersion: number;
        reason: string;
        evidenceId?: string;
      };
      const result = await service.recordMatchDecision(
        writeActorOf(request),
        params.id,
        Number(params.claimIndex),
        body,
      );
      return reply.send({
        id: params.id,
        claimIndex: Number(params.claimIndex),
        ...result,
        postingAuthorized: false,
      });
    },
  );

  app.get(
    "/api/v1/remittance/claimmd-era/:id/matching/claims/:claimIndex/candidates",
    {
      schema: {
        params: Type.Object({
          id: Type.String({ format: "uuid" }),
          claimIndex: Type.String({ pattern: "^(0|[1-9][0-9]{0,2})$" }),
        }),
        response: { 200: ClaimMdEraHistoricalCandidatesSchema },
      },
      preHandler: [READ],
      config: { auditRead: { resourceKind: "claimmd_era_m25_stage", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const params = request.params as { id: string; claimIndex: string };
      const page = await service.candidates(actorOf(request), params.id, Number(params.claimIndex));
      if (!page) throw new NotFoundError("Claim.MD staged remittance", params.id);
      return reply.send({ ...page, postingAuthorized: false });
    },
  );
}
