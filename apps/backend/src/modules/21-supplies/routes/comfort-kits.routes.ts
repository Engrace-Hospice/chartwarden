// apps/backend/src/modules/21-supplies/routes/comfort-kits.routes.ts — M21 (§4.1) rows 20–27 plus the two
// §4.3 keys the route inventory implies: the comfort-kit dispatch / return / reconciliation surface.
//
// THIS IS THE DEA 21 CFR §1304 SURFACE, and it is gated differently from the rest of M21:
//
//   • `POST /comfort-kit-dispatches` and `POST /comfort-kit-returns/:id/reconcile` both carry a §4.4 ABAC
//     predicate AND a step-up gate. §4.1's table has no step-up column, but both operations are a
//     DEA-attributable signature on a scheduled drug — the same class of act as M14's IDG adjournment and
//     M16's plan close, both of which step up. Architecture (the §4.2.1 step-up policy family) wins over a
//     module spec's omission, and the extra factor costs a coordinator one tap.
//   • The reconcile predicate is `comfort_kit_return_reconciler_eligible`, whose FIRST clause is separation
//     of duties: the membership that dispatched the kit may not be the one that counts it back in. That
//     clause is checked before the authority clause on purpose — see abac-predicates.ts.
//   • The perpetual-log read has its OWN permission key (`comfort_kit.perpetual_log.read`,
//     `compliance` category). A supply coordinator who may file requests must not thereby acquire the
//     lot-level custody chain; a compliance officer who reads it needs no request permission at all.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchStamp, rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import { ABAC_DISPATCHER_ON_CREATE, ABAC_RECONCILER, P, STEP_UP } from "./guards";
import {
  AssignRetrieverBody,
  CreateDispatchBody,
  CreateReturnBody,
  DeclareUnreturnableBody,
  DeployAtPatientBody,
  DispatchIdParams,
  ListDispatchesQuery,
  ListReturnsQuery,
  ReconcileReturnBody,
  ReturnIdParams,
  parse,
  parseQuery,
} from "./m21-typebox";
import type { M21ReadService } from "./read-service";
import type { M21WriteService } from "./write-service";

export interface ComfortKitRouteDeps {
  readonly readService: M21ReadService;
  readonly writeService: M21WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

const DISPATCH_READ = {
  resourceKind: "comfort_kit_dispatch",
  resourceIdParam: "dispatchId",
} as const;
const RETURN_READ = { resourceKind: "comfort_kit_return", resourceIdParam: "returnId" } as const;

export function registerComfortKitRoutes(app: FastifyInstance, deps: ComfortKitRouteDeps): void {
  const { readService, writeService } = deps;

  // 20 — dispatch a comfort kit. §2.5 runs the five fail-closed refusals, decrements the hub shelf and
  //      inserts the per-line DEA outbound log, all in ONE transaction: a kit that "shipped" off an empty
  //      shelf is a controlled-substance record of a movement that did not happen.
  app.post(
    "/api/v1/supplies/comfort-kit-dispatches",
    {
      preHandler: [
        P("comfort_kit.dispatch.create"),
        ABAC_DISPATCHER_ON_CREATE("comfort_kit.dispatch.create"),
        STEP_UP("comfort_kit.dispatch.create"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const body = parse(CreateDispatchBody, request.body);
      const created = await writeService.createDispatch(writeActorOf(request), body);
      return reply.code(201).send(created);
    },
  );

  // 21 — dispatch list (per patient, per Location, or per IPU room for the D17 stock-kit view).
  app.get(
    "/api/v1/supplies/comfort-kit-dispatches",
    {
      preHandler: [P("comfort_kit.dispatch.read"), NO_OFFSET],
      config: { auditRead: { resourceKind: "comfort_kit_dispatch", list: true } },
    },
    async (request) =>
      readService.listDispatches(actorOf(request), parseQuery(ListDispatchesQuery, request.query)),
  );

  // 22 — dispatch detail with the full per-line manifest (lot numbers, expirations, schedules).
  app.get(
    "/api/v1/supplies/comfort-kit-dispatches/:dispatchId",
    {
      preHandler: [P("comfort_kit.dispatch.read")],
      config: { auditRead: DISPATCH_READ },
    },
    async (request) => {
      const { dispatchId } = parse(DispatchIdParams, request.params);
      return readService.getDispatch(actorOf(request), dispatchId);
    },
  );

  // 23 — the kit is physically at the patient. This is the event M13 builds its deployment rows FROM, so
  //      the emitted payload carries the whole manifest (§4.5.2) rather than making M13 read back.
  app.post(
    "/api/v1/supplies/comfort-kit-dispatches/:dispatchId/deploy-at-patient",
    { preHandler: [P("comfort_kit.dispatch.deploy"), IDEMPOTENT] },
    async (request) => {
      const { dispatchId } = parse(DispatchIdParams, request.params);
      const body = parse(DeployAtPatientBody, request.body);
      return writeService.markDeployedAtPatient(writeActorOf(request), dispatchId, {
        expectedUpdatedAt: ifMatchStamp(request, true),
        ...body,
      });
    },
  );

  // §8.1 — the DEA 21 CFR §1304 perpetual log for one kit, which is the unit an inspector asks for. Its
  //        own key (see the module header).
  app.get(
    "/api/v1/supplies/comfort-kit-dispatches/:dispatchId/perpetual-log",
    {
      preHandler: [P("comfort_kit.perpetual_log.read")],
      config: {
        auditRead: {
          resourceKind: "comfort_kit_dispatched_content",
          resourceIdParam: "dispatchId",
        },
      },
    },
    async (request) => {
      const { dispatchId } = parse(DispatchIdParams, request.params);
      return readService.getPerpetualLog(actorOf(request), dispatchId);
    },
  );

  // 24 — open a return obligation. Refused when M13 has not yet acked the deployment:
  //      `comfort_kit_return.m13_deployment_id` is NOT NULL (§3.1.10) because M13 closes its drawdowns
  //      against it, and a return with nothing to close is a record of a count nobody can reconcile.
  app.post(
    "/api/v1/supplies/comfort-kit-returns",
    { preHandler: [P("comfort_kit.return.create"), IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(CreateReturnBody, request.body);
      const created = await writeService.createReturn(writeActorOf(request), body);
      return reply.code(201).send(created);
    },
  );

  // 25 — the reconciliation worklist. Ordered by OLDEST due date first: the point of the list is what is
  //      most overdue, and `daysOverdue` is computed at read time from `return_due_at`.
  app.get(
    "/api/v1/supplies/comfort-kit-returns",
    {
      preHandler: [P("comfort_kit.return.read"), NO_OFFSET],
      config: { auditRead: { resourceKind: "comfort_kit_return", list: true } },
    },
    async (request) =>
      readService.listReturns(actorOf(request), parseQuery(ListReturnsQuery, request.query)),
  );

  // 26 — return detail with the per-line accounting and the disposal record.
  app.get(
    "/api/v1/supplies/comfort-kit-returns/:returnId",
    { preHandler: [P("comfort_kit.return.read")], config: { auditRead: RETURN_READ } },
    async (request) => {
      const { returnId } = parse(ReturnIdParams, request.params);
      return readService.getReturn(actorOf(request), returnId);
    },
  );

  // §2.6 — assign the supply-team member who will physically retrieve. Not in §4.1's table, but the
  //        machine has the edge and §4.4's separation-of-duties clause compares the retriever against the
  //        witness, so somebody has to be able to set it. Gated on the return-create key: taking a
  //        retrieval is the same authority as opening the obligation.
  app.post(
    "/api/v1/supplies/comfort-kit-returns/:returnId/assign-retriever",
    { preHandler: [P("comfort_kit.return.create"), IDEMPOTENT] },
    async (request) => {
      const { returnId } = parse(ReturnIdParams, request.params);
      const body = parse(AssignRetrieverBody, request.body);
      return writeService.assignRetriever(writeActorOf(request), returnId, {
        expectedUpdatedAt: ifMatchStamp(request, true),
        ...body,
      });
    },
  );

  // 27 — reconcile. The D8 discrepancy is COMPUTED from the quantities and never accepted from the body:
  //      a flag the reconciler can set is one they can clear, and §7.3 is explicit that only an M30
  //      investigation closure marks a discrepancy explained.
  app.post(
    "/api/v1/supplies/comfort-kit-returns/:returnId/reconcile",
    {
      preHandler: [
        P("comfort_kit.return.reconcile"),
        ABAC_RECONCILER("comfort_kit.return.reconcile"),
        STEP_UP("comfort_kit.return.reconcile"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { returnId } = parse(ReturnIdParams, request.params);
      const body = parse(ReconcileReturnBody, request.body);
      return writeService.reconcileReturn(writeActorOf(request), returnId, {
        expectedUpdatedAt: ifMatchStamp(request, true),
        disposalMethod: body.disposalMethod,
        disposalWitnessMembershipId: body.disposalWitnessMembershipId as never,
        perMedicationReconciliation: body.perMedicationReconciliation,
        disposalNotes: body.disposalNotes,
        discrepancyNotes: body.discrepancyNotes,
      });
    },
  );

  // §2.6 — the 90-day assumption of loss. Deliberately NOT folded into `reconcile`: writing off a kit that
  //        held a CII solution is a different authority from counting one that came back, and §3.1.10's
  //        CHECK requires an attested reason from a named human either way.
  app.post(
    "/api/v1/supplies/comfort-kit-returns/:returnId/declare-unreturnable",
    {
      preHandler: [
        P("comfort_kit.return.declare_unreturnable"),
        ABAC_RECONCILER("comfort_kit.return.declare_unreturnable"),
        STEP_UP("comfort_kit.return.declare_unreturnable"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { returnId } = parse(ReturnIdParams, request.params);
      const body = parse(DeclareUnreturnableBody, request.body);
      return writeService.declareUnreturnable(writeActorOf(request), returnId, {
        expectedUpdatedAt: ifMatchStamp(request, true),
        ...body,
      });
    },
  );
}
