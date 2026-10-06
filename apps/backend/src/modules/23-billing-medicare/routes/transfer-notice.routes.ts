// apps/backend/src/modules/23-billing-medicare/routes/transfer-notice.routes.ts — the Medicare transfer-notice
// plane (TOB 8xC / corrected 8xC / 8xD void; CMS Pub. 100-04 ch. 11 §20.1.3 / §20.1.4): the worklist + detail,
// the "transferring hospice finalized its billing" confirmation, submit (202; the worker transmits), cancel
// before submission, and the correction / void / redraft follow-ups.
//
// CMS calls the 8xC a "transfer Notice of Election" (§30.x discharge reasons), so it rides the NOE permission
// keys: reads gate `billing.noe.read`; confirm / submit / correct / void / redraft gate `billing.noe.submit`
// (submit adds the §D14 step-up — it is the act of filing with Medicare); cancel gates `billing.noe.cancel`.
// Every route composes `provider_entity_billing_scope` over the notice's provider entity (a denied object is a
// 404), every mutation the §D13 AI-block + `Idempotency-Key`. Org / actor / membership are server-side.
import type { FastifyInstance } from "fastify";
import type { TransferNoticeService } from "../services/transfer-notice-service";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { parse } from "./billing-typebox";
import { requireIdempotencyKey } from "./concurrency";
import { P, PROVIDER_SCOPE, STEP_UP, targetTransferNoticeId } from "./guards";
import {
  CancelTransferNoticeBodySchema,
  ConfirmPriorBillingBodySchema,
  CorrectTransferDateBodySchema,
  SubmitTransferNoticeBodySchema,
  TransferNoticeIdParamsSchema,
  TransferNoticeListQuerySchema,
} from "./transfer-notice-typebox";

export interface TransferNoticeRouteDeps {
  readonly transferNoticeService: TransferNoticeService;
}

const READ = P("billing.noe.read");
const READ_ABAC = PROVIDER_SCOPE("billing.noe.read", targetTransferNoticeId);
const FILE = P("billing.noe.submit");
const FILE_ABAC = PROVIDER_SCOPE("billing.noe.submit", targetTransferNoticeId);
const SUBMIT_STEPUP = STEP_UP("billing.noe.submit");
const CANCEL = P("billing.noe.cancel");
const CANCEL_ABAC = PROVIDER_SCOPE("billing.noe.cancel", targetTransferNoticeId);
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();
const FILE_GUARDS = [FILE, FILE_ABAC, NO_AI, IDEMPOTENT];

export function registerTransferNoticeRoutes(
  app: FastifyInstance,
  deps: TransferNoticeRouteDeps,
): void {
  const service = deps.transferNoticeService;

  app.get(
    "/api/v1/billing/transfer-notices",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "transfer_notice_record", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(TransferNoticeListQuerySchema, request.query);
      return service.list(
        actor,
        { patientId: q.patientId, admissionId: q.admissionId, state: q.state },
        q.cursor,
        q.limit,
      );
    },
  );

  app.get(
    "/api/v1/billing/transfer-notices/:id",
    {
      preHandler: [READ, READ_ABAC],
      config: { auditRead: { resourceKind: "transfer_notice_record", resourceIdParam: "id" } },
    },
    async (request) => {
      const { id } = parse(TransferNoticeIdParamsSchema, request.params);
      return service.get(actorOf(request), id);
    },
  );

  app.post(
    "/api/v1/billing/transfer-notices/:id/confirm-prior-billing",
    { preHandler: FILE_GUARDS },
    async (request) => {
      const { id } = parse(TransferNoticeIdParamsSchema, request.params);
      const body = parse(ConfirmPriorBillingBodySchema, request.body);
      return service.confirmPriorBilling(writeActorOf(request), id, body);
    },
  );

  app.post(
    "/api/v1/billing/transfer-notices/:id/submit",
    { preHandler: [FILE, FILE_ABAC, SUBMIT_STEPUP, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const { id } = parse(TransferNoticeIdParamsSchema, request.params);
      const body = parse(SubmitTransferNoticeBodySchema, request.body);
      const res = await service.submit(writeActorOf(request), id, body);
      return reply.code(202).send(res);
    },
  );

  app.post(
    "/api/v1/billing/transfer-notices/:id/cancel",
    { preHandler: [CANCEL, CANCEL_ABAC, NO_AI, IDEMPOTENT] },
    async (request) => {
      const { id } = parse(TransferNoticeIdParamsSchema, request.params);
      const body = parse(CancelTransferNoticeBodySchema, request.body);
      return service.cancel(writeActorOf(request), id, body);
    },
  );

  app.post(
    "/api/v1/billing/transfer-notices/:id/correct-date",
    { preHandler: FILE_GUARDS },
    async (request, reply) => {
      const { id } = parse(TransferNoticeIdParamsSchema, request.params);
      const body = parse(CorrectTransferDateBodySchema, request.body);
      return reply.code(201).send(await service.correctDate(writeActorOf(request), id, body));
    },
  );

  app.post(
    "/api/v1/billing/transfer-notices/:id/void",
    { preHandler: FILE_GUARDS },
    async (request, reply) => {
      const { id } = parse(TransferNoticeIdParamsSchema, request.params);
      return reply.code(201).send(await service.voidNotice(writeActorOf(request), id));
    },
  );

  app.post(
    "/api/v1/billing/transfer-notices/:id/redraft",
    { preHandler: FILE_GUARDS },
    async (request, reply) => {
      const { id } = parse(TransferNoticeIdParamsSchema, request.params);
      return reply.code(201).send(await service.redraft(writeActorOf(request), id));
    },
  );
}
