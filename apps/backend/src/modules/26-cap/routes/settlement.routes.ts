// apps/backend/src/modules/26-cap/routes/settlement.routes.ts — M26 (§4.1) the settlement surface: the
// worksheet read, propose (in_settlement), and finalize (step-up, transitions period → settled). Reads gate
// on cap.settlement.read; propose/finalize on cap.settlement.manage + the §4.7 cap_period_in_settlement ABAC;
// finalize composes the §D12 step-up. Org/actor binding is server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { ABAC, P, STEP_UP } from "./guards";
import { FinalizeSettlementRequest, PeriodIdParams, parse, validateParams } from "./m26-typebox";
import type { M26ReadService } from "./read-service";
import type { M26WriteService } from "./write-service";

export interface SettlementRouteDeps {
  readonly readService: M26ReadService;
  readonly writeService: M26WriteService;
}

const SETTLEMENT_READ = P("cap.settlement.read");
const SETTLEMENT_MANAGE = P("cap.settlement.manage");
const IN_SETTLEMENT = ABAC("cap.settlement.manage", "cap_period_in_settlement");
const IDEMPOTENT = requireIdempotencyKey();
const pParam = (request: { params: unknown }, key: string): string =>
  (request.params as Record<string, string>)[key] ?? "";

export function registerSettlementRoutes(app: FastifyInstance, deps: SettlementRouteDeps): void {
  const { readService, writeService } = deps;

  app.get("/api/v1/cap/settlements/:periodId", { preHandler: [SETTLEMENT_READ] }, async (request, reply) =>
    reply.send(await readService.getSettlement(actorOf(request), pParam(request, "periodId"))),
  );

  app.post(
    "/api/v1/cap/settlements/:periodId/propose",
    { preHandler: [validateParams(PeriodIdParams), SETTLEMENT_MANAGE, IN_SETTLEMENT, IDEMPOTENT] },
    async (request, reply) =>
      reply.code(201).send(await writeService.proposeSettlement(writeActorOf(request), pParam(request, "periodId"))),
  );

  app.patch(
    "/api/v1/cap/settlements/:periodId/finalize",
    { preHandler: [validateParams(PeriodIdParams), SETTLEMENT_MANAGE, IN_SETTLEMENT, STEP_UP("cap.settlement.manage"), IDEMPOTENT] },
    async (request, reply) => {
      const { periodId } = parse(PeriodIdParams, request.params);
      const body = parse(FinalizeSettlementRequest, request.body);
      return reply.send(await writeService.finalizeSettlement(writeActorOf(request), periodId, body));
    },
  );
}
