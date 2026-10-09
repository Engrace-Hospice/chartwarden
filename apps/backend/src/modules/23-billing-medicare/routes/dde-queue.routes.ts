// apps/backend/src/modules/23-billing-medicare/routes/dde-queue.routes.ts — the DDE work queue (ADR-0052): human
// work tracking for Medicare Direct Data Entry items (NOE, NOTR, claim entry, RTP correction, adjustment, cancel,
// ADR response). WardenX never calls DDE; these routes record what an operator did and what came back.
//
// Reads gate `billing.dde.read`; create / claim / start / outcome / retry / cancel / close gate `billing.dde.work`;
// RECORD SUBMISSION (the attestation that an item was keyed in DDE) gates `billing.dde.mark_submitted` + the §D14
// step-up; assigning an item to someone else gates `billing.dde.admin`. Every object route composes
// `provider_entity_billing_scope` over the item's provider entity (a denied object is a 404), every mutation the
// §D13 AI-block + `Idempotency-Key`. Reads are read-audited with a `resourceIdParam`. Org / actor / membership are
// server-side. Notes never reach a log or an event.
import type { FastifyInstance } from "fastify";
import type { DdeQueueService } from "../services/dde-queue-service";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { parse } from "./billing-typebox";
import { requireIdempotencyKey } from "./concurrency";
import {
  AssignDdeItemBodySchema,
  CreateDdeItemBodySchema,
  DdeItemIdParamsSchema,
  DdeItemListQuerySchema,
  DdeVersionBodySchema,
  RecordDdeOutcomeBodySchema,
  RecordDdeSubmissionBodySchema,
} from "./dde-queue-typebox";
import {
  P,
  PROVIDER_SCOPE,
  STEP_UP,
  targetDdeSubjectFromBody,
  targetDdeWorkItemId,
} from "./guards";

export interface DdeQueueRouteDeps {
  readonly ddeQueueService: DdeQueueService;
}

const READ = P("billing.dde.read");
const READ_ABAC = PROVIDER_SCOPE("billing.dde.read", targetDdeWorkItemId);
const WORK = P("billing.dde.work");
const WORK_ABAC = PROVIDER_SCOPE("billing.dde.work", targetDdeWorkItemId);
const CREATE_ABAC = PROVIDER_SCOPE("billing.dde.work", targetDdeSubjectFromBody);
const MARK = P("billing.dde.mark_submitted");
const MARK_ABAC = PROVIDER_SCOPE("billing.dde.mark_submitted", targetDdeWorkItemId);
const MARK_STEPUP = STEP_UP("billing.dde.mark_submitted");
const ADMIN = P("billing.dde.admin");
const ADMIN_ABAC = PROVIDER_SCOPE("billing.dde.admin", targetDdeWorkItemId);
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();
const WORK_GUARDS = [WORK, WORK_ABAC, NO_AI, IDEMPOTENT];

export function registerDdeQueueRoutes(app: FastifyInstance, deps: DdeQueueRouteDeps): void {
  const service = deps.ddeQueueService;

  app.get(
    "/api/v1/billing/dde-items",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "dde_work_item", list: true } },
    },
    async (request) => {
      const q = parse(DdeItemListQuerySchema, request.query);
      const { cursor, limit, ...filter } = q;
      return service.list(actorOf(request), filter, cursor, limit);
    },
  );

  app.get(
    "/api/v1/billing/dde-items/:id",
    {
      preHandler: [READ, READ_ABAC],
      config: { auditRead: { resourceKind: "dde_work_item", resourceIdParam: "id" } },
    },
    async (request) => {
      const { id } = parse(DdeItemIdParamsSchema, request.params);
      return service.get(actorOf(request), id);
    },
  );

  app.post(
    "/api/v1/billing/dde-items",
    { preHandler: [WORK, CREATE_ABAC, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(CreateDdeItemBodySchema, request.body);
      return reply.code(201).send(await service.create(writeActorOf(request), body));
    },
  );

  app.post("/api/v1/billing/dde-items/:id/claim", { preHandler: WORK_GUARDS }, async (request) => {
    const { id } = parse(DdeItemIdParamsSchema, request.params);
    const { expectedVersion } = parse(DdeVersionBodySchema, request.body);
    return service.claim(writeActorOf(request), id, expectedVersion);
  });

  app.post(
    "/api/v1/billing/dde-items/:id/assign",
    { preHandler: [ADMIN, ADMIN_ABAC, NO_AI, IDEMPOTENT] },
    async (request) => {
      const { id } = parse(DdeItemIdParamsSchema, request.params);
      const body = parse(AssignDdeItemBodySchema, request.body);
      return service.assign(writeActorOf(request), id, body);
    },
  );

  app.post("/api/v1/billing/dde-items/:id/start", { preHandler: WORK_GUARDS }, async (request) => {
    const { id } = parse(DdeItemIdParamsSchema, request.params);
    const { expectedVersion } = parse(DdeVersionBodySchema, request.body);
    return service.start(writeActorOf(request), id, expectedVersion);
  });

  app.post(
    "/api/v1/billing/dde-items/:id/record-submission",
    { preHandler: [MARK, MARK_ABAC, MARK_STEPUP, NO_AI, IDEMPOTENT] },
    async (request) => {
      const { id } = parse(DdeItemIdParamsSchema, request.params);
      const body = parse(RecordDdeSubmissionBodySchema, request.body);
      return service.recordSubmission(writeActorOf(request), id, body);
    },
  );

  app.post(
    "/api/v1/billing/dde-items/:id/record-outcome",
    { preHandler: WORK_GUARDS },
    async (request) => {
      const { id } = parse(DdeItemIdParamsSchema, request.params);
      const body = parse(RecordDdeOutcomeBodySchema, request.body);
      return service.recordOutcome(writeActorOf(request), id, body);
    },
  );

  app.post("/api/v1/billing/dde-items/:id/retry", { preHandler: WORK_GUARDS }, async (request) => {
    const { id } = parse(DdeItemIdParamsSchema, request.params);
    const { expectedVersion } = parse(DdeVersionBodySchema, request.body);
    return service.retry(writeActorOf(request), id, expectedVersion);
  });

  app.post("/api/v1/billing/dde-items/:id/cancel", { preHandler: WORK_GUARDS }, async (request) => {
    const { id } = parse(DdeItemIdParamsSchema, request.params);
    const { expectedVersion } = parse(DdeVersionBodySchema, request.body);
    return service.cancel(writeActorOf(request), id, expectedVersion);
  });

  app.post("/api/v1/billing/dde-items/:id/close", { preHandler: WORK_GUARDS }, async (request) => {
    const { id } = parse(DdeItemIdParamsSchema, request.params);
    const { expectedVersion } = parse(DdeVersionBodySchema, request.body);
    return service.close(writeActorOf(request), id, expectedVersion);
  });
}
