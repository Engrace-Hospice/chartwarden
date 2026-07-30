// apps/backend/src/modules/24-billing-medicaid/routes/rb.routes.ts — M24 (§4.1) the Room & Board surface
// (routes 24–31). The arrangement routes compose the §4.8 `rb_arrangement_visible_in_scope` ABAC over the
// `:id` arrangement (or the body PE on create); activate/terminate add §D12 step-up. Every mutation rejects
// `actor_kind='ai_*'` (§8.6) and requires the §F08 Idempotency-Key. The rb-day override gates on RBAC + RLS
// (the rb_day → PE caseload narrowing binds with the M5 CaseloadProvider seam — deferred, §4.4).
import { NotFoundError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { ABAC_ARRANGEMENT, ABAC_BODY_PE, P, STEP_UP } from "./guards";
import {
  CreateRbArrangementBody,
  EditRbArrangementBody,
  OverrideRbDayBody,
  RbArrangementListQuery,
  RbDayListQuery,
  TerminateRbArrangementBody,
  parse,
  parseQuery,
} from "./m24-typebox";
import type { M24ReadService } from "./read-service";
import type { M24WriteService } from "./write-service";

export interface RbRouteDeps {
  readonly readService: M24ReadService;
  readonly writeService: M24WriteService;
}

const AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();
const pParam = (request: { params: unknown }, key: string): string =>
  (request.params as Record<string, string>)[key] ?? "";

export function registerRbRoutes(app: FastifyInstance, deps: RbRouteDeps): void {
  const { readService, writeService } = deps;

  // 24 — create DRAFT arrangement
  app.post(
    "/api/v1/rb-arrangements",
    { preHandler: [P("medicaid.rb_arrangement.create"), ABAC_BODY_PE("medicaid.rb_arrangement.create", "rb_arrangement_visible_in_scope"), AI, IDEMPOTENT] },
    async (request, reply) =>
      reply.code(201).send(await writeService.createRbArrangement(writeActorOf(request), parse(CreateRbArrangementBody, request.body))),
  );

  // 25 — list arrangements
  app.get("/api/v1/rb-arrangements", { preHandler: [P("medicaid.rb_arrangement.read")] }, async (request, reply) => {
    const q = parseQuery(RbArrangementListQuery, request.query);
    return reply.send(await readService.listRbArrangements(actorOf(request), q));
  });

  // 26 — read one with day history
  app.get(
    "/api/v1/rb-arrangements/:id",
    { preHandler: [P("medicaid.rb_arrangement.read"), ABAC_ARRANGEMENT("medicaid.rb_arrangement.read", "rb_arrangement_visible_in_scope")] },
    async (request, reply) => {
      const arr = await readService.getRbArrangement(actorOf(request), pParam(request, "id"));
      if (!arr) throw new NotFoundError("R&B arrangement not found");
      return reply.send(arr);
    },
  );

  // 27 — edit DRAFT arrangement
  app.patch(
    "/api/v1/rb-arrangements/:id",
    { preHandler: [P("medicaid.rb_arrangement.edit"), ABAC_ARRANGEMENT("medicaid.rb_arrangement.edit", "rb_arrangement_visible_in_scope"), AI, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(EditRbArrangementBody, request.body);
      return reply.send(await writeService.editRbArrangement(writeActorOf(request), pParam(request, "id"), { expectedVersion: ifMatchVersion(request), ...body }));
    },
  );

  // 28 — activate (step-up)
  app.post(
    "/api/v1/rb-arrangements/:id/activate",
    { preHandler: [P("medicaid.rb_arrangement.activate"), ABAC_ARRANGEMENT("medicaid.rb_arrangement.activate", "rb_arrangement_visible_in_scope"), STEP_UP("medicaid.rb_arrangement.activate"), AI, IDEMPOTENT] },
    async (request, reply) => reply.send(await writeService.activateRbArrangement(writeActorOf(request), pParam(request, "id"), ifMatchVersion(request))),
  );

  // 29 — terminate (step-up)
  app.post(
    "/api/v1/rb-arrangements/:id/terminate",
    { preHandler: [P("medicaid.rb_arrangement.activate"), ABAC_ARRANGEMENT("medicaid.rb_arrangement.activate", "rb_arrangement_visible_in_scope"), STEP_UP("medicaid.rb_arrangement.activate"), AI, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(TerminateRbArrangementBody, request.body);
      return reply.send(await writeService.terminateRbArrangement(writeActorOf(request), pParam(request, "id"), { expectedVersion: ifMatchVersion(request), reason: body.reason }));
    },
  );

  // 30 — list rb_days
  app.get("/api/v1/rb-days", { preHandler: [P("medicaid.rb_arrangement.read")] }, async (request, reply) => {
    const q = parseQuery(RbDayListQuery, request.query);
    return reply.send(await readService.listRbDays(actorOf(request), q));
  });

  // 31 — override day status with reason
  app.patch(
    "/api/v1/rb-days/:id",
    { preHandler: [P("medicaid.rb_day.override"), AI, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(OverrideRbDayBody, request.body);
      await writeService.overrideRbDay(writeActorOf(request), pParam(request, "id"), { expectedVersion: ifMatchVersion(request), ...body });
      return reply.code(204).send();
    },
  );
}
