// apps/backend/src/modules/15-discipline-care-plans/routes/plans.routes.ts — M15 (§4.1) routes 1–14: the
// discipline-plan read surface, the version finalize/sign ladder, and the goal / intervention / assessment
// authoring surface.
//
// Every route gates on its §4.4 `requirePermission` key; the sign / amend routes add the §4.1 "session
// (step-up)" gate; every mutation declares `Idempotency-Key` (§F08) and the PATCH/state routes require
// `If-Match` (§2.5 — a blind write is refused, not last-write-wins). Every PHI GET declares its M4 read
// audit (§4.1 "All PHI routes carry auditRead()").
//
// The §7.8/§7.9 confidentiality gates are NOT route guards: withholding a SUD goal is a filtered body plus
// a `redacted_categories` marker, not a 403 — the read service resolves them per patient and applies them
// in SQL (see `./disclosure.ts`).
import { NotFoundError } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import { P, STEP_UP, planCaseloadScope } from "./guards";
import {
  AmendAssessmentBody,
  AssessmentParams,
  CreateAssessmentBody,
  CreateGoalBody,
  CreateInterventionBody,
  FinalizeVersionBody,
  GoalParams,
  InterventionParams,
  PlanListQuerySchema,
  PlanParams,
  SignVersionBody,
  UpdateGoalBody,
  UpdateInterventionBody,
  VersionListQuerySchema,
  VersionParams,
  parse,
  parseQuery,
} from "./m15-typebox";
import type { M15ReadService } from "./read-service";
import type { M15WriteService } from "./write-service";

export interface PlanRouteDeps {
  readonly readService: M15ReadService;
  readonly writeService: M15WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

/** The M4 read-audit declaration every PHI plan read carries (§4.1 / M4 §2.5). */
const PLAN_READ = { resourceKind: "discipline_care_plan", resourceIdParam: "planId" } as const;

export function registerDisciplinePlanRoutes(app: FastifyInstance, deps: PlanRouteDeps): void {
  const { readService, writeService } = deps;
  // GAP-046 — every plan write is caseload-scoped over the plan's patient (404 off-caseload / unknown plan).
  const scope = (key: string) =>
    planCaseloadScope(key, (actor, planId) => writeService.planPatientId(actor, planId));

  // 1 — plan worklist (cursor-paginated, §4.6.1).
  app.get(
    "/api/v1/discipline-plans",
    {
      preHandler: [P("discipline_plan.read"), NO_OFFSET],
      config: { auditRead: { resourceKind: "discipline_care_plan", list: true } },
    },
    async (request) =>
      readService.listPlans(actorOf(request), parseQuery(PlanListQuerySchema, request.query)),
  );

  // 2 — the full plan (SQL-filtered per §7.8/§7.9; `redacted_categories` rides the body).
  app.get(
    "/api/v1/discipline-plans/:planId",
    { preHandler: [P("discipline_plan.read")], config: { auditRead: PLAN_READ } },
    async (request) => {
      const { planId } = parse(PlanParams, request.params);
      const plan = await readService.getPlan(actorOf(request), planId);
      // Off-caseload is indistinguishable from absent — the 404 leaks nothing about who exists.
      if (!plan) throw new NotFoundError("discipline plan not found");
      return plan;
    },
  );

  // 3 — the patient-shareable summary (both confidential categories always stripped, §7.9).
  app.get(
    "/api/v1/discipline-plans/:planId/summary",
    { preHandler: [P("discipline_plan.read_summary")], config: { auditRead: PLAN_READ } },
    async (request) => {
      const { planId } = parse(PlanParams, request.params);
      const summary = await readService.getPlanSummary(actorOf(request), planId);
      if (!summary) throw new NotFoundError("discipline plan not found");
      return summary;
    },
  );

  // 4 — the version chain (cursor-paginated).
  app.get(
    "/api/v1/discipline-plans/:planId/versions",
    { preHandler: [P("discipline_plan.read"), NO_OFFSET], config: { auditRead: PLAN_READ } },
    async (request) => {
      const { planId } = parse(PlanParams, request.params);
      const page = await readService.listVersions(
        actorOf(request),
        planId,
        parseQuery(VersionListQuerySchema, request.query),
      );
      if (!page) throw new NotFoundError("discipline plan not found");
      return page;
    },
  );

  // 5 — one version + its sealed snapshot + collected signatures.
  app.get(
    "/api/v1/discipline-plans/:planId/versions/:versionId",
    { preHandler: [P("discipline_plan.read")], config: { auditRead: PLAN_READ } },
    async (request) => {
      const { planId, versionId } = parse(VersionParams, request.params);
      const version = await readService.getVersion(actorOf(request), planId, versionId);
      if (!version) throw new NotFoundError("plan version not found");
      return version;
    },
  );

  // 6 — finalize a draft version (`draft → in_review`; seals the snapshot + the D11 quorum).
  app.post(
    "/api/v1/discipline-plans/:planId/versions/:versionId/finalize",
    {
      preHandler: [P("discipline_plan.finalize"), ...scope("discipline_plan.finalize"), IDEMPOTENT],
    },
    async (request) => {
      const { planId, versionId } = parse(VersionParams, request.params);
      const body = parse(FinalizeVersionBody, request.body);
      return writeService.finalizeVersion(writeActorOf(request), planId, versionId, {
        expectedVersion: ifMatchVersion(request, true),
        requiredSignerSet: body.requiredSignerSet,
      });
    },
  );

  // 7 — sign one slot of the sealed quorum (step-up; the last signature flips the version to `signed`
  // and emits the M22 plan-PDF render handshake).
  app.post(
    "/api/v1/discipline-plans/:planId/versions/:versionId/sign",
    {
      preHandler: [
        P("discipline_plan.sign"),
        ...scope("discipline_plan.sign"),
        STEP_UP("discipline_plan.sign"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { planId, versionId } = parse(VersionParams, request.params);
      const body = parse(SignVersionBody, request.body);
      return writeService.signVersion(writeActorOf(request), planId, versionId, {
        expectedVersion: ifMatchVersion(request, true),
        signerRole: body.signerRole,
        attestationText: body.attestationText,
        isAcknowledgment: body.isAcknowledgment,
      });
    },
  );

  // 8 — author a discipline goal under an IPOC problem.
  app.post(
    "/api/v1/discipline-plans/:planId/goals",
    { preHandler: [P("discipline_plan.author"), ...scope("discipline_plan.author"), IDEMPOTENT] },
    async (request, reply) => {
      const { planId } = parse(PlanParams, request.params);
      const body = parse(CreateGoalBody, request.body);
      const created = await writeService.createGoal(writeActorOf(request), planId, body);
      return reply.code(201).send(created);
    },
  );

  // 9 — edit a goal (status event and/or refinement fields; `original_text` is immutable, §2.3).
  app.patch(
    "/api/v1/discipline-plans/:planId/goals/:goalId",
    { preHandler: [P("discipline_plan.author"), ...scope("discipline_plan.author"), IDEMPOTENT] },
    async (request) => {
      const { planId, goalId } = parse(GoalParams, request.params);
      const body = parse(UpdateGoalBody, request.body);
      return writeService.updateGoal(writeActorOf(request), planId, goalId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );

  // 10 — author a discipline intervention.
  app.post(
    "/api/v1/discipline-plans/:planId/interventions",
    { preHandler: [P("discipline_plan.author"), ...scope("discipline_plan.author"), IDEMPOTENT] },
    async (request, reply) => {
      const { planId } = parse(PlanParams, request.params);
      const body = parse(CreateInterventionBody, request.body);
      const created = await writeService.createIntervention(writeActorOf(request), planId, body);
      return reply.code(201).send(created);
    },
  );

  // 11 — edit an intervention.
  app.patch(
    "/api/v1/discipline-plans/:planId/interventions/:interventionId",
    { preHandler: [P("discipline_plan.author"), ...scope("discipline_plan.author"), IDEMPOTENT] },
    async (request) => {
      const { planId, interventionId } = parse(InterventionParams, request.params);
      const body = parse(UpdateInterventionBody, request.body);
      return writeService.updateIntervention(writeActorOf(request), planId, interventionId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );

  // 12 — capture a discipline assessment (draft).
  app.post(
    "/api/v1/discipline-plans/:planId/assessments",
    {
      preHandler: [
        P("discipline_assessment.author"),
        ...scope("discipline_assessment.author"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const { planId } = parse(PlanParams, request.params);
      const body = parse(CreateAssessmentBody, request.body);
      const created = await writeService.createAssessment(writeActorOf(request), planId, body);
      return reply.code(201).send(created);
    },
  );

  // 13 — sign an assessment (step-up; a signed INITIAL closes the D10 5-day clock).
  app.post(
    "/api/v1/discipline-plans/:planId/assessments/:assessmentId/sign",
    {
      preHandler: [
        P("discipline_assessment.sign"),
        ...scope("discipline_assessment.sign"),
        STEP_UP("discipline_assessment.sign"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { planId, assessmentId } = parse(AssessmentParams, request.params);
      return writeService.signAssessment(writeActorOf(request), planId, assessmentId, {
        expectedVersion: ifMatchVersion(request, true),
      });
    },
  );

  // 14 — amend a signed assessment (step-up; append-only correction of record, M9 D9).
  app.post(
    "/api/v1/discipline-plans/:planId/assessments/:assessmentId/amend",
    {
      preHandler: [
        P("discipline_assessment.amend"),
        ...scope("discipline_assessment.amend"),
        STEP_UP("discipline_assessment.amend"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const { planId, assessmentId } = parse(AssessmentParams, request.params);
      const body = parse(AmendAssessmentBody, request.body);
      const amendment = await writeService.amendAssessment(
        writeActorOf(request),
        planId,
        assessmentId,
        { expectedVersion: ifMatchVersion(request, true), ...body },
      );
      return reply.code(201).send(amendment);
    },
  );
}
