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
// GAP-012 (2026-08-09): the §4 ABAC composition is wired here — `caseload_or_scope` on every
// patient/plan-scoped route (via `SCOPE`/`SCOPE_BY_QUERY_PATIENT` below), `signer_role_match` on the
// signature route, `discipline_scope` on intervention authoring (lifted from the body via `getTarget`,
// per abac-predicates.ts's own header comment — still never trusting the body for anything but the
// discipline being authored). `dpoa_active`/`sud_disclosure_allowed` stay as the existing
// `dpoaConsentActive`/`sudDisclosureAllowed` closures below (per-element data-shaping, not a route
// gate; wiring their real seam-backed implementations at boot is GAP-013, a separate finding).
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { InterventionDiscipline } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSeam } from "../../../bootstrap/index";
import { disciplineScopeOf, membershipIdOf } from "../abac-predicates";
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
   * Resolves whether the caller may see SUD-flagged problems for this patient (§7.6, M39 `42_cfr_part_2_release`
   * OR the assigned RN Case Manager — `roles` carries the caller's session roles for that check).
   * Fail-closed: defaults to deny, so SUD problems are omitted from reads unless an authoritative consent allows.
   */
  sudDisclosureAllowed?: (q: {
    organizationId: string;
    patientId: string;
    planId: string;
    roles: readonly string[];
    /** The actor's ACTIVE membership id — M39's Part 2 verdict is PER-ACTOR (`workforce_member`
     *  recipients), and an unnamed actor against a restricted release is redacted. */
    membershipId: string | null;
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

// GAP-012 — §6 ABAC composition (§4.1 route table). `caseload_or_scope`'s target reads whichever of
// `patientId`/`planId` the route's params already carry (both shapes the predicate supports); every
// M7 route names one directly (no resourceKind dispatch needed — unlike M6, no M7 child route's `:id`
// is anything OTHER than the plan id). `notFoundOnDeny: true` preserves the pre-existing §6.6
// existence-non-leak convention (a cross-tenant/outside-caseload denial must not read differently
// from an absent resource).
const SCOPE = (action: string): PreHandler =>
  requireAbac(action, "caseload_or_scope", { notFoundOnDeny: true }) as PreHandler;

// The overdue-status route's handler resolves entirely off `?patientId=` (its `:planId` path segment
// is never read — see the handler below), so the ABAC target must follow the resource the handler
// actually reads, not the unused path param.
const SCOPE_BY_QUERY_PATIENT = (action: string): PreHandler =>
  requireAbac(action, "caseload_or_scope", {
    notFoundOnDeny: true,
    getTarget: (request) => ({
      patientId: (request.query as { patientId?: unknown } | null)?.patientId,
    }),
  }) as PreHandler;

const SIGNER_MATCH = requireAbac("care_plan.sign", "signer_role_match", {
  notFoundOnDeny: true,
}) as PreHandler;
const SIGN_STEP_UP = requireStepUp("care_plan.sign") as PreHandler;

// `discipline_scope`'s target is the body's `discipline` (the thing being authored) — the one M7
// predicate that reads the body rather than a resolver-loaded resource, per abac-predicates.ts's own
// header comment.
const DISCIPLINE_SCOPE = requireAbac("care_plan.author", "discipline_scope", {
  getTarget: (request) => ({
    discipline: (request.body as { discipline?: unknown } | null)?.discipline,
  }),
}) as PreHandler;

const planIdOf = (request: FastifyRequest): string =>
  parse(PlanParamsSchema, request.params).planId;

function signingActorOf(request: FastifyRequest): { userId: string; membershipId: string } {
  const ctx = request.context;
  const membershipId = membershipIdOf(ctx);
  if (!ctx?.userId || !membershipId) throw new UnauthorizedError();
  return { userId: ctx.userId, membershipId };
}

export function registerCarePlanRoutes(app: FastifyInstance, deps: CarePlanRouteDeps): void {
  const { service } = deps;
  const dpoaConsentActive = deps.dpoaConsentActive ?? (async () => false);
  // §7.6 fail-closed default: a SUD-flagged problem is omitted from a read unless consent says otherwise.
  const sudDisclosureAllowed = deps.sudDisclosureAllowed ?? (async () => false);

  // ── Care plan (patient-scoped) ─────────────────────────────────────────────────────────────────
  app.get(
    "/api/v1/patients/:patientId/care-plan",
    {
      preHandler: [READ, SCOPE("care_plan.read")],
      config: { auditRead: { resourceKind: "care_plan", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientParamsSchema, request.params);
      const allowSud = await sudDisclosureAllowed({
        organizationId,
        patientId,
        planId: "",
        roles: request.context.roles,
        membershipId: membershipIdOf(request.context),
      });
      const row = await service.getCarePlanForPatient(organizationId, patientId, {
        sudDisclosureAllowed: allowSud,
      });
      if (!row) return { carePlan: null };
      return row;
    },
  );

  app.post(
    "/api/v1/patients/:patientId/care-plan",
    { preHandler: [BOOTSTRAP, SCOPE("care_plan.bootstrap")] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientParamsSchema, request.params);
      const body = parse(BootstrapCarePlanSchema, request.body);
      const res = await service.bootstrapCarePlan(organizationId, patientId, body.admissionId);
      return reply.code(201).send(res);
    },
  );

  // ── Versions ───────────────────────────────────────────────────────────────────────────────────
  app.get(
    "/api/v1/care-plans/:planId/versions",
    {
      preHandler: [READ, SCOPE("care_plan.read")],
      config: { auditRead: { resourceKind: "care_plan_version", resourceIdParam: "planId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.listVersions(organizationId, planIdOf(request));
    },
  );

  app.get(
    "/api/v1/care-plans/:planId/versions/:versionId",
    {
      preHandler: [READ, SCOPE("care_plan.read")],
      config: { auditRead: { resourceKind: "care_plan_version", resourceIdParam: "versionId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { planId, versionId } = parse(PlanVersionParamsSchema, request.params);
      return service.getVersion(organizationId, planId, versionId);
    },
  );

  app.post(
    "/api/v1/care-plans/:planId/versions",
    { preHandler: [AUTHOR, SCOPE("care_plan.author")] },
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
    { preHandler: [FINALIZE, SCOPE("care_plan.finalize")] },
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
    { preHandler: [SIGN, SCOPE("care_plan.sign"), SIGNER_MATCH, SIGN_STEP_UP] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const actor = signingActorOf(request);
      const { planId, versionId } = parse(PlanVersionParamsSchema, request.params);
      const body = parse(SignVersionSchema, request.body);
      const res = await service.signVersion(
        organizationId,
        planId,
        versionId,
        body.ifVersion,
        body.signerRole,
        new Date().toISOString(),
        actor,
        body.patientUnderstandingText,
      );
      return reply.code(201).send(res);
    },
  );

  app.post(
    "/api/v1/care-plans/:planId/versions/:versionId/return-to-draft",
    { preHandler: [AUTHOR, SCOPE("care_plan.author")] },
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
    { preHandler: [AUTHOR, SCOPE("care_plan.author")] },
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
    { preHandler: [AUTHOR, SCOPE("care_plan.author"), IDEMPOTENT, IF_MATCH] },
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
    { preHandler: [AUTHOR, SCOPE("care_plan.author")] },
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
  app.post(
    "/api/v1/care-plans/:planId/goals",
    { preHandler: [AUTHOR, SCOPE("care_plan.author")] },
    async (request, reply) => {
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
    },
  );

  app.patch(
    "/api/v1/care-plans/:planId/goals/:elementId",
    { preHandler: [AUTHOR, SCOPE("care_plan.author"), IDEMPOTENT, IF_MATCH] },
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
    { preHandler: [AUTHOR, SCOPE("care_plan.author"), DISCIPLINE_SCOPE] },
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
    { preHandler: [AUTHOR, SCOPE("care_plan.author"), IDEMPOTENT, IF_MATCH] },
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
    { preHandler: [AUTHOR, SCOPE("care_plan.author")] },
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
  app.get(
    "/api/v1/care-plans/:planId/readiness",
    {
      preHandler: [READ, SCOPE("care_plan.read")],
      config: { auditRead: { resourceKind: "care_plan", resourceIdParam: "planId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.getReadiness(organizationId, planIdOf(request));
    },
  );

  app.get(
    "/api/v1/care-plans/:planId/versions/:versionId/proposed-changes",
    {
      preHandler: [READ, SCOPE("care_plan.read")],
      config: { auditRead: { resourceKind: "care_plan_version", resourceIdParam: "versionId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { planId, versionId } = parse(PlanVersionParamsSchema, request.params);
      return service.getProposedChanges(organizationId, planId, versionId);
    },
  );

  app.get(
    "/api/v1/care-plans/:planId/review-status",
    {
      preHandler: [READ, SCOPE("care_plan.read")],
      config: { auditRead: { resourceKind: "care_plan", resourceIdParam: "planId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.getReviewStatus(organizationId, planIdOf(request));
    },
  );

  app.get(
    "/api/v1/care-plans/:planId/summary",
    {
      // §4.1: `caseload_or_scope` ∨ `collaborator_patient_match` — the latter is unregistered anywhere
      // in the platform (no module owns it), but `caseload_or_scope`'s own session-scope branch
      // (`sessionScopePatientIds`, abac-predicates.ts) already covers the collaborator/portal-session
      // case, so it subsumes the OR clause without a second predicate.
      preHandler: [READ_SUMMARY, SCOPE("care_plan.read_summary")],
      config: { auditRead: { resourceKind: "care_plan", resourceIdParam: "planId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const planId = planIdOf(request);
      const allowSud = await sudDisclosureAllowed({
        organizationId,
        patientId: "",
        planId,
        roles: request.context.roles,
        membershipId: membershipIdOf(request.context),
      });
      return service.getSummary(organizationId, planId, { sudDisclosureAllowed: allowSud });
    },
  );

  app.get(
    "/api/v1/care-plans/:planId/overdue-status",
    {
      // Scoped by the query's `patientId` (what the handler actually reads), not the path's `:planId`
      // (unused below) — see `SCOPE_BY_QUERY_PATIENT`'s doc comment.
      preHandler: [READ, SCOPE_BY_QUERY_PATIENT("care_plan.read")],
      config: { auditRead: { resourceKind: "care_plan", resourceIdParam: "planId" } },
    },
    async (request) => {
      actorOf(request);
      const q = parse(RelevantElementsQuerySchema, request.query);
      return getSeam("CarePlanReader").isReviewOverdue(q.patientId);
    },
  );

  app.get(
    "/api/v1/internal/care-plan/relevant-elements",
    // GAP-182 — this was deliberately un-gated ("M8 caller asserts scope"), but the route takes ANY
    // `patientId` and the web encounter screen calls it with a HUMAN session, so "the caller asserts" meant
    // nobody did. It is now scoped like every other patient-keyed M7 read: `caseload_or_scope` over the
    // query's `patientId` (org-wide scope roles pass; everyone else needs the patient on their caseload).
    {
      preHandler: [READ, SCOPE_BY_QUERY_PATIENT("care_plan.read")],
      config: { auditRead: { resourceKind: "care_plan_element" } },
    },
    async (request) => {
      actorOf(request);
      const q = parse(RelevantElementsQuerySchema, request.query);
      return getSeam("CarePlanReader").relevantElementsForEncounter(
        q.patientId,
        q.encounterType ?? "routine",
        (q.discipline ?? "rn") as InterventionDiscipline,
        q.admissionId,
      );
    },
  );
}
