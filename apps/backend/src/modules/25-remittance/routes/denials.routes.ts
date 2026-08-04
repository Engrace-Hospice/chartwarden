import { NotFoundError } from "@wardenx/types";
// apps/backend/src/modules/25-remittance/routes/denials.routes.ts — M25 (§4.1 routes 9-17, 20) the denial
// worklist: list, detail, the state ladder (assign/start/escalate/resolve/close/reopen), the step-up-gated
// close-with-write-off, and the appeal spawn. Worklist read gates on `denial.worklist.read`; detail +
// transitions compose `claim_assigned_to_actor` (the worklist-ownership ABAC); resolve/reopen/close-write-off
// carry the §4.1 reason floor; close-with-write-off composes the §D15 step-up. PATCH routes are
// optimistic-concurrency (If-Match → 409 on stale).
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { clampLimit, ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { ASSIGNED_TO_ACTOR, P, STEP_UP } from "./guards";
import {
  AppealCreateRequestSchema,
  DenialAssignRequestSchema,
  DenialCloseWriteOffRequestSchema,
  DenialEscalateRequestSchema,
  DenialReopenRequestSchema,
  DenialResolveRequestSchema,
  parse,
} from "./m25-typebox";
import type { M25ReadService } from "./read-service";
import type { M25WriteService } from "./write-service";

export interface DenialRouteDeps {
  readonly readService: M25ReadService;
  readonly writeService: M25WriteService;
}

const WORKLIST = P("denial.worklist.read");
const READ = P("denial.read");
const READ_ABAC = ASSIGNED_TO_ACTOR("denial.read");
const ASSIGN = P("denial.assign");
const ESCALATE = P("denial.escalate");
const RESOLVE = P("denial.resolve");
const CLOSE_WO = P("denial.close_with_write_off");
const CLOSE_WO_STEPUP = STEP_UP("denial.close_with_write_off");
const REOPEN = P("denial.reopen");
const CREATE_APPEAL = P("appeal.create");
const IDEMPOTENT = requireIdempotencyKey();

function qStr(q: unknown, key: string): string | undefined {
  const v = (q as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
const idOf = (request: { params?: unknown }): string => (request.params as { id: string }).id;

export function registerDenialRoutes(app: FastifyInstance, deps: DenialRouteDeps): void {
  const { readService, writeService } = deps;

  app.get(
    "/api/v1/denials",
    { preHandler: [WORKLIST], config: { auditRead: { resourceKind: "denial", list: true } } },
    async (request, reply) => {
      const actor = actorOf(request);
      const q = request.query;
      const minDollarRaw = qStr(q, "minDollar");
      const pageRes = await readService.denialWorklist(
        actor,
        {
          providerEntityId: qStr(q, "providerEntityId"),
          assigneeMembershipId: qStr(q, "assigneeMembershipId"),
          state: qStr(q, "state"),
          carcCode: qStr(q, "carcCode"),
          minDollar: minDollarRaw !== undefined ? Number(minDollarRaw) : undefined,
        },
        qStr(q, "cursor"),
        clampLimit(qStr(q, "limit")),
      );
      return reply.send(pageRes);
    },
  );

  app.get(
    "/api/v1/denials/:id",
    {
      preHandler: [READ, READ_ABAC],
      config: { auditRead: { resourceKind: "denial", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const denial = await readService.getDenial(actor, idOf(request));
      if (!denial) throw new NotFoundError("denial case not found");
      return reply.send(denial);
    },
  );

  app.patch(
    "/api/v1/denials/:id/assign",
    { preHandler: [ASSIGN, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(DenialAssignRequestSchema, request.body);
      const res = await writeService.assignDenial(
        actor,
        idOf(request),
        { assigneeMembershipId: body.assigneeMembershipId, reason: body.reason },
        ifMatchVersion(request),
      );
      return reply.send(res);
    },
  );

  app.patch(
    "/api/v1/denials/:id/start",
    { preHandler: [READ, READ_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      return reply.send(
        await writeService.startDenial(actor, idOf(request), ifMatchVersion(request)),
      );
    },
  );

  app.patch(
    "/api/v1/denials/:id/escalate",
    { preHandler: [ESCALATE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(DenialEscalateRequestSchema, request.body);
      return reply.send(
        await writeService.escalateDenial(
          actor,
          idOf(request),
          { reason: body.reason },
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.patch(
    "/api/v1/denials/:id/resolve",
    { preHandler: [RESOLVE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(DenialResolveRequestSchema, request.body);
      return reply.send(
        await writeService.resolveDenial(
          actor,
          idOf(request),
          { reason: body.reason },
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/denials/:id/close",
    { preHandler: [RESOLVE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      return reply.send(
        await writeService.closeDenial(actor, idOf(request), ifMatchVersion(request)),
      );
    },
  );

  app.post(
    "/api/v1/denials/:id/close-write-off",
    { preHandler: [CLOSE_WO, CLOSE_WO_STEPUP, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(DenialCloseWriteOffRequestSchema, request.body);
      return reply.send(
        await writeService.closeWriteOffDenial(
          actor,
          idOf(request),
          { reason: body.reason },
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/denials/:id/reopen",
    { preHandler: [REOPEN, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(DenialReopenRequestSchema, request.body);
      return reply.send(
        await writeService.reopenDenial(
          actor,
          idOf(request),
          { reason: body.reason },
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/denials/:id/appeals",
    { preHandler: [CREATE_APPEAL, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(AppealCreateRequestSchema, request.body);
      const res = await writeService.createAppeal(actor, idOf(request), { tier: body.tier });
      return reply.code(201).send(res);
    },
  );
}
