import { NotFoundError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { ClaimMdEraReviewService } from "../ingest/claimmd-era-review";
import { actorOf } from "./actor";
import { clampLimit } from "./concurrency";
import { P } from "./guards";

const READ = P("remittance.read");
const Params = Type.Object(
  { id: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const Query = Type.Object(
  {
    providerEntityId: Type.Optional(Type.String({ format: "uuid" })),
    state: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z_]+$" })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    limit: Type.Optional(Type.String({ pattern: "^[0-9]{1,3}$" })),
  },
  { additionalProperties: false },
);
export function registerClaimMdEraReviewRoutes(
  app: FastifyInstance,
  service: ClaimMdEraReviewService,
): void {
  app.get(
    "/api/v1/remittance/claimmd-era",
    {
      schema: { querystring: Query },
      preHandler: [READ],
      config: { auditRead: { resourceKind: "claimmd_era_m25_stage", list: true } },
    },
    async (request, reply) => {
      const query = request.query as {
        providerEntityId?: string;
        state?: string;
        cursor?: string;
        limit?: string;
      };
      return reply.send(
        await service.list(
          actorOf(request),
          {
            providerEntityId: query.providerEntityId,
            state: query.state,
          },
          query.cursor,
          clampLimit(query.limit),
        ),
      );
    },
  );

  app.get(
    "/api/v1/remittance/claimmd-era/:id",
    {
      schema: { params: Params },
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
}
