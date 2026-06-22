// apps/backend/src/modules/07-care-plan/routes/care-plan-routes.ts — M7-T05 the §4.1 route inventory
// behind the REAL Authorization Contract (`requirePermission` from @wardenx/auth, M3) on the §4.5 keys
// M7 contributes to M3's catalog (M7_CONTRIBUTED_PERMISSIONS). Org binding is server-side
// (`request.context`, never the body). Handlers compose over the injected `CarePlanRouteService`
// (in-memory slice; Drizzle in prod under withOrgContext so RLS backstops).
//
// §4.1.1 (M07-F09) — the three PATCH routes additionally carry `requireIdempotencyKey` + `requireIfMatch`
// pre-handlers (./concurrency.ts). `Idempotency-Key` presence is enforced here; the replay/body-mismatch
// caching is the M1 platform middleware (applyIdempotency, mounted globally). `If-Match` carries the row
// version the client read; the service raises 412 STALE_VERSION on skew (§7.7).
//
// The §4 ABAC composition (`caseload_or_scope` ∧ `discipline_scope` ∧ `sud_disclosure_allowed`,
// `signer_role_match`) lands with the authoring work (M7-T06); the keys + RBAC gating land here.
import { requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { InterventionDiscipline } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSeam } from "../../../bootstrap/index";
import { disciplineScopeOf } from "../abac-predicates";
import {
  BootstrapCarePlanSchema,
  CreateGoalSchema,
  CreateInterventionSchema,
  CreateProblemSchema,
  CreateVersionSchema,
  DiscontinueInterventionSchema,
  FinalizeVersionSchema,
  PatchGoalSchema,
  PatchInterventionSchema,
  PatchProblemSchema,
  PatientParamsSchema,
  PlanElementParamsSchema,
  PlanParamsSchema,
  PlanVersionParamsSchema,
  RelevantElementsQuerySchema,
  ResolveProblemSchema,
  ReturnToDraftSchema,
  SignVersionSchema,
  parse,
} from "./care-plan-typebox";
import {
  type PreHandler,
  ifMatchVersionOf,
  requireIdempotencyKey,
  requireIfMatch,
} from "./concurrency";
import type { CarePlanRouteService } from "./service";

export interface CarePlanRouteDeps {
  service: CarePlanRouteService;
  /** Resolves whether an agent-stated goal's DPOA consent is active (M39 seam; default deny in slice). */
  dpoaConsentActive?: (q: {
    organizationId: string;
    patientId: string;
    planId: string;
  }) => Promise<boolean>;
  /**
   * Resolves whether the caller may see SUD-flagged problems for this patient (§7.6, M39 `42_cfr_part_2_release`).
   * Fail-closed: defaults to deny, so SUD problems are omitted from reads unless an authoritative consent allows.
   */
  sudDisclosureAllowed?: (q: {
    organizationId: string;
    patientId: string;
    planId: string;
  }) => Promise<boolean>;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

// Static permission guards (§4.5).
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("care_plan.read");
const READ_SUMMARY = P("care_plan.read_summary");
const BOOTSTRAP = P("care_plan.bootstrap");
const AUTHOR = P("care_plan.author");
const FINALIZE = P("care_plan.finalize");
const SIGN = P("care_plan.sign");

// §4.1.1 PATCH pre-handlers: Idempotency-Key presence (400) + If-Match version (428/400).
const IDEMPOTENT = requireIdempotencyKey();
const IF_MATCH = requireIfMatch();

const planIdOf = (request: FastifyRequest): string =>
  parse(PlanParamsSchema, request.params).planId;

export function registerCarePlanRoutes(app: FastifyInstance, deps: CarePlanRouteDeps): void {
  const { service } = deps;
  const dpoaConsentActive = deps.dpoaConsentActive ?? (async () => false);
  // §7.6 fail-closed default: a SUD-flagged problem is omitted from a read unless consent says otherwise.
  const sudDisclosureAllowed = deps.sudDisclosureAllowed ?? (async () => false);

  // ── Care plan (patient-scoped) ─────────────────────────────────────────────────────────────────
  app.get("/api/v1/patients/:patientId/care-plan", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { patientId } = parse(PatientParamsSchema, request.params);
    const allowSud = await sudDisclosureAllowed({ organizationId, patientId, planId: "" });
    const row = await service.getCarePlanForPatient(organizationId, patientId, {
      sudDisclosureAllowed: allowSud,
    });
    if (!row) return { carePlan: null };
    return row;
  });

  app.post(
    "/api/v1/patients/:patientId/care-plan",
    { preHandler: [BOOTSTRAP] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientParamsSchema, request.params);
      const body = parse(BootstrapCarePlanSchema, request.body);
      const res = await service.bootstrapCarePlan(organizationId, patientId, body.admissionId);
      return reply.code(201).send(res);
    },
  );

  // ── Versions ───────────────────────────────────────────────────────────────────────────────────
  app.get("/api/v1/care-plans/:planId/versions", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    return service.listVersions(organizationId, planIdOf(request));
  });

  app.get(
    "/api/v1/care-plans/:planId/versions/:versionId",
    { preHandler: [READ] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { planId, versionId } = parse(PlanVersionParamsSchema, request.params);
      return service.getVersion(organizationId, planId, versionId);
    },
  );

  app.post(
    "/api/v1/care-plans/:planId/versions",
    { preHandler: [AUTHOR] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const body = parse(CreateVersionSchema, request.body);
      const res = await service.createVersion(
        organizationId,
        planIdOf(request),
        body.kind,
        body.idgMeetingId ?? null,
      );
      return reply.code(201).send(res);
    },
  );

  app.post(
    "/api/v1/care-plans/:planId/versions/:versionId/finalize",
    { preHandler: [FINALIZE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { planId, versionId } = parse(PlanVersionParamsSchema, request.params);
      const body = parse(FinalizeVersionSchema, request.body);
      return service.finalizeVersion(
        organizationId,
        planId,
        versionId,
        body.ifVersion,
        body.requiredSignerSet ?? null,
      );
    },
  );

  app.post(
    "/api/v1/care-plans/:planId/versions/:versionId/signatures",
    { preHandler: [SIGN] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { planId, versionId } = parse(PlanVersionParamsSchema, request.params);
      const body = parse(SignVersionSchema, request.body);
      const res = await service.signVersion(
        organizationId,
        planId,
        versionId,
        body.ifVersion,
        body.signerRole,
        new Date().toISOString(),
      );
      return reply.code(201).send(res);
    },
  );

  app.post(
    "/api/v1/care-plans/:planId/versions/:versionId/return-to-draft",
    { preHandler: [AUTHOR] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { planId, versionId } = parse(PlanVersionParamsSchema, request.params);
      const body = parse(ReturnToDraftSchema, request.body);
      return service.returnVersionToDraft(organizationId, planId, versionId, body.ifVersion);
    },
  );

  // ── Problems ─────────────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/care-plans/:planId/problems",
    { preHandler: [AUTHOR] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const body = parse(CreateProblemSchema, request.body);
      const res = await service.addProblem(organizationId, planIdOf(request), {
        icd10Code: body.icd10Code,
        snomedCode: body.snomedCode,
        description: body.description,
        kind: body.kind,
        source: body.source,
        sudRelated: body.sudRelated,
      });
      return reply.code(201).send(res);
    },
  );

  app.patch(
    "/api/v1/care-plans/:planId/problems/:elementId",
    { preHandler: [AUTHOR, IDEMPOTENT, IF_MATCH] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { planId, elementId } = parse(PlanElementParamsSchema, request.params);
      const body = parse(PatchProblemSchema, request.body);
      return service.patchProblem(
        organizationId,
        planId,
        elementId,
        ifMatchVersionOf(request),
        body,
      );
    },
  );

  app.post(
    "/api/v1/care-plans/:planId/problems/:elementId/resolve",
    { preHandler: [AUTHOR] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { planId, elementId } = parse(PlanElementParamsSchema, request.params);
      const body = parse(ResolveProblemSchema, request.body);
      return service.resolveProblem(
        organizationId,
        planId,
        elementId,
        body.ifVersion,
        body.resolutionNote,
      );
    },
  );

  // ── Goals ───────────────────────────────────────────────────────────────────────────────────
  app.post("/api/v1/care-plans/:planId/goals", { preHandler: [AUTHOR] }, async (request, reply) => {
    const { organizationId } = actorOf(request);
    const planId = planIdOf(request);
    const body = parse(CreateGoalSchema, request.body);
    const dpoa =
      body.source === "agent_stated"
        ? await dpoaConsentActive({ organizationId, patientId: "", planId })
        : false;
    const res = await service.addGoal(
      organizationId,
      planId,
      {
        problemId: body.problemId,
        originalText: body.originalText,
        source: body.source,
        actingConsentId: body.actingConsentId,
        measurableOutcome: body.measurableOutcome,
      },
      dpoa,
    );
    return reply.code(201).send(res);
  });

  app.patch(
    "/api/v1/care-plans/:planId/goals/:elementId",
    { preHandler: [AUTHOR, IDEMPOTENT, IF_MATCH] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { planId, elementId } = parse(PlanElementParamsSchema, request.params);
      const body = parse(PatchGoalSchema, request.body);
      return service.patchGoal(organizationId, planId, elementId, ifMatchVersionOf(request), body);
    },
  );

  // ── Interventions ────────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/care-plans/:planId/interventions",
    { preHandler: [AUTHOR] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const body = parse(CreateInterventionSchema, request.body);
      // §7.4 discipline_scope — enforced server-side from the session's assembled discipline scope (never
      // the body's subject), mirroring the `discipline_scope` ABAC predicate; 403 unless the caller's
      // discipline matches (the IDG Coordinator is the cross-discipline exception).
      const res = await service.addIntervention(
        organizationId,
        planIdOf(request),
        {
          problemId: body.problemId,
          goalRefs: body.goalRefs,
          scopeText: body.scopeText,
          frequencyText: body.frequencyText,
          frequencyValue: body.frequencyValue,
          discipline: body.discipline,
          responsibleRole: body.responsibleRole,
        },
        disciplineScopeOf(request.context),
      );
      return reply.code(201).send(res);
    },
  );

  app.patch(
    "/api/v1/care-plans/:planId/interventions/:elementId",
    { preHandler: [AUTHOR, IDEMPOTENT, IF_MATCH] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { planId, elementId } = parse(PlanElementParamsSchema, request.params);
      const body = parse(PatchInterventionSchema, request.body);
      return service.patchIntervention(
        organizationId,
        planId,
        elementId,
        ifMatchVersionOf(request),
        body,
      );
    },
  );

  app.post(
    "/api/v1/care-plans/:planId/interventions/:elementId/discontinue",
    { preHandler: [AUTHOR] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { planId, elementId } = parse(PlanElementParamsSchema, request.params);
      const body = parse(DiscontinueInterventionSchema, request.body);
      return service.discontinueIntervention(
        organizationId,
        planId,
        elementId,
        body.ifVersion,
        body.reason,
      );
    },
  );

  // ── Summary + overdue + internal element picker (reads over the §7.8 CarePlanReader seam) ───────
  app.get("/api/v1/care-plans/:planId/summary", { preHandler: [READ_SUMMARY] }, async (request) => {
    const { organizationId } = actorOf(request);
    const planId = planIdOf(request);
    const allowSud = await sudDisclosureAllowed({ organizationId, patientId: "", planId });
    return service.getSummary(organizationId, planId, { sudDisclosureAllowed: allowSud });
  });

  app.get("/api/v1/care-plans/:planId/overdue-status", { preHandler: [READ] }, async (request) => {
    actorOf(request);
    const q = parse(RelevantElementsQuerySchema, request.query);
    return getSeam("CarePlanReader").isReviewOverdue(q.patientId);
  });

  app.get(
    "/api/v1/internal/care-plan/relevant-elements",
    { preHandler: [READ] },
    async (request) => {
      actorOf(request);
      const q = parse(RelevantElementsQuerySchema, request.query);
      return getSeam("CarePlanReader").relevantElementsForEncounter(
        q.patientId,
        q.encounterType ?? "routine",
        (q.discipline ?? "rn") as InterventionDiscipline,
      );
    },
  );
}
