// apps/backend/src/modules/25-remittance/routes/remittance.routes.ts — M25 (§4.1 routes 1-8) the 835
// envelope + line surface: list/detail envelopes, list/detail lines, the manual-match worklist, the
// admin replay, the manual-match write, and the step-up-gated adjustment override. Reads gate on
// `remittance.read` (provider_entity_scope default); manual-match composes `claim_assigned_to_actor`;
// the override composes the §D15 step-up. Org/actor binding is server-side (actorOf/writeActorOf).
import { NotFoundError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { clampLimit, requireIdempotencyKey } from "./concurrency";
import { ASSIGNED_TO_ACTOR, P, STEP_UP } from "./guards";
import { AdjustmentOverrideRequestSchema, ManualMatchRequestSchema, parse } from "./m25-typebox";
import type { M25ReadService } from "./read-service";
import type { M25WriteService } from "./write-service";

export interface RemittanceRouteDeps {
  readonly readService: M25ReadService;
  readonly writeService: M25WriteService;
}

const READ = P("remittance.read");
const REPLAY = P("remittance.replay");
const MANUAL_MATCH = P("remittance.manual_match");
const MANUAL_MATCH_ABAC = ASSIGNED_TO_ACTOR("remittance.manual_match");
const OVERRIDE = P("remittance.adjustment.override");
const OVERRIDE_STEPUP = STEP_UP("remittance.adjustment.override");
const IDEMPOTENT = requireIdempotencyKey();

function qStr(q: unknown, key: string): string | undefined {
  const v = (q as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function registerRemittanceRoutes(app: FastifyInstance, deps: RemittanceRouteDeps): void {
  const { readService, writeService } = deps;

  app.get("/api/v1/remittance/advices", { preHandler: [READ], config: { auditRead: { resourceKind: "remittance_advice", list: true } } }, async (request, reply) => {
    const actor = actorOf(request);
    const q = request.query;
    const pageRes = await readService.listAdvices(
      actor,
      { providerEntityId: qStr(q, "providerEntityId"), parseStatus: qStr(q, "parseStatus") },
      qStr(q, "cursor"),
      clampLimit(qStr(q, "limit")),
    );
    return reply.send(pageRes);
  });

  app.get("/api/v1/remittance/advices/:id", { preHandler: [READ], config: { auditRead: { resourceKind: "remittance_advice", resourceIdParam: "id" } } }, async (request, reply) => {
    const actor = actorOf(request);
    const id = (request.params as { id: string }).id;
    const advice = await readService.getAdvice(actor, id);
    if (!advice) throw new NotFoundError("remittance advice not found");
    return reply.send(advice);
  });

  app.post("/api/v1/remittance/advices/:id/replay", { preHandler: [REPLAY, IDEMPOTENT] }, async (request, reply) => {
    const actor = writeActorOf(request);
    const id = (request.params as { id: string }).id;
    await writeService.replayAdvice(actor, id);
    return reply.code(202).send({ id, status: "queued" });
  });

  app.get("/api/v1/remittance/lines", { preHandler: [READ], config: { auditRead: { resourceKind: "remittance_line", list: true } } }, async (request, reply) => {
    const actor = actorOf(request);
    const q = request.query;
    const pageRes = await readService.listLines(
      actor,
      { remittanceAdviceId: qStr(q, "remittanceAdviceId"), matchState: qStr(q, "matchState") },
      qStr(q, "cursor"),
      clampLimit(qStr(q, "limit")),
    );
    return reply.send(pageRes);
  });

  app.get("/api/v1/remittance/lines/:id", { preHandler: [READ], config: { auditRead: { resourceKind: "remittance_line", resourceIdParam: "id" } } }, async (request, reply) => {
    const actor = actorOf(request);
    const id = (request.params as { id: string }).id;
    const line = await readService.getLine(actor, id);
    if (!line) throw new NotFoundError("remittance line not found");
    return reply.send(line);
  });

  app.get("/api/v1/remittance/unmatched", { preHandler: [READ], config: { auditRead: { resourceKind: "remittance_line", list: true } } }, async (request, reply) => {
    const actor = actorOf(request);
    const q = request.query;
    const pageRes = await readService.listUnmatched(
      actor,
      qStr(q, "providerEntityId"),
      qStr(q, "cursor"),
      clampLimit(qStr(q, "limit")),
    );
    return reply.send(pageRes);
  });

  app.post(
    "/api/v1/remittance/lines/:id/manual-match",
    { preHandler: [MANUAL_MATCH, MANUAL_MATCH_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const id = (request.params as { id: string }).id;
      const body = parse(ManualMatchRequestSchema, request.body);
      await writeService.manualMatch(actor, id, { proposedClaimId: body.proposedClaimId, reason: body.reason });
      return reply.send({ id, matchState: "manual_matched" });
    },
  );

  app.post(
    "/api/v1/remittance/adjustments/:id/override",
    { preHandler: [OVERRIDE, OVERRIDE_STEPUP, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const id = (request.params as { id: string }).id;
      const body = parse(AdjustmentOverrideRequestSchema, request.body);
      // Adjustments are worker-written; no optimistic version on this surface (the step-up is the gate).
      await writeService.overrideAdjustment(actor, id, { newPostAction: body.newPostAction, reason: body.reason });
      return reply.send({ id, postAction: body.newPostAction });
    },
  );
}
