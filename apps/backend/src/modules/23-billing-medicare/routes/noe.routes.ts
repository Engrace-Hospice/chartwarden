// apps/backend/src/modules/23-billing-medicare/routes/noe.routes.ts — M23 (§4.1 NOE fast path).
//
// The Notice-of-Election plane: list NOE records (timely-filing worklist), read a detail, SUBMIT a READY NOE
// (the write service drives the pure `noeMachine`, records the submission attempt, emits
// `m23.noe.submit_requested` in the same tx, and enqueues the §4.8 worker; 202), and CANCEL a DRAFT/READY NOE
// (guarded by the §2.2 fact that the upstream M6 election was reversed). Reads gate `billing.noe.read`;
// submit gates `billing.noe.submit` + the §D14 step-up assertion; cancel gates `billing.noe.cancel`. Both
// mutations compose the §4.7 `provider_entity_billing_scope` predicate over the NOE's ProviderEntity + the
// §D13 AI-block + `Idempotency-Key` (§4.1). Org/actor/membership binding is ALWAYS server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import {
  CancelNoeBodySchema,
  NoeIdParamsSchema,
  NoeListQuerySchema,
  parse,
} from "./billing-typebox";
import { requireIdempotencyKey } from "./concurrency";
import { P, PROVIDER_SCOPE, STEP_UP, targetNoeId } from "./guards";
import type { M23ReadRouteService } from "./read-service";
import type { M23WriteRouteService } from "./write-service";

export interface NoeRouteDeps {
  readonly readService: M23ReadRouteService;
  readonly writeService: M23WriteRouteService;
}

const READ = P("billing.noe.read");
const READ_ABAC = PROVIDER_SCOPE("billing.noe.read", targetNoeId);
const SUBMIT = P("billing.noe.submit");
const SUBMIT_ABAC = PROVIDER_SCOPE("billing.noe.submit", targetNoeId);
const SUBMIT_STEPUP = STEP_UP("billing.noe.submit");
const CANCEL = P("billing.noe.cancel");
const CANCEL_ABAC = PROVIDER_SCOPE("billing.noe.cancel", targetNoeId);
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 NOE routes (#24–#27). */
export function registerNoeRoutes(app: FastifyInstance, deps: NoeRouteDeps): void {
  const { readService, writeService } = deps;

  // GET /noe-records — list NOE records (cursor-paginated). §4.1 #24.
  app.get(
    "/api/v1/noe-records",
    { preHandler: [READ], config: { auditRead: { resourceKind: "noe_record", list: true } } },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(NoeListQuerySchema, request.query);
      return readService.listNoes(
        actor,
        {
          providerEntityId: q.providerEntityId,
          patientId: q.patientId,
          admissionId: q.admissionId,
          state: q.state,
        },
        q.cursor,
        q.limit,
      );
    },
  );

  // GET /noe-records/:id — NOE detail. §4.1 #25.
  app.get(
    "/api/v1/noe-records/:id",
    {
      preHandler: [READ, READ_ABAC],
      config: { auditRead: { resourceKind: "noe_record", resourceIdParam: "id" } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(NoeIdParamsSchema, request.params);
      return readService.getNoe(actor, id);
    },
  );

  // POST /noe-records/:id/submit — READY → SUBMITTED (step-up; 202; emits `m23.noe.submit_requested`). #26.
  app.post(
    "/api/v1/noe-records/:id/submit",
    { preHandler: [SUBMIT, SUBMIT_ABAC, SUBMIT_STEPUP, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(NoeIdParamsSchema, request.params);
      const res = await writeService.submitNoe(actor, id);
      return reply.code(202).send(res);
    },
  );

  // POST /noe-records/:id/cancel — DRAFT/READY → CANCELLED (election-reversed guard fact). §4.1 #27.
  app.post(
    "/api/v1/noe-records/:id/cancel",
    { preHandler: [CANCEL, CANCEL_ABAC, NO_AI, IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(NoeIdParamsSchema, request.params);
      const body = parse(CancelNoeBodySchema, request.body);
      return writeService.cancelNoe(actor, id, { electionReversed: body.electionReversed });
    },
  );
}
