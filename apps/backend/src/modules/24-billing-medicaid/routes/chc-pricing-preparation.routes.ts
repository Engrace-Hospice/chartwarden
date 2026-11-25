import { rejectAiActor, requireIdempotencyKey } from "@chartwarden/shared/route-kit";
import { DegradedError, NotFoundError } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import type { ChcPricingPreparationService } from "../pricing/chc-pricing-preparation";
import { m24ActorOf } from "./actor";
import { ABAC_BODY_PATIENT, ABAC_BODY_PE, ABAC_CHC_PREPARATION, P } from "./guards";
import { ChcPricingPreparationBody, ChcPricingPreparationResponse, parse } from "./m24-typebox";

const AI = rejectAiActor("AI principals cannot prepare or change Medicaid billing records (D12)");
const IDEMPOTENT = requireIdempotencyKey();

export function registerChcPricingPreparationRoutes(
  app: FastifyInstance,
  service?: ChcPricingPreparationService,
): void {
  app.post(
    "/api/v1/medicaid-chc-pricing-preparations",
    {
      preHandler: [
        P("medicaid.claim.assemble"),
        ABAC_BODY_PE("medicaid.claim.assemble", "provider_entity_medicaid_billing_scope"),
        ABAC_BODY_PATIENT("medicaid.claim.assemble"),
        AI,
        IDEMPOTENT,
      ],
      schema: { body: ChcPricingPreparationBody, response: { 201: ChcPricingPreparationResponse } },
    },
    async (request, reply) => {
      if (!service) {
        throw new DegradedError(
          "CHC_PRICING_PREPARATION_UNBOUND",
          "local CHC pricing preparation is unavailable in this environment",
        );
      }
      const result = await service.prepare(
        m24ActorOf(request),
        parse(ChcPricingPreparationBody, request.body),
      );
      return reply.code(201).send(result);
    },
  );

  app.get(
    "/api/v1/medicaid-chc-pricing-preparations/:id",
    {
      preHandler: [P("medicaid.claim.read"), ABAC_CHC_PREPARATION("medicaid.claim.read")],
      schema: { response: { 200: ChcPricingPreparationResponse } },
      config: {
        auditRead: {
          resourceKind: "medicaid_chc_pricing_preparation",
          resourceIdParam: "id",
        },
      },
    },
    async (request, reply) => {
      if (!service) {
        throw new DegradedError(
          "CHC_PRICING_PREPARATION_UNBOUND",
          "local CHC pricing preparation is unavailable in this environment",
        );
      }
      const id = (request.params as { id?: string }).id ?? "";
      const result = await service.read(m24ActorOf(request), id);
      if (!result) throw new NotFoundError("CHC pricing preparation not found");
      return reply.send(result);
    },
  );
}
