// apps/backend/src/modules/23-billing-medicare/routes/notr.routes.ts — M23 (§4.1 NOTR fast path).
//
// The Notice-of-Termination/Revocation plane (the NOE 7-state shape; exactly one trigger-event id is set per
// `trigger_kind`): list NOTR records (timely-filing worklist), read a detail, SUBMIT a READY NOTR (drives the
// pure `notrMachine`, records the attempt, emits `m23.notr.submit_requested` in the same tx, enqueues the
// §4.8 worker; 202), and CANCEL (guarded by the §2.2 fact that the terminating M6 event was reversed). Reads
// gate `billing.notr.read`; submit gates `billing.notr.submit` + the §D14 step-up assertion; cancel gates
// `billing.notr.cancel`. Both mutations compose the §4.7 `provider_entity_billing_scope` predicate over the
// NOTR's ProviderEntity + the §D13 AI-block + `Idempotency-Key` (§4.1). Org/actor binding is server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { P, PROVIDER_SCOPE, STEP_UP, targetNotrId } from "./guards";
import type { M23ReadRouteService } from "./read-service";
import type { M23WriteRouteService } from "./write-service";
import { CancelNotrBodySchema, NotrIdParamsSchema, NotrListQuerySchema, parse } from "./billing-typebox";

export interface NotrRouteDeps {
  readonly readService: M23ReadRouteService;
  readonly writeService: M23WriteRouteService;
}

const READ = P("billing.notr.read");
const READ_ABAC = PROVIDER_SCOPE("billing.notr.read", targetNotrId);
const SUBMIT = P("billing.notr.submit");
const SUBMIT_ABAC = PROVIDER_SCOPE("billing.notr.submit", targetNotrId);
const SUBMIT_STEPUP = STEP_UP("billing.notr.submit");
const CANCEL = P("billing.notr.cancel");
const CANCEL_ABAC = PROVIDER_SCOPE("billing.notr.cancel", targetNotrId);
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 NOTR routes (#28–#31). */
export function registerNotrRoutes(app: FastifyInstance, deps: NotrRouteDeps): void {
  const { readService, writeService } = deps;

  // GET /notr-records — list NOTR records (cursor-paginated). §4.1 #28.
  app.get("/api/v1/notr-records", { preHandler: [READ], config: { auditRead: { resourceKind: "notr_record", list: true } } }, async (request) => {
    const actor = actorOf(request);
    const q = parse(NotrListQuerySchema, request.query);
    return readService.listNotrs(
      actor,
      {
        providerEntityId: q.providerEntityId,
        patientId: q.patientId,
        admissionId: q.admissionId,
        triggerKind: q.triggerKind,
        state: q.state,
      },
      q.cursor,
      q.limit,
    );
  });

  // GET /notr-records/:id — NOTR detail. §4.1 #29.
  app.get("/api/v1/notr-records/:id", { preHandler: [READ, READ_ABAC], config: { auditRead: { resourceKind: "notr_record", resourceIdParam: "id" } } }, async (request) => {
    const actor = actorOf(request);
    const { id } = parse(NotrIdParamsSchema, request.params);
    return readService.getNotr(actor, id);
  });

  // POST /notr-records/:id/submit — READY → SUBMITTED (step-up; 202; emits `m23.notr.submit_requested`). #30.
  app.post(
    "/api/v1/notr-records/:id/submit",
    { preHandler: [SUBMIT, SUBMIT_ABAC, SUBMIT_STEPUP, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(NotrIdParamsSchema, request.params);
      const res = await writeService.submitNotr(actor, id);
      return reply.code(202).send(res);
    },
  );

  // POST /notr-records/:id/cancel — DRAFT/READY → CANCELLED (terminating-event-reversed guard fact). #31.
  app.post(
    "/api/v1/notr-records/:id/cancel",
    { preHandler: [CANCEL, CANCEL_ABAC, NO_AI, IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(NotrIdParamsSchema, request.params);
      const body = parse(CancelNotrBodySchema, request.body);
      return writeService.cancelNotr(actor, id, {
        terminatingEventReversed: body.terminatingEventReversed,
      });
    },
  );
}
