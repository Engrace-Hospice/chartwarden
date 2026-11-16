import {
  type AbacTarget,
  requireAbac,
  requirePermission,
  requireStepUp,
  resolveActorPermissions,
} from "@chartwarden/auth";
import { assertAuthorBoundToActor } from "@chartwarden/hope";
// apps/backend/src/modules/10-hope/routes/hope-routes.ts — M10-T06 the §4.1 route inventory
// behind the REAL Authorization Contract (`requirePermission`/`requireAbac` from @chartwarden/auth, M3) on the
// §4.6 keys M10 registers into M3's catalog (M10_CONTRIBUTED_PERMISSIONS). Org binding is server-side
// (`request.context`, never the body). Handlers compose over the injected HopeRouteService (in-memory
// slice; Drizzle in prod under `withOrgContext` so RLS backstops).
//
// §4.7 wiring: the timepoint write/sign routes add `requireAbac('hope.authorDisciplineAllowed')` (RN/NP/MD
// only — the D4 author rule M10 owns); the SFV route adds `requireAbac('hope.sfvAuthorAllowed')` (RN/NP/LPN/LVN
// only); the correction route adds `requireAbac('hope.correctionAuthorAllowed')` (original signer or
// clinical-lead, target = `:id`).
//
// GAP-018 (2026-08-09): the §4.1 `caseload` / `provider_entity` columns used to be claimed here as "bound
// by the §4.6 default ABAC on each key, enforced by M3's authorization middleware" — no such middleware
// exists (`requirePermission` never reads a permission's `defaultAbac` catalog column), so this file wired
// ZERO caseload/provider-entity guards. The caseload-scoped and provider-entity-scoped routes now bind
// the new M10-owned `hope.scope` predicate (abac-predicates.ts) via `SCOPE`/`SCOPE_*` below — one predicate
// covering every id shape M10's routes name (patientId/admissionId/scheduleId/sfvId/assessmentId/
// providerEntityId/submissionId), since none of those shapes (besides bare `patientId`/`providerEntityId`)
// resolve through the shared `caseload_or_scope` (M7-owned) or `provider_entity_scope` (M3-intrinsic)
// predicates by name. `GET /hope/sfv` (an org-wide worklist: its one id-shaped input, the optional `triggeringAssessmentId`,
// is a result FILTER the caller does not address a resource by, and an unknown id is an empty list, never a 404, so there is
// nothing for `hope.scope` to guard) is deliberately left unwired, per the M6/M7/M8/M9 list-route precedent (the caseload is
// applied as a query narrowing instead, GAP-182). `POST /hope/admin/regenerate-schedules` (§4.1 ABAC = `platform_admin`, a role
// check) was left out of GAP-018 but now binds `hope.scope` on the body's admissionId (`SCOPE_BODY_ADMISSION`, GAP-124).
import { type PreHandler, membershipActorOf, rejectAiActor } from "@chartwarden/shared/route-kit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getSeam } from "../../../bootstrap/index";
import { HOPE_SFV_STEP_UP_OPERATION, HOPE_SIGN_STEP_UP_OPERATION } from "../hope-signature-audit";
import {
  assertReferenceHasNoPatientIdentifier,
  assertResultRowsHaveNoPatientIdentifier,
} from "./hope-reference-screen";
import {
  type CaseloadLookup,
  REGENERATE_SCHEDULES_GUARDS,
  REJECT_AI_OPERATIONS,
  SCOPE_SUBMISSION,
  SUBMISSION_ASSEMBLE_GUARDS,
  SUBMISSION_OPERATION_GUARDS,
  adminOverrideRequested,
  assertAmendmentAttribution,
  listScopeOf,
  requireOverrideJustification,
  requireStrictAttestation,
  signatureRequestFacts,
} from "./hope-route-guards";
import {
  AdmissionParamsSchema,
  AssembleSubmissionSchema,
  AssessmentParamsSchema,
  CancelSubmissionSchema,
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

export interface HopeRouteDeps {
  service: HopeRouteService;
  /**
   * The patients on a clinician's caseload (GAP-182) — defaults to M5's published `CaseloadProvider` seam.
   * `userId` is the M2 USER id (what `patient_assignment.clinician_user_id` keys on).
   */
  caseloadPatientIds?: CaseloadLookup;
  /**
   * A per-actor limiter for the SFV completion route (`createRouteRateLimit`, bound at the composition root). It bounds how
   * many `hope.sfv_completion_denied` audit rows one caller can add by probing other admissions' SFVs; it runs after the
   * permission, scope and discipline guards and before the step-up, so a caller those refuse never spends the budget.
   */
  sfvCompletionRateLimit?: PreHandler;
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
const DASHBOARD_READ = P("hope.dashboard.read");
const ADMIN_LATE_OVERRIDE = P("hope.admin.late_deadline_override");

/**
 * Whether the caller holds `hope.timepoint.write`, from the SAME resolver `requirePermission` gates on. The workspace and
 * review reads pass it down so that only a writer's open refreshes chart-derived answers (a write); a read-only caller
 * is shown the stored state.
 */
async function callerMayWrite(request: FastifyRequest): Promise<boolean> {
  const granted = await resolveActorPermissions(request.context);
  return granted.has("hope.timepoint.write");
}

const LATE_OVERRIDE_GATE: PreHandler = async (request, reply) => {
  if (!adminOverrideRequested(request.body)) return;
  await ADMIN_LATE_OVERRIDE(request, reply);
};
// §4.7 — the three ABAC predicates M10 owns (discipline is read from session context, not the body).
const noTarget = (): AbacTarget => ({});
const ABAC_AUTHOR = requireAbac("hope.timepoint.write", "hope.authorDisciplineAllowed", {
  getTarget: noTarget,
}) as PreHandler;
// Draft edit / answer patch / sign address an existing row (`:id`), so the predicate can see its RFA kind
// and apply the SFV author rule to an SFV correction draft (#850). Default target = request params.
const ABAC_AUTHOR_ON_ROW = requireAbac(
  "hope.timepoint.write",
  "hope.authorDisciplineAllowed",
) as PreHandler;
const ABAC_SIGN = requireAbac("hope.timepoint.sign", "hope.authorDisciplineAllowed") as PreHandler;
const ABAC_SFV = requireAbac("hope.timepoint.write", "hope.sfvAuthorAllowed", {
  getTarget: noTarget,
}) as PreHandler;
const ABAC_CORRECT = requireAbac(
  "hope.timepoint.correct",
  "hope.correctionAuthorAllowed",
) as PreHandler; // target = :id

// R-05 — a HOPE record signature is a legal clinical act, so it takes the M8/M9 signing ceremony: an AI
// principal is refused (§D13), and a FRESH step-up is demanded. `STEP_UP_*` must be the LAST preHandler on
// its route: a caller already denied by permission/scope/discipline is never asked to re-authenticate, and
// `requireStepUp` is not satisfiable by an active break-glass grant. The attestation itself is the required
// `attestationConfirmed: true` in the request schema.
const REJECT_AI = rejectAiActor("AI principals cannot sign a HOPE record") as PreHandler;
const STEP_UP_SIGN = requireStepUp(HOPE_SIGN_STEP_UP_OPERATION) as PreHandler;
const STEP_UP_SFV = requireStepUp(HOPE_SFV_STEP_UP_OPERATION) as PreHandler;

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
const SCOPE_QUERY_PATIENT = (action: string): PreHandler =>
  requireAbac(action, "hope.scope", {
    notFoundOnDeny: true,
    getTarget: (request) => ({
      patientId: (request.query as { patientId?: unknown } | null)?.patientId,
    }),
  }) as PreHandler;
// The schedule list is the one optional-filter route that narrows by caseload instead of requiring a
// filter: with no `patientId` the ABAC is skipped and the handler applies `listScopeOf`.
const SCOPE_LIST_PATIENT = (action: string): PreHandler => {
  const verifyNamedPatient = SCOPE_QUERY_PATIENT(action);
  return async (request, reply) => {
    const named = (request.query as { patientId?: unknown } | null)?.patientId;
    if (typeof named === "string" && named.length > 0) await verifyNamedPatient(request, reply);
  };
};
const SCOPE_QUERY_PE = (action: string): PreHandler =>
  requireAbac(action, "hope.scope", {
    notFoundOnDeny: true,
    getTarget: (request) => ({
      providerEntityId: (request.query as { providerEntityId?: unknown } | null)?.providerEntityId,
    }),
  }) as PreHandler;

export function registerHopeRoutes(app: FastifyInstance, deps: HopeRouteDeps): void {
  const { service } = deps;
  const caseloadPatientIds =
    deps.caseloadPatientIds ?? ((q) => getSeam("CaseloadProvider").caseloadPatientIds(q));

  // 0 — admission-scoped operational HOPE workflow summary. This Phase-2 read model lets the web
  // overview render fixed RFA schedules and dynamic SFVs from one PHI-minimal M10 response.
  app.get(
    "/api/v1/admissions/:admissionId/hope",
    {
      preHandler: [READ_TIMEPOINT, SCOPE("hope.timepoint.read")],
      config: { auditRead: { resourceKind: "hope_workflow", resourceIdParam: "admissionId" } },
    },
    async (request) => {
      const { organizationId } = membershipActorOf(request);
      const { admissionId } = parse(AdmissionParamsSchema, request.params);
      const result = await service.getWorkflowState(organizationId, admissionId);
      return parse(HopeWorkflowStateResponseSchema, result);
    },
  );

  // 1 — list schedules (org or filtered patient; status / RFA / window-state).
  app.get(
    "/api/v1/hope/schedules",
    {
      preHandler: [READ_SCHEDULE, SCOPE_LIST_PATIENT("hope.schedule.read")],
      config: { auditRead: { resourceKind: "hope_schedule", list: true } },
    },
    async (request) => {
      const { organizationId } = membershipActorOf(request);
      const q = parse(ScheduleListQuerySchema, request.query);
      // A named `patientId` was verified against the caseload by `hope.scope`. An unfiltered list is
      // narrowed in the query (GAP-182, as for the SFV worklist): org-wide roles see all, everyone else
      // only their caseload, so a clinician's home can show their own overdue windows.
      const scope = q.patientId ? null : await listScopeOf(request, caseloadPatientIds);
      return service.listSchedules(organizationId, {
        patientId: q.patientId,
        status: q.status,
        rfaKind: q.rfaKind,
        ...(scope ? { patientIds: scope } : {}),
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
      const { organizationId } = membershipActorOf(request);
      const { id } = parse(ScheduleParamsSchema, request.params);
      return service.getSchedule(organizationId, id);
    },
  );

  // 3 — skip a schedule (requires a reason code from the closed list; no free text, no note).
  app.post(
    "/api/v1/hope/schedules/:id/skip",
    { preHandler: [SKIP, REJECT_AI_OPERATIONS, SCOPE_SCHEDULE("hope.schedule.skip")] },
    async (request) => {
      const { organizationId, userId } = membershipActorOf(request);
      const { id } = parse(ScheduleParamsSchema, request.params);
      const body = parse(SkipScheduleSchema, request.body);
      // The acting membership and the request facts ride into the explicit `hope.schedule_skipped` audit event.
      return service.skipSchedule(organizationId, id, body.reasonCode, {
        membershipId: userId,
        request: signatureRequestFacts(request),
      });
    },
  );

  // 4 — record a new HOPE timepoint (draft); RN/NP/MD-only author (§4.7); idempotent via Idempotency-Key.
  app.post(
    "/api/v1/admissions/:admissionId/hope/timepoints",
    { preHandler: [WRITE, LATE_OVERRIDE_GATE, SCOPE("hope.timepoint.write"), ABAC_AUTHOR] },
    async (request, reply) => {
      const { organizationId, userId } = membershipActorOf(request);
      const { admissionId } = parse(AdmissionParamsSchema, request.params);
      const body = parse(RecordTimepointSchema, request.body);
      const overrideJustification = requireOverrideJustification(body);
      assertAuthorBoundToActor(body.rfaKind, body.authorDiscipline, request.context?.roles ?? []);
      const res = await service.recordTimepoint(organizationId, userId, admissionId, {
        rfaKind: body.rfaKind,
        targetDate: body.targetDate,
        authorDiscipline: body.authorDiscipline,
        data: body.data,
        sourceEncounterId: body.sourceEncounterId,
        dischargeReason: body.dischargeReason,
        lateCompletionReasonCode: body.lateCompletionReasonCode,
        adminOverride: body.adminOverride,
        adminOverrideJustification: overrideJustification,
        scheduleId: body.scheduleId,
        request: signatureRequestFacts(request),
      });
      return reply.code(201).send(res);
    },
  );

  // 5 — record an SFV completion (RFA 04); RN/NP/LPN/LVN author (§4.7); matches an open SFV row OF THE URL
  // ADMISSION (R-01: the service binds the SFV to `:admissionId`, which `hope.scope` has verified). It inserts
  // an already-SIGNED RFA-04, so it is a signing route (R-05): attestation + fresh step-up + no AI actor.
  app.post(
    "/api/v1/admissions/:admissionId/hope/sfv",
    {
      preHandler: [
        WRITE,
        REJECT_AI,
        LATE_OVERRIDE_GATE,
        SCOPE("hope.timepoint.write"),
        ABAC_SFV,
        ...(deps.sfvCompletionRateLimit ? [deps.sfvCompletionRateLimit] : []),
        STEP_UP_SFV,
      ],
    },
    async (request, reply) => {
      const { organizationId, userId } = membershipActorOf(request);
      const { admissionId } = parse(AdmissionParamsSchema, request.params);
      requireStrictAttestation(request.body);
      const body = parse(RecordSfvSchema, request.body);
      const overrideJustification = requireOverrideJustification(body);
      // #850: the body's CMS attribution must be the actor's own discipline (an LPN cannot sign as RN).
      assertAuthorBoundToActor("04_sfv", body.authorDiscipline, request.context?.roles ?? []);
      const res = await service.recordSfv(organizationId, userId, admissionId, {
        triggeringAssessmentId: body.triggeringAssessmentId,
        targetDate: body.targetDate,
        authorDiscipline: body.authorDiscipline,
        data: body.data,
        adminOverride: body.adminOverride,
        adminOverrideJustification: overrideJustification,
        attestationConfirmed: body.attestationConfirmed,
        attestationVersion: body.attestationVersion,
        request: signatureRequestFacts(request),
      });
      return reply.code(201).send(res);
    },
  );

  // 6 — update a draft assessment.
  app.put(
    "/api/v1/hope/assessments/:id",
    { preHandler: [WRITE, SCOPE("hope.timepoint.write"), ABAC_AUTHOR_ON_ROW] },
    async (request) => {
      const { organizationId } = membershipActorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      const body = parse(UpdateDraftSchema, request.body);
      return service.updateDraft(organizationId, id, body.data);
    },
  );

  // 7 — sign a draft (→ signed; runs the D4 J2051 trigger; snapshots PPS/ESAS-r); RN/NP/MD-only. R-05: the
  // body must carry `attestationConfirmed: true` (the `parse` below), and a fresh step-up is the last guard.
  app.post(
    "/api/v1/hope/assessments/:id/sign",
    { preHandler: [SIGN, REJECT_AI, SCOPE("hope.timepoint.sign"), ABAC_SIGN, STEP_UP_SIGN] },
    async (request) => {
      const { organizationId, userId } = membershipActorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      requireStrictAttestation(request.body);
      const body = parse(SignTimepointSchema, request.body);
      return parse(
        HopeSignResponseSchema,
        await service.signTimepoint(organizationId, userId, id, {
          ...body,
          request: signatureRequestFacts(request),
        }),
      );
    },
  );

  // 8 — insert a correction draft; original-signer or clinical-lead (§4.7).
  app.post(
    "/api/v1/hope/assessments/:id/correct",
    { preHandler: [CORRECT, SCOPE("hope.timepoint.correct"), ABAC_CORRECT] },
    async (request, reply) => {
      const { organizationId, userId } = membershipActorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      const body = parse(CorrectTimepointSchema, request.body);
      await assertAmendmentAttribution(service, request, organizationId, id, body.authorDiscipline);
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
      const { organizationId, userId } = membershipActorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      const body = parse(InactivateTimepointSchema, request.body);
      await assertAmendmentAttribution(service, request, organizationId, id, body.authorDiscipline);
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
      const { organizationId } = membershipActorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      return service.getAssessment(organizationId, id);
    },
  );

  // 9A — reverse lookup: which submission batch(es) hold this assessment, and their status.
  app.get(
    "/api/v1/hope/assessments/:id/submissions",
    {
      preHandler: [READ_TIMEPOINT, SCOPE("hope.timepoint.read")],
      config: { auditRead: { resourceKind: "hope_assessment", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = membershipActorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      return service.listAssessmentSubmissions(organizationId, id);
    },
  );

  // 9B — canonical answer workspace: active assessment items + current item-level states. A writer's open also freezes the spec
  // of a legacy spec-less draft and refreshes chart-derived answers (and bumps `version` when one changes); a read-only caller
  // is shown the stored state, and for a spec-less draft it is a static 409 (nothing is written).
  app.get(
    "/api/v1/hope/assessments/:id/workspace",
    {
      preHandler: [READ_TIMEPOINT, SCOPE("hope.timepoint.read")],
      config: { auditRead: { resourceKind: "hope_assessment_workspace", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = membershipActorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      return parse(
        HopeAssessmentWorkspaceResponseSchema,
        await service.getAssessmentWorkspace(organizationId, id, {
          mayWrite: await callerMayWrite(request),
        }),
      );
    },
  );

  // 9C — final-review/readiness model. Opening it never touches signature state. Its writes, each in a transaction of its
  // own that commits before the next starts, are (1) the spec-freezing step of a legacy spec-less draft (an assessment UPDATE
  // plus its control answers; nothing for a draft that already has a spec) and (2) the self-heal of a completed SFV's
  // J2052/J2053 answers on a still-draft triggering assessment (see hope-sfv-completion-answers.ts). BOTH run only for a caller
  // holding `hope.timepoint.write`: a read-only caller reads the stored state, and for a spec-less draft is answered a static
  // 409 with nothing written. The readiness read that follows writes no assessment data (the read-audit event of `auditRead`
  // is the platform's, not this handler's).
  app.get(
    "/api/v1/hope/assessments/:id/review",
    {
      preHandler: [READ_TIMEPOINT, SCOPE("hope.timepoint.read")],
      config: { auditRead: { resourceKind: "hope_assessment_review", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = membershipActorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      return parse(
        HopeAssessmentReviewResponseSchema,
        await service.getAssessmentReview(organizationId, id, {
          mayWrite: await callerMayWrite(request),
        }),
      );
    },
  );

  // 9D — canonical answer patch. Public API supports only set/clear; skipped remains internal.
  app.patch(
    "/api/v1/hope/assessments/:id/answers",
    { preHandler: [WRITE, SCOPE("hope.timepoint.write"), ABAC_AUTHOR_ON_ROW] },
    async (request) => {
      const { organizationId, userId } = membershipActorOf(request);
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
    { preHandler: [WRITE, SCOPE("hope.timepoint.write"), ABAC_AUTHOR_ON_ROW] },
    async (request) => {
      const { organizationId, userId } = membershipActorOf(request);
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
      const { organizationId } = membershipActorOf(request);
      const { patientId } = parse(PatientParamsSchema, request.params);
      return service.listPatientAssessments(organizationId, patientId);
    },
  );

  // 11 — request the printable HOPE summary (emits `m10.hope.summary_requested`; M22 renders).
  app.post(
    "/api/v1/hope/assessments/:id/summary-pdf",
    { preHandler: [READ_TIMEPOINT, SCOPE("hope.timepoint.read")] },
    async (request, reply) => {
      const { organizationId, userId } = membershipActorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      parse(SummaryPdfSchema, request.body);
      const res = await service.requestSummaryPdf(organizationId, userId, id);
      return reply.code(202).send(res);
    },
  );

  // 12 — open / overdue / missed SFV worklist. §4.1 ABAC = "caseload", but this route names no patient and
  // addresses no resource (a state filter and an optional `triggeringAssessmentId` filter, whose unknown value is an
  // empty list), so there is no id for `hope.scope` to guard. GAP-182: the caseload is applied as a QUERY narrowing
  // instead (`listScopeOf`) — org-wide scope roles see the whole worklist, everyone else only their caseload's rows,
  // with or without the filter.
  app.get(
    "/api/v1/hope/sfv",
    {
      preHandler: [READ_SFV],
      config: { auditRead: { resourceKind: "hope_sfv", list: true } },
    },
    async (request) => {
      const { organizationId } = membershipActorOf(request);
      const q = parse(SfvWorklistQuerySchema, request.query);
      return service.listSfv(
        organizationId,
        q.state,
        (await listScopeOf(request, caseloadPatientIds)) ?? undefined,
        q.triggeringAssessmentId,
      );
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
      const { organizationId } = membershipActorOf(request);
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
      const { organizationId } = membershipActorOf(request);
      const { id } = parse(AssessmentParamsSchema, request.params);
      const query = parse(ValidationQuerySchema, request.query);
      return service.getValidation(organizationId, id, {
        mode: query.mode,
        submissionDate: query.submissionDate,
        mayWrite: await callerMayWrite(request),
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
      const { organizationId } = membershipActorOf(request);
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
      const { organizationId } = membershipActorOf(request);
      const { id } = parse(SubmissionParamsSchema, request.params);
      return service.getSubmission(organizationId, id);
    },
  );

  // 17 — requeue a rejected submission for the next transmit pass.
  //
  // DEPRECATED FOR THE UI: nothing consumes `queued`, and iQIES has no retry. A rejected record is fixed
  // with a correction assessment (`POST /assessments/:id/correct`) and re-packaged in a NEW batch by
  // assemble (a rejected original is never re-sent unchanged). Route kept for contract stability only.
  //
  // F-058 (#150) — this comment used to read "re-validates, re-assembles". It does neither: it flips
  // `status` from `rejected` to `queued` and re-emits `m10.hope.submission_queued`. Re-validation is
  // `iqies-submit-worker`'s job (`decideSubmitReadiness` → `hasBlockingError`), and that worker has no
  // transport to be wired to — `@chartwarden/iqies-client`'s only adapter is the deny-stub. Requeueing is
  // still the right transition to expose; describing it as work it does not do is not.
  app.post(
    "/api/v1/hope/submissions/:id/retry",
    { preHandler: [...SUBMISSION_OPERATION_GUARDS] },
    async (request) => {
      const { organizationId } = membershipActorOf(request);
      const { id } = parse(SubmissionParamsSchema, request.params);
      parse(RetrySubmissionSchema, request.body);
      return service.retrySubmission(organizationId, id);
    },
  );

  // 18 — force-assemble this provider entity's eligible signed assessments into per-period batches
  // (§4.10 stage 1). F-058 (#150): this used to insert one `hope_submission` with `itemCount: 0` and no
  // `hope_submission_item` rows at all, ignoring `planAssembleSubmissions`, and answer 201.
  app.post(
    "/api/v1/hope/submissions/assemble",
    { preHandler: [...SUBMISSION_ASSEMBLE_GUARDS] },
    async (request, reply) => {
      const { organizationId } = membershipActorOf(request);
      const body = parse(AssembleSubmissionSchema, request.body);
      const res = await service.assembleSubmission(organizationId, body.providerEntityId);
      return reply.code(201).send(res);
    },
  );

  app.get(
    "/api/v1/hope/submissions/:id/package",
    {
      // Like every other submission-lifecycle route this refuses an AI principal: it streams the whole PHI package and
      // advances `packaged -> exported`.
      preHandler: [...SUBMISSION_OPERATION_GUARDS],
      config: { auditRead: { resourceKind: "hope_submission", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const { organizationId, userId } = membershipActorOf(request);
      const { id } = parse(SubmissionParamsSchema, request.params);
      const pkg = await service.downloadSubmissionPackage(organizationId, id, userId);
      return reply
        .header("content-type", pkg.contentType)
        .header("content-disposition", `attachment; filename="${pkg.filename}"`)
        .send(pkg.bytes);
    },
  );

  app.post(
    "/api/v1/hope/submissions/:id/mark-uploaded",
    { preHandler: [...SUBMISSION_OPERATION_GUARDS] },
    async (request) => {
      const { organizationId, userId } = membershipActorOf(request);
      const { id } = parse(SubmissionParamsSchema, request.params);
      const body = parse(MarkSubmissionUploadedSchema, request.body);
      assertReferenceHasNoPatientIdentifier(
        "iqiesSubmissionReference",
        body.iqiesSubmissionReference,
      );
      return service.markSubmissionUploaded(organizationId, userId, id, body);
    },
  );

  // R-08 — cancel a package that was generated but never marked uploaded, so its signed assessments can be
  // packaged again in a NEW batch (a lost/never-uploaded package used to lock them forever). 409 once the batch was
  // marked uploaded; the reason is a fixed code list (no free text, so no PHI). Replaying a cancel returns 200.
  app.post(
    "/api/v1/hope/submissions/:id/cancel",
    { preHandler: [...SUBMISSION_OPERATION_GUARDS] },
    async (request) => {
      const { organizationId, userId } = membershipActorOf(request);
      const { id } = parse(SubmissionParamsSchema, request.params);
      const body = parse(CancelSubmissionSchema, request.body);
      return service.cancelSubmission(organizationId, userId, id, {
        ...body,
        request: signatureRequestFacts(request),
      });
    },
  );

  app.post(
    "/api/v1/hope/submissions/:id/results",
    { preHandler: [...SUBMISSION_OPERATION_GUARDS] },
    async (request) => {
      const { organizationId, userId } = membershipActorOf(request);
      const { id } = parse(SubmissionParamsSchema, request.params);
      const body = parse(ImportSubmissionResultSchema, request.body);
      assertReferenceHasNoPatientIdentifier("reportReference", body.reportReference);
      assertResultRowsHaveNoPatientIdentifier(body.results);
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
      const { organizationId } = membershipActorOf(request);
      const q = parse(DashboardQuerySchema, request.query);
      return service.complianceDashboard(organizationId, q.providerEntityId);
    },
  );

  // 20 — admin: create the HOPE schedule windows an admission is entitled to and still lacks (a backfill). Idempotent: a row
  // in any status is left as it is, so nothing is recomputed, reopened or moved to a corrected date.
  app.post(
    "/api/v1/hope/admin/regenerate-schedules",
    { preHandler: [...REGENERATE_SCHEDULES_GUARDS] },
    async (request) => {
      const { organizationId, userId } = membershipActorOf(request);
      const body = parse(RegenerateSchedulesSchema, request.body);
      return service.regenerateSchedules(organizationId, body.admissionId, {
        membershipId: userId,
        request: signatureRequestFacts(request),
      });
    },
  );
}
