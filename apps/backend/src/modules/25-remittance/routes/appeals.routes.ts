import { NotFoundError } from "@wardenx/types";
// apps/backend/src/modules/25-remittance/routes/appeals.routes.ts — M25 (§4.1 routes 18-19, 21-26) the
// appeal tracker: list, detail (+ events), attach-document, the step-up + within-deadline submit, the MAC
// ack, the decide (typed outcome), withdraw, and the terminal close. Reads gate on `appeal.read`; submit
// composes `appeal_within_deadline` (the hard T-0 block, §4.7) PLUS the §D15 step-up. PATCH/POST mutations
// are optimistic-concurrency (If-Match → 409 on stale; the closed row is also DB-frozen).
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { clampLimit, ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { P, STEP_UP, WITHIN_DEADLINE } from "./guards";
import {
  AppealAttachRequestSchema,
  AppealDecideRequestSchema,
  AppealSubmitRequestSchema,
  AppealWithdrawRequestSchema,
  parse,
} from "./m25-typebox";
import type { M25ReadService } from "./read-service";
import type { M25WriteService } from "./write-service";

export interface AppealRouteDeps {
  readonly readService: M25ReadService;
  readonly writeService: M25WriteService;
}

const READ = P("appeal.read");
const ATTACH = P("appeal.attach_document");
const SUBMIT = P("appeal.submit");
const SUBMIT_ABAC = WITHIN_DEADLINE("appeal.submit");
const SUBMIT_STEPUP = STEP_UP("appeal.submit");
const DECIDE = P("appeal.decide");
const WITHDRAW = P("appeal.withdraw");
const IDEMPOTENT = requireIdempotencyKey();

function qStr(q: unknown, key: string): string | undefined {
  const v = (q as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
const idOf = (request: { params?: unknown }): string => (request.params as { id: string }).id;

export function registerAppealRoutes(app: FastifyInstance, deps: AppealRouteDeps): void {
  const { readService, writeService } = deps;

  app.get(
    "/api/v1/appeals",
    { preHandler: [READ], config: { auditRead: { resourceKind: "appeal", list: true } } },
    async (request, reply) => {
      const actor = actorOf(request);
      const q = request.query;
      const pageRes = await readService.listAppeals(
        actor,
        { state: qStr(q, "state"), tier: qStr(q, "tier") },
        qStr(q, "cursor"),
        clampLimit(qStr(q, "limit")),
      );
      return reply.send(pageRes);
    },
  );

  app.get(
    "/api/v1/appeals/:id",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "appeal", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const appeal = await readService.getAppeal(actor, idOf(request));
      if (!appeal) throw new NotFoundError("appeal case not found");
      return reply.send(appeal);
    },
  );

  app.patch(
    "/api/v1/appeals/:id/attach",
    { preHandler: [ATTACH, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(AppealAttachRequestSchema, request.body);
      return reply.send(
        await writeService.attachAppealDocument(
          actor,
          idOf(request),
          body.documentId,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/appeals/:id/submit",
    { preHandler: [SUBMIT, SUBMIT_ABAC, SUBMIT_STEPUP, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(AppealSubmitRequestSchema, request.body);
      return reply.send(
        await writeService.submitAppeal(
          actor,
          idOf(request),
          { appealNarrative: body.appealNarrative, attachedDocumentIds: body.attachedDocumentIds },
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.patch(
    "/api/v1/appeals/:id/ack",
    { preHandler: [READ, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      return reply.send(
        await writeService.ackAppeal(actor, idOf(request), ifMatchVersion(request)),
      );
    },
  );

  app.post(
    "/api/v1/appeals/:id/decide",
    { preHandler: [DECIDE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(AppealDecideRequestSchema, request.body);
      return reply.send(
        await writeService.decideAppeal(
          actor,
          idOf(request),
          {
            outcome: body.outcome,
            decidedAt: body.decidedAt,
            macReferenceNumbers: body.macReferenceNumbers,
            reason: body.reason,
          },
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/appeals/:id/withdraw",
    { preHandler: [WITHDRAW, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(AppealWithdrawRequestSchema, request.body);
      return reply.send(
        await writeService.withdrawAppeal(
          actor,
          idOf(request),
          { reason: body.reason },
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/appeals/:id/close",
    { preHandler: [READ, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      return reply.send(
        await writeService.closeAppeal(actor, idOf(request), ifMatchVersion(request)),
      );
    },
  );
}
