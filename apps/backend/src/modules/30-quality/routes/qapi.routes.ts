// apps/backend/src/modules/30-quality/routes/qapi.routes.ts — M30 (§4.1 R-20..R-33).
//
// The QAPI surface: programs (annual charter), indicators (threshold + current band), PI projects, PIP
// cycles, and governance-committee minutes. Every route is gated by the REAL Authorization Contract
// (`requirePermission` from @wardenx/auth, M3) on the §4.6 `qapi.*` keys; the project-scoped mutations
// (R-28 phase/intervention edit, R-30 add-PIP) additionally layer the `ownsQapiProject` predicate M30
// OWNS (§4.7 — project lead OR `qapi.admin`), resolved off the route's `:projectId` param. R-31 (close
// a PIP) is the TWO-PERSON co-sign route (V-11): the route gates RBAC on `qapi.close` and passes the
// cosigner + actor to the write service, where `assertPipCloseSplitActor` (DELEGATING to the
// @wardenx/quality canonical guard) enforces the split-actor invariant against the persisted charterer —
// the `qapiCloseAuthority` predicate keys on a `cosignerUserId` the route cannot resolve synchronously
// from the body's membership ids, so the authoritative close-authority check is the service's V-11 +
// the §3 DB check constraint (the route layer never trusts a body-supplied identity).
//
// MUTATIONS run through the injected write service → ONE `withOrgContext` tx on the PRIMARY (RLS scopes
// every statement to `app.org_id`); each non-idempotent POST/PATCH carries `requireIdempotencyKey`
// (presence guard; the M1 `applyIdempotency` middleware does the 24h replay caching). READS disclose the
// actor's own-org QAPI rows (aggregate; no PHI) cursor-paginated per §4.1.2. Org/actor/owner binding is
// ALWAYS server-side (`request.context`, never the body). Mirrors M33 routes/definitions.routes.ts.
import { requireAbac, requirePermission } from "@wardenx/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import {
  AddQapiPipBodySchema,
  AdoptQapiProgramBodySchema,
  CharterQapiProjectBodySchema,
  CloseQapiPipBodySchema,
  CreateQapiIndicatorBodySchema,
  IndicatorIdParamsSchema,
  PipIdParamsSchema,
  ProgramIdParamsSchema,
  ProjectIdParamsSchema,
  QapiGovernanceListQuerySchema,
  QapiIndicatorListQuerySchema,
  QapiPipListQuerySchema,
  QapiProgramListQuerySchema,
  QapiProjectListQuerySchema,
  RecordQapiGovernanceBodySchema,
  UpdateQapiGovernanceBodySchema,
  UpdateQapiIndicatorBodySchema,
  UpdateQapiProjectBodySchema,
  parse,
} from "./quality-typebox";
import type { M30ReadRouteService } from "./read-service";
import type { CloseQapiPipArgs, M30WriteRouteService } from "./write-service";

export interface QapiRouteDeps {
  /** The combined M30 route service (read + write); the P2c Drizzle backend implements both interfaces. */
  readonly service: M30ReadRouteService & M30WriteRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
// `ownsQapiProject` (§4.7) — project lead OR `qapi.admin`; the predicate reads the target `projectId`,
// which the default target (`request.params`) carries on the `:projectId` routes (R-28 / R-30).
const OWNS_PROJECT = (key: string): PreHandler => requireAbac(key, "ownsQapiProject") as PreHandler;

const QAPI_READ = P("qapi.read");
const QAPI_WRITE = P("qapi.write");
const QAPI_ADMIN = P("qapi.admin");
const QAPI_CLOSE = P("qapi.close");
const QAPI_PROJECT_OWN = OWNS_PROJECT("qapi.write");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 QAPI routes (R-20..R-33). */
export function registerQapiRoutes(app: FastifyInstance, deps: QapiRouteDeps): void {
  const { service } = deps;

  // R-20 — list QAPI programs (current + history; cursor-paginated). §4.1.
  app.get(
    "/api/v1/quality/qapi/programs",
    {
      preHandler: [QAPI_READ],
      config: { auditRead: { none: "QAPI program records — no patient data" } },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(QapiProgramListQuerySchema, request.query);
      return service.listQapiPrograms(actor, q.cursor, q.limit);
    },
  );

  // R-21 — adopt a new annual QAPI program (governance composition required). §4.1/§4.2.
  app.post(
    "/api/v1/quality/qapi/programs",
    { preHandler: [QAPI_ADMIN, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(AdoptQapiProgramBodySchema, request.body);
      const res = await service.adoptQapiProgram(actor, {
        planYear: body.planYear,
        governanceComposition: body.governanceComposition,
      });
      return reply.code(201).send(res);
    },
  );

  // R-22 — update a program's governance composition. §4.1/§4.2.
  app.patch(
    "/api/v1/quality/qapi/programs/:programId/governance",
    { preHandler: [QAPI_ADMIN, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { programId } = parse(ProgramIdParamsSchema, request.params);
      const body = parse(UpdateQapiGovernanceBodySchema, request.body);
      const res = await service.updateQapiProgramGovernance(actor, programId, {
        governanceComposition: body.governanceComposition,
      });
      return reply.code(200).send(res);
    },
  );

  // R-23 — list indicators with thresholds + current band (aggregate; cursor-paginated). §4.1.
  app.get(
    "/api/v1/quality/qapi/indicators",
    {
      preHandler: [QAPI_READ],
      config: { auditRead: { none: "QAPI indicator definitions + thresholds — no patient data" } },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(QapiIndicatorListQuerySchema, request.query);
      return service.listQapiIndicators(actor, q.cursor, q.limit);
    },
  );

  // R-24 — create an indicator (binds to a measure_id + threshold). §4.1/§4.2.
  app.post(
    "/api/v1/quality/qapi/indicators",
    { preHandler: [QAPI_ADMIN, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CreateQapiIndicatorBodySchema, request.body);
      const res = await service.createQapiIndicator(actor, {
        qapiProgramId: body.qapiProgramId,
        displayName: body.displayName,
        measureId: body.measureId,
        thresholdDirection: body.thresholdDirection,
        thresholdValue: body.thresholdValue,
        dataPath: body.dataPath,
      });
      return reply.code(201).send(res);
    },
  );

  // R-25 — update an indicator threshold (tenant-tighten check is a service rule). §4.1/§4.2.
  app.patch(
    "/api/v1/quality/qapi/indicators/:indicatorId",
    { preHandler: [QAPI_ADMIN, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { indicatorId } = parse(IndicatorIdParamsSchema, request.params);
      const body = parse(UpdateQapiIndicatorBodySchema, request.body);
      const res = await service.updateQapiIndicator(actor, indicatorId, {
        thresholdValue: body.thresholdValue,
        thresholdDirection: body.thresholdDirection,
        displayName: body.displayName,
      });
      return reply.code(200).send(res);
    },
  );

  // R-26 — list PI projects (filter by phase / program; cursor-paginated). §4.1.
  app.get(
    "/api/v1/quality/qapi/projects",
    {
      preHandler: [QAPI_READ],
      config: { auditRead: { none: "QAPI performance-improvement projects — no patient data" } },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(QapiProjectListQuerySchema, request.query);
      return service.listQapiProjects(
        actor,
        { phases: q.phase, programId: q.programId },
        q.cursor,
        q.limit,
      );
    },
  );

  // R-27 — charter a PI project (from a triggered indicator). §4.1/§4.2.
  app.post(
    "/api/v1/quality/qapi/projects",
    { preHandler: [QAPI_WRITE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CharterQapiProjectBodySchema, request.body);
      const res = await service.charterQapiProject(actor, {
        qapiProgramId: body.qapiProgramId,
        title: body.title,
        indicatorId: body.indicatorId,
        charterNarrative: body.charterNarrative,
      });
      return reply.code(201).send(res);
    },
  );

  // R-28 — update a project's phase / interventions (project lead OR qapi.admin — `ownsQapiProject`). §4.1.
  app.patch(
    "/api/v1/quality/qapi/projects/:projectId",
    { preHandler: [QAPI_WRITE, QAPI_PROJECT_OWN, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { projectId } = parse(ProjectIdParamsSchema, request.params);
      const body = parse(UpdateQapiProjectBodySchema, request.body);
      const res = await service.updateQapiProject(actor, projectId, {
        phase: body.phase,
        interventions: body.interventions,
        ledByMembershipId: body.ledByMembershipId,
      });
      return reply.code(200).send(res);
    },
  );

  // R-29 — list the PIP cycles under a project (cursor-paginated). §4.1.
  app.get(
    "/api/v1/quality/qapi/projects/:projectId/pips",
    {
      preHandler: [QAPI_READ],
      config: { auditRead: { none: "PIP cycles under a QAPI project — no patient data" } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { projectId } = parse(ProjectIdParamsSchema, request.params);
      const q = parse(QapiPipListQuerySchema, request.query);
      return service.listQapiPips(actor, projectId, q.cursor, q.limit);
    },
  );

  // R-30 — add a PIP cycle under a project (`ownsQapiProject`). §4.1/§4.2.
  app.post(
    "/api/v1/quality/qapi/projects/:projectId/pips",
    { preHandler: [QAPI_WRITE, QAPI_PROJECT_OWN, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { projectId } = parse(ProjectIdParamsSchema, request.params);
      const body = parse(AddQapiPipBodySchema, request.body);
      const res = await service.addQapiPip(actor, projectId, { charterText: body.charterText });
      return reply.code(201).send(res);
    },
  );

  // R-31 — close a PIP (TWO-PERSON co-sign, V-11). RBAC gates `qapi.close`; the route passes the cosigner +
  // actor to the write service, where `assertPipCloseSplitActor` enforces the split-actor invariant against
  // the service-injected (persisted) charterer — the closer ≠ charterer SoD is never read off the wire. §4.1.
  app.post(
    "/api/v1/quality/qapi/pips/:pipId/close",
    { preHandler: [QAPI_CLOSE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { pipId } = parse(PipIdParamsSchema, request.params);
      const body = parse(CloseQapiPipBodySchema, request.body);
      const res = await service.closeQapiPip(actor, pipId, {
        conclusionText: body.conclusionText,
        outcome: body.outcome,
        // The wire carries only the two role ids (`PipCosignSchema`); `charteredByMembershipId` is
        // injected by the write service from the persisted PIP row before `assertPipCloseSplitActor`
        // (closer ≠ charterer SoD, V-11) — NEVER read off the body. The scaffolding Arg types `cosign`
        // as the full `PipClosureCosign`, so this narrow cast bridges the documented service-injection gap.
        cosign: body.cosign as CloseQapiPipArgs["cosign"],
      });
      return reply.code(200).send(res);
    },
  );

  // R-32 — record governance-committee minutes (creates a chronological entry). §4.1/§4.2.
  app.post(
    "/api/v1/quality/qapi/governance",
    { preHandler: [QAPI_WRITE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(RecordQapiGovernanceBodySchema, request.body);
      const res = await service.recordQapiGovernance(actor, {
        qapiProgramId: body.qapiProgramId,
        meetingAt: body.meetingAt,
        summary: body.summary,
        attendees: body.attendees,
      });
      return reply.code(201).send(res);
    },
  );

  // R-33 — list governance minutes (org chronological; cursor-paginated). §4.1.
  app.get(
    "/api/v1/quality/qapi/governance",
    {
      preHandler: [QAPI_READ],
      config: {
        auditRead: {
          none: "QAPI governance structure (committee, charter, cadence) — no patient data",
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(QapiGovernanceListQuerySchema, request.query);
      return service.listQapiGovernance(actor, q.cursor, q.limit);
    },
  );
}
