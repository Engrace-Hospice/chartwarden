import { ASSESSMENT_DISCIPLINES, disciplineCanRecordScale } from "@wardenx/assessments";
// apps/backend/src/modules/09-assessments/routes/assessments-routes.ts — M9-T05 the §4.1 route inventory
// (18 routes) behind the REAL Authorization Contract (`requirePermission`/`requireAbac` from @wardenx/auth,
// M3) on the §4.6 keys M9 registers into M3's catalog (M9_CONTRIBUTED_PERMISSIONS). Org binding is
// server-side (`request.context`, never the body). Handlers compose over the injected AssessmentRouteService
// (in-memory slice; Drizzle in prod under `withOrgContext` so RLS backstops).
//
// §4.7 wiring: the author/correction routes add `requireAbac('discipline_can_record_scale')` (the D8 typed
// matrix M9 owns; target lifted from the body's `scaleType`); the cosign route adds `m9.cosigner_role_match`
// (RN/Clinical-Supervisor ∧ not-self-recorder). The shared `caseload_or_scope` / Part-2 `sud_disclosure_allowed`
// / `dpoa_active` predicates are registered by M5/M7 (resolving through M39's `ConsentEvaluator` seam); M9
// binds the Part 2 / DPOA gate by enforcing it in the service (`DPOA_CONSENT_REQUIRED` on the write path,
// `redacted` projection on reads — M09-F05 keeps SUD off the write predicate). §2.3: the correction route
// carries the parent row version in `If-Match` → 412 STALE_VERSION on skew.
//
// GAP-015 (2026-08-09): the §4.1 route table also requires `caseload_or_scope` on 11 routes — this file
// previously wired it on NONE, so any staff member holding `assessment.read`/`author` could reach any
// patient's assessments org-wide. The 9 routes whose own path already carries `patientId` bind the shared
// `caseload_or_scope` (M7-owned) directly by name (`SCOPE_FOR`, default `getTarget`); the 2 routes keyed by
// a different id (cosignatures' assessmentId, acknowledge's eventId) bind the new M9-owned `assessment.scope`
// predicate instead (`ASSESSMENT_SCOPE_FOR` — see abac-predicates.ts header for why). The 2 internal batch
// routes and the 4 admin license/policy routes are unchanged (spec ABAC column is "caller asserts" / "—").
import { type AbacTarget, requireAbac, requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { ScaleType } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AcknowledgeChangeSchema,
  AssessmentListQuerySchema,
  AssessmentParamsSchema,
  ChangeEventParamsSchema,
  CorrectAssessmentSchema,
  CreateLicenseSchema,
  DeltaQuerySchema,
  LatestBatchQuerySchema,
  LicenseParamsSchema,
  PatientAssessmentParamsSchema,
  PatientParamsSchema,
  PatientScaleParamsSchema,
  RecordAssessmentSchema,
  ScalePolicyParamsSchema,
  SeriesBatchQuerySchema,
  SeriesQuerySchema,
  UpdateLicenseSchema,
  UpdateScalePolicySchema,
  parse,
} from "./assessments-typebox";
import { ifMatchVersionOf, requireIfMatch } from "./concurrency";
import type { AssessmentRouteService } from "./service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AssessmentRouteDeps {
  service: AssessmentRouteService;
}

function actorOf(request: FastifyRequest): {
  organizationId: string;
  userId: string;
  roles: readonly string[];
} {
  const ctx = request.context;
  // `userId` here is the codebase-wide convention of "the acting MEMBERSHIP id" — same bug/fix as
  // M8 (encounters-routes.ts) and M10 (hope-routes.ts): this used to read `ctx.userId` (the raw
  // Better Auth user id, a DIFFERENT id from the org membership).
  const membershipId = ctx?.attributes.membershipId;
  if (!ctx?.organizationId || typeof membershipId !== "string") throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: membershipId, roles: ctx.roles };
}

/** The actor's disciplines (role tokens intersected with the matrix's discipline vocabulary). */
function disciplinesOf(roles: readonly string[]): readonly string[] {
  return roles.filter((r) => (ASSESSMENT_DISCIPLINES as readonly string[]).includes(r));
}

/** Pick the caller's discipline that may record `scaleType` (the ABAC predicate already proved one exists). */
function recorderDisciplineFor(roles: readonly string[], scaleType: ScaleType): string {
  const disciplines = disciplinesOf(roles);
  return disciplines.find((d) => disciplineCanRecordScale(d, scaleType)) ?? disciplines[0] ?? "";
}

// Static permission guards (§4.6).
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("assessment.read");
const AUTHOR = P("assessment.author");
const AMEND = P("assessment.amend");
const COSIGN = P("assessment.cosign");
const READ_TREND = P("assessment.read_trend");
const ACK_CHANGE = P("assessment.acknowledge_change");
const READ_SUMMARY = P("assessment.read_summary");
const LICENSE_READ = P("assessment.license_read");
const LICENSE_ADMIN = P("assessment.license_admin");
const POLICY_READ = P("assessment.policy_read");
const POLICY_ADMIN = P("assessment.policy_admin");

// §4.7 — the D8 discipline matrix ABAC guard M9 owns (target = the body's `scaleType`).
const bodyScaleTarget = (request: { body?: unknown }): AbacTarget => {
  const body = request.body;
  const scaleType =
    body && typeof body === "object" ? (body as { scaleType?: unknown }).scaleType : undefined;
  return typeof scaleType === "string" ? { scaleType } : {};
};
const ABAC_DISCIPLINE = requireAbac("assessment.author", "discipline_can_record_scale", {
  getTarget: bodyScaleTarget,
}) as PreHandler;
// §4.7 — the m9.cosigner_role_match ABAC guard M9 owns (target = request.params → id).
const ABAC_COSIGN = requireAbac("assessment.cosign", "m9.cosigner_role_match") as PreHandler;
// GAP-015 / §4.1 — the shared caseload_or_scope guard (M7-owned), bound by name on routes whose own path
// already carries `patientId` (default getTarget = request.params).
const SCOPE_FOR = (action: string): PreHandler =>
  requireAbac(action, "caseload_or_scope", { notFoundOnDeny: true }) as PreHandler;
// GAP-015 / §4.1 — the M9-owned assessment.scope guard, for the 2 routes keyed by a non-patientId id
// (default getTarget already supplies the right field: `id` on cosignatures, `eventId` on acknowledge).
const ASSESSMENT_SCOPE_FOR = (action: string): PreHandler =>
  requireAbac(action, "assessment.scope", { notFoundOnDeny: true }) as PreHandler;
// §2.3 / §7.7 — the correction route carries the parent row version in If-Match.
const IF_MATCH = requireIfMatch() as PreHandler;

export function registerAssessmentRoutes(app: FastifyInstance, deps: AssessmentRouteDeps): void {
  const { service } = deps;

  // 1 — record a scale (§10 task-#5 pipeline; discipline matrix ABAC; idempotent via Idempotency-Key).
  app.post(
    "/api/v1/patients/:patientId/assessments",
    { preHandler: [AUTHOR, SCOPE_FOR("assessment.author"), ABAC_DISCIPLINE] },
    async (request, reply) => {
      const { organizationId, userId, roles } = actorOf(request);
      const { patientId } = parse(PatientParamsSchema, request.params);
      const body = parse(RecordAssessmentSchema, request.body);
      const res = await service.recordAssessment(organizationId, userId, patientId, {
        admissionId: body.admissionId,
        scaleType: body.scaleType,
        capturedAt: body.capturedAt,
        data: body.data,
        recorderDiscipline: recorderDisciplineFor(roles, body.scaleType),
        sourceEncounterId: body.sourceEncounterId,
        actingAs: body.actingAs,
        actingConsentId: body.actingConsentId,
        sudContext: body.sudContext,
      });
      return reply.code(201).send(res);
    },
  );

  // 2 — correction-of-record (append-only supersede; §2.3 If-Match → 412 STALE_VERSION).
  app.post(
    "/api/v1/patients/:patientId/assessments/:id/corrections",
    { preHandler: [AMEND, SCOPE_FOR("assessment.amend"), ABAC_DISCIPLINE, IF_MATCH] },
    async (request, reply) => {
      const { organizationId, userId, roles } = actorOf(request);
      const { patientId, id } = parse(PatientAssessmentParamsSchema, request.params);
      const body = parse(CorrectAssessmentSchema, request.body);
      const res = await service.correctAssessment(
        organizationId,
        userId,
        patientId,
        id,
        ifMatchVersionOf(request),
        {
          admissionId: body.admissionId,
          scaleType: body.scaleType,
          capturedAt: body.capturedAt,
          data: body.data,
          recorderDiscipline: recorderDisciplineFor(roles, body.scaleType),
          sourceEncounterId: body.sourceEncounterId,
          actingAs: body.actingAs,
          actingConsentId: body.actingConsentId,
          sudContext: body.sudContext,
          correctionReason: body.correctionReason,
        },
      );
      return reply.code(201).send(res);
    },
  );

  // 3 — patient assessment timeline (cursor pagination).
  app.get(
    "/api/v1/patients/:patientId/assessments",
    {
      preHandler: [READ, SCOPE_FOR("assessment.read")],
      config: { auditRead: { resourceKind: "assessment", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientParamsSchema, request.params);
      parse(AssessmentListQuerySchema, request.query);
      return service.listAssessments(organizationId, patientId);
    },
  );

  // 18 — scale-summary surface (static path BEFORE the :id param route so it is not captured by it).
  // §4.1: `caseload_or_scope` ∨ `collaborator_patient_match` ∨ `portal_patient_match` — the latter two are
  // unregistered anywhere in the platform (no module owns them); `caseload_or_scope`'s own session-scope
  // branch already covers the collaborator/portal-session case, subsuming the OR clause (M7 GAP-012 precedent).
  app.get(
    "/api/v1/patients/:patientId/assessments/summary",
    {
      preHandler: [READ_SUMMARY, SCOPE_FOR("assessment.read_summary")],
      config: { auditRead: { resourceKind: "assessment", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientParamsSchema, request.params);
      return service.summary(organizationId, patientId);
    },
  );

  // 4 — read one assessment row.
  app.get(
    "/api/v1/patients/:patientId/assessments/:id",
    {
      preHandler: [READ, SCOPE_FOR("assessment.read")],
      config: { auditRead: { resourceKind: "assessment", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId, id } = parse(PatientAssessmentParamsSchema, request.params);
      return service.getAssessment(organizationId, patientId, id);
    },
  );

  // 5 — latest capture of one scale.
  app.get(
    "/api/v1/patients/:patientId/scales/:scaleType/latest",
    {
      preHandler: [READ, SCOPE_FOR("assessment.read")],
      config: { auditRead: { resourceKind: "assessment_scale", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId, scaleType } = parse(PatientScaleParamsSchema, request.params);
      return service.latestScale(organizationId, patientId, scaleType);
    },
  );

  // 6 — scored series over a [from, to] window.
  app.get(
    "/api/v1/patients/:patientId/scales/:scaleType/series",
    {
      preHandler: [READ_TREND, SCOPE_FOR("assessment.read_trend")],
      config: { auditRead: { resourceKind: "assessment_scale", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId, scaleType } = parse(PatientScaleParamsSchema, request.params);
      const q = parse(SeriesQuerySchema, request.query);
      return service.seriesScale(organizationId, patientId, scaleType, q.from, q.to);
    },
  );

  // 7 — latest-vs-window delta.
  app.get(
    "/api/v1/patients/:patientId/scales/:scaleType/delta",
    {
      preHandler: [READ_TREND, SCOPE_FOR("assessment.read_trend")],
      config: { auditRead: { resourceKind: "assessment_scale", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId, scaleType } = parse(PatientScaleParamsSchema, request.params);
      const q = parse(DeltaQuerySchema, request.query);
      return service.deltaScale(organizationId, patientId, scaleType, q.from, q.to);
    },
  );

  // 8 — LPN cosignature (§7.4; m9.cosigner_role_match ABAC; GAP-015 assessment.scope by assessmentId).
  app.post(
    "/api/v1/assessments/:id/cosignatures",
    { preHandler: [COSIGN, ASSESSMENT_SCOPE_FOR("assessment.cosign"), ABAC_COSIGN] },
    async (request, reply) => {
      const { organizationId, userId, roles } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      const cosignerDiscipline =
        disciplinesOf(roles)[0] ??
        (roles.includes("clinical_supervisor") ? "clinical_supervisor" : "");
      const res = await service.cosign(organizationId, userId, id, cosignerDiscipline);
      return reply.code(201).send(res);
    },
  );

  // 9 — significant-change worklist for a patient (cursor pagination).
  app.get(
    "/api/v1/patients/:patientId/significant-changes",
    {
      preHandler: [READ, SCOPE_FOR("assessment.read")],
      config: { auditRead: { resourceKind: "assessment", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientParamsSchema, request.params);
      return service.listSignificantChanges(organizationId, patientId);
    },
  );

  // 10 — acknowledge a significant-change event (open|escalated → acknowledged; GAP-015 assessment.scope
  // resolves the event's triggering assessment to its patient by eventId).
  app.post(
    "/api/v1/significant-changes/:eventId/acknowledge",
    { preHandler: [ACK_CHANGE, ASSESSMENT_SCOPE_FOR("assessment.acknowledge_change")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { eventId } = parse(ChangeEventParamsSchema, request.params);
      parse(AcknowledgeChangeSchema, request.body);
      return service.acknowledgeChange(organizationId, eventId);
    },
  );

  // 11 — internal: LatestAssessmentProvider batch (system principal; M7/M10).
  app.get(
    "/api/v1/internal/assessments/latest-batch",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "assessment", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(LatestBatchQuerySchema, request.query);
      return service.latestBatch(organizationId, q.patientId, q.scaleTypes);
    },
  );

  // 12 — internal: ScaleSeriesProvider batch (system principal; M32 AI symptom-trajectory).
  app.get(
    "/api/v1/internal/assessments/series-batch",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "assessment", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(SeriesBatchQuerySchema, request.query);
      return service.seriesScale(organizationId, q.patientId, q.scaleType, q.from, q.to);
    },
  );

  // 13 — admin: scale-license registry (org_admin / compliance).
  app.get(
    "/api/v1/admin/scales/licenses",
    {
      preHandler: [LICENSE_READ],
      config: {
        auditRead: { none: "organization-level scale licensing configuration; no patient data" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.listLicenses(organizationId);
    },
  );

  // 14 — admin: register a scale license (idempotent via Idempotency-Key, M09-F06).
  app.post(
    "/api/v1/admin/scales/licenses",
    { preHandler: [LICENSE_ADMIN] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const body = parse(CreateLicenseSchema, request.body);
      const res = await service.createLicense(organizationId, body);
      return reply.code(201).send(res);
    },
  );

  // 15 — admin: update a scale license (partial; idempotent via Idempotency-Key, M09-F06).
  app.patch(
    "/api/v1/admin/scales/licenses/:id",
    { preHandler: [LICENSE_ADMIN] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(LicenseParamsSchema, request.params);
      const body = parse(UpdateLicenseSchema, request.body);
      return service.updateLicense(organizationId, id, body);
    },
  );

  // 16 — admin: scale-policy registry (the enabled/disabled scales for the tenant).
  app.get(
    "/api/v1/admin/scales/policies",
    {
      preHandler: [POLICY_READ],
      config: {
        auditRead: { none: "organization-level scale policy configuration; no patient data" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.listPolicies(organizationId);
    },
  );

  // 17 — admin: enable/disable a scale (idempotent via Idempotency-Key, M09-F06).
  app.patch(
    "/api/v1/admin/scales/policies/:scaleType",
    { preHandler: [POLICY_ADMIN] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { scaleType } = parse(ScalePolicyParamsSchema, request.params);
      const body = parse(UpdateScalePolicySchema, request.body);
      return service.updatePolicy(organizationId, scaleType, body.enabled);
    },
  );
}
