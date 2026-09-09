// apps/backend/src/modules/10-hope/routes/hope-routes.ts — M10-T06 the §4.1 route inventory (22 routes)
// behind the REAL Authorization Contract (`requirePermission`/`requireAbac` from @wardenx/auth, M3) on the
// §4.6 keys M10 registers into M3's catalog (M10_CONTRIBUTED_PERMISSIONS). Org binding is server-side
// (`request.context`, never the body). Handlers compose over the injected HopeRouteService (in-memory
// slice; Drizzle in prod under `withOrgContext` so RLS backstops).
//
// §4.7 wiring: the timepoint write/sign routes add `requireAbac('hope.authorDisciplineAllowed')` (RN/NP/MD
// only — the D4 author rule M10 owns); the SFV route adds `requireAbac('hope.sfvAuthorAllowed')` (RN/NP
// only); the correction route adds `requireAbac('hope.correctionAuthorAllowed')` (original signer or
// clinical-lead, target = `:id`).
//
// GAP-018 (2026-08-09): the §4.1 `caseload` / `provider_entity` columns used to be claimed here as "bound
// by the §4.6 default ABAC on each key, enforced by M3's authorization middleware" — no such middleware
// exists (`requirePermission` never reads a permission's `defaultAbac` catalog column), so this file wired
// ZERO caseload/provider-entity guards. The 14 caseload-scoped + 5 provider-entity-scoped routes now bind
// the new M10-owned `hope.scope` predicate (abac-predicates.ts) via `SCOPE`/`SCOPE_*` below — one predicate
// covering every id shape M10's routes name (patientId/admissionId/scheduleId/sfvId/assessmentId/
// providerEntityId/submissionId), since none of those shapes (besides bare `patientId`/`providerEntityId`)
// resolve through the shared `caseload_or_scope` (M7-owned) or `provider_entity_scope` (M3-intrinsic)
// predicates by name. `GET /hope/sfv` (pure org-wide worklist, no id/filter to scope by) and `POST
// /hope/admin/regenerate-schedules` (§4.1 ABAC = `platform_admin`, a role check, not caseload/PE — out of
// this GAP's scope) are deliberately left unwired, per the M6/M7/M8/M9 list-route precedent.
import { type AbacTarget, requireAbac, requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AdmissionParamsSchema,
  AssembleSubmissionSchema,
  AssessmentParamsSchema,
  CorrectTimepointSchema,
  DashboardQuerySchema,
  HopeAnswerPatchResponseSchema,
  HopeAssessmentReviewResponseSchema,
  HopeAssessmentWorkspaceResponseSchema,
  HopeSignResponseSchema,
  HopeWorkflowStateResponseSchema,
  ImportSubmissionResultSchema,
  InactivateTimepointSchema,
  MarkSubmissionUploadedSchema,
  PatchAnswersSchema,
  PatientParamsSchema,
  RecordSfvSchema,
  RecordTimepointSchema,
  RegenerateSchedulesSchema,
  RetrySubmissionSchema,
  ScheduleListQuerySchema,
  ScheduleParamsSchema,
  SetHuvCompletionDateSchema,
  SfvParamsSchema,
  SfvWorklistQuerySchema,
  SignTimepointSchema,
  SkipScheduleSchema,
  SubmissionListQuerySchema,
  SubmissionParamsSchema,
  SummaryPdfSchema,
  UpdateDraftSchema,
  ValidationQuerySchema,
  parse,
} from "./hope-typebox";
import type { HopeRouteService } from "./service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface HopeRouteDeps {
  service: HopeRouteService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  // `userId` here is the codebase-wide convention of "the acting MEMBERSHIP id" (every
  // `created_by_membership_id`/`signed_by_membership_id` column this module's service layer writes
  // it into is a membership FK). This used to read `ctx.userId` (the raw Better Auth user id, a
  // DIFFERENT id from the org membership) — every `POST /admissions/:id/hope/*` FK-violated on
  // `created_by_membership_id` as a result. Same bug, same fix, as M8's `encounters-routes.ts`.
  const membershipId = ctx?.attributes.membershipId;
  if (!ctx?.organizationId || typeof membershipId !== "string") throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: membershipId };
}

// Static permission guards (§4.6).
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ_SCHEDULE = P("hope.schedule.read");
const SKIP = P("hope.schedule.skip");
const READ_TIMEPOINT = P("hope.timepoint.read");
const WRITE = P("hope.timepoint.write");
const SIGN = P("hope.timepoint.sign");
const CORRECT = P("hope.timepoint.correct");
const READ_SFV = P("hope.sfv.read");
const READ_SUBMISSION = P("hope.submission.read");
const SUBMISSION_MANAGE = P("hope.submission.manage");
const DASHBOARD_READ = P("hope.dashboard.read");
const ADMIN_REGEN = P("hope.admin.regenerate_schedules");

// §4.7 — the three ABAC predicates M10 owns (discipline is read from session context, not the body).
const noTarget = (): AbacTarget => ({});
const ABAC_AUTHOR = requireAbac("hope.timepoint.write", "hope.authorDisciplineAllowed", {
  getTarget: noTarget,
}) as PreHandler;
const ABAC_SIGN = requireAbac("hope.timepoint.sign", "hope.authorDisciplineAllowed", {
  getTarget: noTarget,
}) as PreHandler;
const ABAC_SFV = requireAbac("hope.timepoint.write", "hope.sfvAuthorAllowed", {
  getTarget: noTarget,
}) as PreHandler;
const ABAC_CORRECT = requireAbac(
  "hope.timepoint.correct",
  "hope.correctionAuthorAllowed",
) as PreHandler; // target = :id

// GAP-018 — the M10-owned `hope.scope` guard. `SCOPE` covers every route whose default target
// (`request.params`) already names a field `hope.scope` recognizes as-is: `patientId` (route 10),
// `admissionId` (routes 4/5), or a bare `:id` (routes 6/7/8/9/11/14 — the assessmentId default branch).
// The `SCOPE_*` variants rename `:id`/a query/body field to the entity-specific name the predicate
// expects, since M10's schedule/SFV/submission routes all reuse the literal param name `:id` for THREE
// different entity types — collapsing them onto the assessment-default branch would silently resolve the
// wrong resource (a schedule id looked up as an assessment id, e.g.) rather than the right one.
const SCOPE = (action: string): PreHandler =>
  requireAbac(action, "hope.scope", { notFoundOnDeny: true }) as PreHandler;
const SCOPE_SCHEDULE = (action: string): PreHandler =>
  requireAbac(action, "hope.scope", {
    notFoundOnDeny: true,
    getTarget: (request) => ({
      scheduleId: (request.params as { id?: unknown } | null)?.id,
    }),
  }) as PreHandler;
const SCOPE_SFV = (action: string): PreHandler =>
  requireAbac(action, "hope.scope", {
    notFoundOnDeny: true,
    getTarget: (request) => ({
      sfvId: (request.params as { id?: unknown } | null)?.id,
    }),
  }) as PreHandler;
const SCOPE_SUBMISSION = (action: string): PreHandler =>
  requireAbac(action, "hope.scope", {
    notFoundOnDeny: true,
    getTarget: (request) => ({
      submissionId: (request.params as { id?: unknown } | null)?.id,
    }),
  }) as PreHandler;
const SCOPE_QUERY_PATIENT = (action: string): PreHandler =>
  requireAbac(action, "hope.scope", {
    notFoundOnDeny: true,
    getTarget: (request) => ({
      patientId: (request.query as { patientId?: unknown } | null)?.patientId,
    }),
  }) as PreHandler;
const SCOPE_QUERY_PE = (action: string): PreHandler =>
  requireAbac(action, "hope.scope", {
    notFoundOnDeny: true,
    getTarget: (request) => ({
      providerEntityId: (request.query as { providerEntityId?: unknown } | null)?.providerEntityId,
    }),
  }) as PreHandler;
const SCOPE_BODY_PE = (action: string): PreHandler =>
  requireAbac(action, "hope.scope", {
    notFoundOnDeny: true,
    getTarget: (request) => ({
      providerEntityId: (request.body as { providerEntityId?: unknown } | null)?.providerEntityId,
    }),
  }) as PreHandler;

export function registerHopeRoutes(app: FastifyInstance, deps: HopeRouteDeps): void {
  const { service } = deps;

  // 0 — admission-scoped operational HOPE workflow summary. This Phase-2 read model lets the web
  // overview render fixed RFA schedules and dynamic SFVs from one PHI-minimal M10 response.
  app.get(
    "/api/v1/admissions/:admissionId/hope",
    {
      preHandler: [READ_TIMEPOINT, SCOPE("hope.timepoint.read")],
      config: { auditRead: { resourceKind: "hope_workflow", resourceIdParam: "admissionId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { admissionId } = parse(AdmissionParamsSchema, request.params);
      const result = await service.getWorkflowState(organizationId, admissionId);
      return parse(HopeWorkflowStateResponseSchema, result);
    },
  );

  // 1 — list schedules (org or filtered patient; status / RFA / window-state).
  app.get(
    "/api/v1/hope/schedules",
    {
      preHandler: [READ_SCHEDULE, SCOPE_QUERY_PATIENT("hope.schedule.read")],
      config: { auditRead: { resourceKind: "hope_schedule", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(ScheduleListQuerySchema, request.query);
      return service.listSchedules(organizationId, {
        patientId: q.patientId,
        status: q.status,
        rfaKind: q.rfaKind,
      });
    },
  );

  // 2 — schedule detail with derived state.
  app.get(
    "/api/v1/hope/schedules/:id",
    {
      preHandler: [READ_SCHEDULE, SCOPE_SCHEDULE("hope.schedule.read")],
      config: { auditRead: { resourceKind: "hope_schedule", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(ScheduleParamsSchema, request.params);
      return service.getSchedule(organizationId, id);
    },
  );

  // 3 — skip a schedule (requires reason code).
  app.post(
    "/api/v1/hope/schedules/:id/skip",
    { preHandler: [SKIP, SCOPE_SCHEDULE("hope.schedule.skip")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(ScheduleParamsSchema, request.params);
      const body = parse(SkipScheduleSchema, request.body);
      return service.skipSchedule(organizationId, id, body.reasonCode);
    },
  );

  // 4 — record a new HOPE timepoint (draft); RN/NP/MD-only author (§4.7); idempotent via Idempotency-Key.
  app.post(
    "/api/v1/admissions/:admissionId/hope/timepoints",
    { preHandler: [WRITE, SCOPE("hope.timepoint.write"), ABAC_AUTHOR] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { admissionId } = parse(AdmissionParamsSchema, request.params);
      const body = parse(RecordTimepointSchema, request.body);
      const res = await service.recordTimepoint(organizationId, userId, admissionId, {
        rfaKind: body.rfaKind,
        targetDate: body.targetDate,
        authorDiscipline: body.authorDiscipline,
        data: body.data,
        sourceEncounterId: body.sourceEncounterId,
        dischargeReason: body.dischargeReason,
        lateCompletionReasonCode: body.lateCompletionReasonCode,
        adminOverride: body.adminOverride,
      });
      return reply.code(201).send(res);
    },
  );

  // 5 — record an SFV completion (RFA 04); RN/NP-only author (§4.7); matches an open SFV row.
  app.post(
    "/api/v1/admissions/:admissionId/hope/sfv",
    { preHandler: [WRITE, SCOPE("hope.timepoint.write"), ABAC_SFV] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { admissionId } = parse(AdmissionParamsSchema, request.params);
      const body = parse(RecordSfvSchema, request.body);
      const res = await service.recordSfv(organizationId, userId, admissionId, {
        triggeringAssessmentId: body.triggeringAssessmentId,
        targetDate: body.targetDate,
        authorDiscipline: body.authorDiscipline,
        data: body.data,
        adminOverride: body.adminOverride,
      });
      return reply.code(201).send(res);
    },
  );

  // 6 — update a draft assessment.
  app.put(
    "/api/v1/hope/assessments/:id",
    { preHandler: [WRITE, SCOPE("hope.timepoint.write")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      const body = parse(UpdateDraftSchema, request.body);
      return service.updateDraft(organizationId, id, body.data);
    },
  );

  // 7 — sign a draft (→ signed; runs the D4 J2051 trigger; snapshots PPS/ESAS-r); RN/NP/MD-only.
  app.post(
    "/api/v1/hope/assessments/:id/sign",
    { preHandler: [SIGN, SCOPE("hope.timepoint.sign"), ABAC_SIGN] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      const body = parse(SignTimepointSchema, request.body);
      return parse(
        HopeSignResponseSchema,
        await service.signTimepoint(organizationId, userId, id, body),
      );
    },
  );

  // 8 — insert a correction draft; original-signer or clinical-lead (§4.7).
  app.post(
    "/api/v1/hope/assessments/:id/correct",
    { preHandler: [CORRECT, SCOPE("hope.timepoint.correct"), ABAC_CORRECT] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      const body = parse(CorrectTimepointSchema, request.body);
      const res = await service.correctTimepoint(organizationId, userId, id, {
        correctionReason: body.correctionReason,
        ifVersion: body.ifVersion,
        targetDate: body.targetDate,
        authorDiscipline: body.authorDiscipline,
        data: body.data,
      });
      return reply.code(201).send(res);
    },
  );

  app.post(
    "/api/v1/hope/assessments/:id/inactivations",
    { preHandler: [CORRECT, SCOPE("hope.timepoint.correct"), ABAC_CORRECT] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      const body = parse(InactivateTimepointSchema, request.body);
      const res = await service.inactivateTimepoint(organizationId, userId, id, body);
      return reply.code(201).send(res);
    },
  );

  // 9 — read a single assessment (sections, snapshot, validation findings).
  app.get(
    "/api/v1/hope/assessments/:id",
    {
      preHandler: [READ_TIMEPOINT, SCOPE("hope.timepoint.read")],
      config: { auditRead: { resourceKind: "hope_assessment", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      return service.getAssessment(organizationId, id);
    },
  );

  // 9B — canonical answer workspace: active assessment items + current item-level states.
  app.get(
    "/api/v1/hope/assessments/:id/workspace",
    {
      preHandler: [READ_TIMEPOINT, SCOPE("hope.timepoint.read")],
      config: { auditRead: { resourceKind: "hope_assessment_workspace", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      return parse(
        HopeAssessmentWorkspaceResponseSchema,
        await service.getAssessmentWorkspace(organizationId, id),
      );
    },
  );

  // 9C — final-review/readiness model. Read-only; opening review never mutates answers/signature state.
  app.get(
    "/api/v1/hope/assessments/:id/review",
    {
      preHandler: [READ_TIMEPOINT, SCOPE("hope.timepoint.read")],
      config: { auditRead: { resourceKind: "hope_assessment_review", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      return parse(
        HopeAssessmentReviewResponseSchema,
        await service.getAssessmentReview(organizationId, id),
      );
    },
  );

  // 9D — canonical answer patch. Public API supports only set/clear; skipped remains internal.
  app.patch(
    "/api/v1/hope/assessments/:id/answers",
    { preHandler: [WRITE, SCOPE("hope.timepoint.write")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      const body = parse(PatchAnswersSchema, request.body);
      return parse(
        HopeAnswerPatchResponseSchema,
        await service.patchAssessmentAnswers(organizationId, userId, id, body),
      );
    },
  );

  // 9E — HUV workflow-controlled Z0350 capture. This writes the canonical answer row, but keeps
  // Z0350 out of the unrestricted public answer PATCH surface.
  app.patch(
    "/api/v1/hope/assessments/:id/huv/completion-date",
    { preHandler: [WRITE, SCOPE("hope.timepoint.write")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      const body = parse(SetHuvCompletionDateSchema, request.body);
      return parse(
        HopeAnswerPatchResponseSchema,
        await service.setHuvCompletionDate(organizationId, userId, id, body),
      );
    },
  );

  // 10 — patient HOPE timeline.
  app.get(
    "/api/v1/patients/:patientId/hope/assessments",
    {
      preHandler: [READ_TIMEPOINT, SCOPE("hope.timepoint.read")],
      config: { auditRead: { resourceKind: "hope_assessment", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientParamsSchema, request.params);
      return service.listPatientAssessments(organizationId, patientId);
    },
  );

  // 11 — request the printable HOPE summary (emits `m10.hope.summary_requested`; M22 renders).
  app.post(
    "/api/v1/hope/assessments/:id/summary-pdf",
    { preHandler: [READ_TIMEPOINT, SCOPE("hope.timepoint.read")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      parse(SummaryPdfSchema, request.body);
      const res = await service.requestSummaryPdf(organizationId, userId, id);
      return reply.code(202).send(res);
    },
  );

  // 12 — open / overdue / missed SFV worklist. §4.1 ABAC = "caseload", but this route names no patient
  // filter at all (state-only query) — a pure org-wide worklist, deliberately left unwired to `hope.scope`
  // (M6/M7/M8/M9 precedent: a route with nothing to scope by gets RBAC + RLS only, not a guard that would
  // always fall through to its permissive empty-target branch).
  app.get(
    "/api/v1/hope/sfv",
    {
      preHandler: [READ_SFV],
      config: { auditRead: { resourceKind: "hope_sfv", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(SfvWorklistQuerySchema, request.query);
      return service.listSfv(organizationId, q.state);
    },
  );

  // 13 — SFV detail.
  app.get(
    "/api/v1/hope/sfv/:id",
    {
      preHandler: [READ_SFV, SCOPE_SFV("hope.sfv.read")],
      config: { auditRead: { resourceKind: "hope_sfv", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(SfvParamsSchema, request.params);
      return service.getSfv(organizationId, id);
    },
  );

  // 14 — on-demand pre-submission validation findings for one row.
  app.get(
    "/api/v1/hope/assessments/:id/validation",
    {
      preHandler: [READ_TIMEPOINT, SCOPE("hope.timepoint.read")],
      config: {
        auditRead: { resourceKind: "hope_assessment_validation", resourceIdParam: "id" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      const query = parse(ValidationQuerySchema, request.query);
      return service.getValidation(organizationId, id, {
        mode: query.mode,
        submissionDate: query.submissionDate,
      });
    },
  );

  // 15 — submission batch list per ProviderEntity.
  app.get(
    "/api/v1/hope/submissions",
    {
      preHandler: [READ_SUBMISSION, SCOPE_QUERY_PE("hope.submission.read")],
      config: { auditRead: { resourceKind: "hope_submission", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(SubmissionListQuerySchema, request.query);
      return service.listSubmissions(organizationId, q.providerEntityId);
    },
  );

  // 16 — submission detail with per-item outcomes.
  app.get(
    "/api/v1/hope/submissions/:id",
    {
      preHandler: [READ_SUBMISSION, SCOPE_SUBMISSION("hope.submission.read")],
      config: { auditRead: { resourceKind: "hope_submission", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(SubmissionParamsSchema, request.params);
      return service.getSubmission(organizationId, id);
    },
  );

  // 17 — retry a rejected submission (re-validates, re-assembles).
  app.post(
    "/api/v1/hope/submissions/:id/retry",
    { preHandler: [SUBMISSION_MANAGE, SCOPE_SUBMISSION("hope.submission.manage")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(SubmissionParamsSchema, request.params);
      parse(RetrySubmissionSchema, request.body);
      return service.retrySubmission(organizationId, id);
    },
  );

  // 18 — force-assemble a submission outside the cron cadence.
  app.post(
    "/api/v1/hope/submissions/assemble",
    { preHandler: [SUBMISSION_MANAGE, SCOPE_BODY_PE("hope.submission.manage")] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const body = parse(AssembleSubmissionSchema, request.body);
      const res = await service.assembleSubmission(organizationId, body.providerEntityId);
      return reply.code(201).send(res);
    },
  );

  app.get(
    "/api/v1/hope/submissions/:id/package",
    {
      preHandler: [SUBMISSION_MANAGE, SCOPE_SUBMISSION("hope.submission.manage")],
      config: { auditRead: { resourceKind: "hope_submission", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(SubmissionParamsSchema, request.params);
      const pkg = await service.downloadSubmissionPackage(organizationId, id);
      return reply
        .header("content-type", pkg.contentType)
        .header("content-disposition", `attachment; filename="${pkg.filename}"`)
        .send(pkg.bytes);
    },
  );

  app.post(
    "/api/v1/hope/submissions/:id/mark-uploaded",
    { preHandler: [SUBMISSION_MANAGE, SCOPE_SUBMISSION("hope.submission.manage")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(SubmissionParamsSchema, request.params);
      const body = parse(MarkSubmissionUploadedSchema, request.body);
      return service.markSubmissionUploaded(organizationId, userId, id, body);
    },
  );

  app.post(
    "/api/v1/hope/submissions/:id/results",
    { preHandler: [SUBMISSION_MANAGE, SCOPE_SUBMISSION("hope.submission.manage")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(SubmissionParamsSchema, request.params);
      const body = parse(ImportSubmissionResultSchema, request.body);
      return service.importSubmissionResult(organizationId, userId, id, body);
    },
  );

  // 19 — org-level HQRP compliance posture.
  app.get(
    "/api/v1/hope/dashboard/compliance",
    {
      preHandler: [DASHBOARD_READ, SCOPE_QUERY_PE("hope.dashboard.read")],
      config: {
        auditRead: {
          none: "Aggregate provider-entity compliance rates only (hopeOnTimeRate/sfvOnTimeRate/submissionAcceptanceRate); no patient identifiers or patient-level data returned.",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(DashboardQuerySchema, request.query);
      return service.complianceDashboard(organizationId, q.providerEntityId);
    },
  );

  // 20 — admin: recompute schedules for an admission (post-hoc date correction).
  app.post(
    "/api/v1/hope/admin/regenerate-schedules",
    { preHandler: [ADMIN_REGEN] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(RegenerateSchedulesSchema, request.body);
      return service.regenerateSchedules(organizationId, body.admissionId);
    },
  );
}
