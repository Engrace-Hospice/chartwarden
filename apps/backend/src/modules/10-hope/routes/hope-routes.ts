// apps/backend/src/modules/10-hope/routes/hope-routes.ts — M10-T06 the §4.1 route inventory (20 routes)
// behind the REAL Authorization Contract (`requirePermission`/`requireAbac` from @wardenx/auth, M3) on the
// §4.6 keys M10 registers into M3's catalog (M10_CONTRIBUTED_PERMISSIONS). Org binding is server-side
// (`request.context`, never the body). Handlers compose over the injected HopeRouteService (in-memory
// slice; Drizzle in prod under `withOrgContext` so RLS backstops).
//
// §4.7 wiring: the timepoint write/sign routes add `requireAbac('hope.authorDisciplineAllowed')` (RN/NP/MD
// only — the D4 author rule M10 owns); the SFV route adds `requireAbac('hope.sfvAuthorAllowed')` (RN/NP
// only); the correction route adds `requireAbac('hope.correctionAuthorAllowed')` (original signer or
// clinical-lead, target = `:id`). The §4.1 `caseload` / `provider_entity` columns map to the shared
// `caseload_or_scope` / `provider_entity_scope` predicates (registered by M5/M7 / M3-intrinsic) — bound by
// the §4.6 default ABAC on each key, enforced by M3's authorization middleware.
import { type AbacTarget, requireAbac, requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AdmissionParamsSchema,
  AssembleSubmissionSchema,
  AssessmentParamsSchema,
  CorrectTimepointSchema,
  DashboardQuerySchema,
  PatientParamsSchema,
  RecordSfvSchema,
  RecordTimepointSchema,
  RegenerateSchedulesSchema,
  RetrySubmissionSchema,
  ScheduleListQuerySchema,
  ScheduleParamsSchema,
  SfvParamsSchema,
  SfvWorklistQuerySchema,
  SignTimepointSchema,
  SkipScheduleSchema,
  SubmissionListQuerySchema,
  SubmissionParamsSchema,
  SummaryPdfSchema,
  UpdateDraftSchema,
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
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
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

export function registerHopeRoutes(app: FastifyInstance, deps: HopeRouteDeps): void {
  const { service } = deps;

  // 1 — list schedules (org or filtered patient; status / RFA / window-state).
  app.get(
    "/api/v1/hope/schedules",
    {
      preHandler: [READ_SCHEDULE],
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
      preHandler: [READ_SCHEDULE],
      config: { auditRead: { resourceKind: "hope_schedule", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(ScheduleParamsSchema, request.params);
      return service.getSchedule(organizationId, id);
    },
  );

  // 3 — skip a schedule (requires reason code).
  app.post("/api/v1/hope/schedules/:id/skip", { preHandler: [SKIP] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(ScheduleParamsSchema, request.params);
    const body = parse(SkipScheduleSchema, request.body);
    return service.skipSchedule(organizationId, id, body.reasonCode);
  });

  // 4 — record a new HOPE timepoint (draft); RN/NP/MD-only author (§4.7); idempotent via Idempotency-Key.
  app.post(
    "/api/v1/admissions/:admissionId/hope/timepoints",
    { preHandler: [WRITE, ABAC_AUTHOR] },
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
      });
      return reply.code(201).send(res);
    },
  );

  // 5 — record an SFV completion (RFA 04); RN/NP-only author (§4.7); matches an open SFV row.
  app.post(
    "/api/v1/admissions/:admissionId/hope/sfv",
    { preHandler: [WRITE, ABAC_SFV] },
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
  app.put("/api/v1/hope/assessments/:id", { preHandler: [WRITE] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(AssessmentParamsSchema, request.params);
    const body = parse(UpdateDraftSchema, request.body);
    return service.updateDraft(organizationId, id, body.data);
  });

  // 7 — sign a draft (→ signed; runs the D4 J2051 trigger; snapshots PPS/ESAS-r); RN/NP/MD-only.
  app.post(
    "/api/v1/hope/assessments/:id/sign",
    { preHandler: [SIGN, ABAC_SIGN] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      parse(SignTimepointSchema, request.body);
      return service.signTimepoint(organizationId, userId, id);
    },
  );

  // 8 — insert a correction RFA (original superseded); original-signer or clinical-lead (§4.7).
  app.post(
    "/api/v1/hope/assessments/:id/correct",
    { preHandler: [CORRECT, ABAC_CORRECT] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      const body = parse(CorrectTimepointSchema, request.body);
      const res = await service.correctTimepoint(organizationId, userId, id, {
        correctionReason: body.correctionReason,
        targetDate: body.targetDate,
        authorDiscipline: body.authorDiscipline,
        data: body.data,
      });
      return reply.code(201).send(res);
    },
  );

  // 9 — read a single assessment (sections, snapshot, validation findings).
  app.get(
    "/api/v1/hope/assessments/:id",
    {
      preHandler: [READ_TIMEPOINT],
      config: { auditRead: { resourceKind: "hope_assessment", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      return service.getAssessment(organizationId, id);
    },
  );

  // 10 — patient HOPE timeline.
  app.get(
    "/api/v1/patients/:patientId/hope/assessments",
    {
      preHandler: [READ_TIMEPOINT],
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
    { preHandler: [READ_TIMEPOINT] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      parse(SummaryPdfSchema, request.body);
      const res = await service.requestSummaryPdf(organizationId, userId, id);
      return reply.code(202).send(res);
    },
  );

  // 12 — open / overdue / missed SFV worklist.
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
      preHandler: [READ_SFV],
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
      preHandler: [READ_TIMEPOINT],
      config: {
        auditRead: { resourceKind: "hope_assessment_validation", resourceIdParam: "id" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      return service.getValidation(organizationId, id);
    },
  );

  // 15 — submission batch list per ProviderEntity.
  app.get(
    "/api/v1/hope/submissions",
    {
      preHandler: [READ_SUBMISSION],
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
      preHandler: [READ_SUBMISSION],
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
    { preHandler: [SUBMISSION_MANAGE] },
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
    { preHandler: [SUBMISSION_MANAGE] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const body = parse(AssembleSubmissionSchema, request.body);
      const res = await service.assembleSubmission(organizationId, body.providerEntityId);
      return reply.code(201).send(res);
    },
  );

  // 19 — org-level HQRP compliance posture.
  app.get(
    "/api/v1/hope/dashboard/compliance",
    {
      preHandler: [DASHBOARD_READ],
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
