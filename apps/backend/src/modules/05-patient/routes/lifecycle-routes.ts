// apps/backend/src/modules/05-patient/routes/lifecycle-routes.ts — GAP-018 / GAP-019 / GAP-012 (backend):
// the M5 §4.3 routes that were specified and never registered.
//
//   PATCH /patients/:id                          patient.edit                 caseload_or_scope
//   POST  /patients/:id/status                   patient.transition_status    caseload_or_scope
//   POST  /patients/:id/deceased                 patient.record_death + step-up  caseload_or_scope
//   POST  /patients/:id/identifiers              patient.edit_identifiers     caseload_or_scope
//   GET   /patients/:id/caregivers               patient.read                 caseload_or_scope
//   POST  /patients/:id/caregivers               patient.edit                 caseload_or_scope
//   GET   /patient-matches                       patient.match_review         (org-scoped)
//   POST  /patient-matches/:id/merge             patient.merge + step-up      (org-scoped)
//   POST  /patient-matches/:id/not-a-match       patient.match_review         (org-scoped)
//   POST  /patient-merges/:id/unmerge            patient.merge + step-up (<=30d)
//   GET   /patients/:id/amendments               patient.read                 caseload_or_scope
//   GET   /amendments                            patient.amend_review         (staff inbox; GAP-012)
//   POST  /amendments/:id/statement              patient.amend_request_submit (org-scoped)
//
// Chart-scoped routes compose the same `caseload_or_scope` guard as `patient-routes.ts` (404 on deny, so a
// refusal never confirms the chart exists). The review-queue / amendment routes are `abac: "none"` in the
// §4.3 table and the catalog: they act on a REVIEW or AMENDMENT id, which `caseload_or_scope` cannot
// resolve to a patient (same reasoning as the accept/deny routes in `patient-routes.ts`).
import { type GuardRequest, requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import { UnauthorizedError, WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { InvalidDeceasedDateError } from "../deceased";
import { InvalidDeceasedTransitionError } from "../deceased-db";
import {
  SelfMergeError,
  SourceAlreadyMergedError,
  TargetAlreadyMergedError,
  UnknownMergeFieldError,
  UnmergeableSourceStatusError,
} from "../merges";
import { PatientNotFoundError } from "../merges-db";
import {
  AmendmentAlreadyDecidedError,
  AmendmentNotDeniedError,
  AmendmentNotFoundError,
  IdentifierConflictError,
  InvalidStatusTransitionError,
  LegalRepresentativeProofError,
  MatchReviewClosedError,
  MatchReviewNotFoundError,
  MatchReviewNotMergeableError,
  MergeAlreadyReversedError,
  MergeNotFoundError,
  type NewIdentifierKind,
  type PatientLifecyclePort,
  PrimaryCaregiverExistsError,
  SensitiveIdentifierUnsupportedError,
  UnmergeWindowExpiredError,
} from "../patient-lifecycle";
import {
  AmendmentInboxQuerySchema,
  CaregiverBodySchema,
  DeceasedBodySchema,
  IdentifierBodySchema,
  MatchMergeBodySchema,
  MatchQueueQuerySchema,
  NotAMatchBodySchema,
  PatchPatientBodySchema,
  StatementBodySchema,
  StatusBodySchema,
  UnmergeBodySchema,
} from "./lifecycle-typebox";
import { LooseIdParamsSchema, parse } from "./patient-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const DEFAULT_QUEUE_LIMIT = 100;

const chartScope = (action: string): PreHandler =>
  requireAbac(action, "caseload_or_scope", {
    getTarget: (request: GuardRequest) => ({
      patientId: (request.params as { id?: unknown } | undefined)?.id,
    }),
    notFoundOnDeny: true,
  }) as PreHandler;

const perm = (key: string): PreHandler => requirePermission(key) as PreHandler;
const stepUp = (key: string): PreHandler => requireStepUp(key) as PreHandler;

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

const err = (code: string, message: string, status: number): WardenXError =>
  new WardenXError(code, message, status);

/** Typed domain errors → the §4.3 HTTP contract. Anything unrecognised rethrows unchanged. */
export function mapLifecycleError(e: unknown): unknown {
  if (e instanceof PatientNotFoundError) return err("NOT_FOUND", "patient not found", 404);
  if (e instanceof MatchReviewNotFoundError) return err("NOT_FOUND", "match review not found", 404);
  if (e instanceof MergeNotFoundError) return err("NOT_FOUND", "merge not found", 404);
  if (e instanceof AmendmentNotFoundError) return err("NOT_FOUND", "amendment not found", 404);
  if (e instanceof InvalidStatusTransitionError) {
    return err("INVALID_STATUS_TRANSITION", e.message, 409);
  }
  if (e instanceof InvalidDeceasedTransitionError) {
    return err("INVALID_STATUS_TRANSITION", e.message, 409);
  }
  if (e instanceof InvalidDeceasedDateError) return err("INVALID_DECEASED_DATE", e.message, 422);
  if (e instanceof MatchReviewClosedError) return err("MATCH_REVIEW_CLOSED", e.message, 409);
  if (e instanceof MatchReviewNotMergeableError) {
    return err("MATCH_REVIEW_NOT_MERGEABLE", e.message, 409);
  }
  if (e instanceof MergeAlreadyReversedError) return err("MERGE_ALREADY_REVERSED", e.message, 409);
  if (e instanceof UnmergeWindowExpiredError) return err("UNMERGE_WINDOW_EXPIRED", e.message, 409);
  if (e instanceof SelfMergeError) return err("SELF_MERGE", e.message, 422);
  if (e instanceof SourceAlreadyMergedError) return err("ALREADY_MERGED", e.message, 409);
  if (e instanceof TargetAlreadyMergedError) {
    return err("MERGE_TARGET_ALREADY_MERGED", e.message, 409);
  }
  if (e instanceof UnmergeableSourceStatusError) {
    return err("PATIENT_NOT_MERGEABLE", e.message, 409);
  }
  if (e instanceof UnknownMergeFieldError) return err("UNKNOWN_MERGE_FIELD", e.message, 422);
  if (e instanceof IdentifierConflictError) return err("IDENTIFIER_CONFLICT", e.message, 409);
  if (e instanceof SensitiveIdentifierUnsupportedError) {
    return err("SENSITIVE_IDENTIFIER_UNSUPPORTED", e.message, 422);
  }
  if (e instanceof PrimaryCaregiverExistsError) {
    return err("PRIMARY_CAREGIVER_EXISTS", e.message, 409);
  }
  if (e instanceof LegalRepresentativeProofError) {
    return err("LR_PROOF_REQUIRED", e.message, 422);
  }
  if (e instanceof AmendmentNotDeniedError) return err("AMENDMENT_NOT_DENIED", e.message, 409);
  if (e instanceof AmendmentAlreadyDecidedError) {
    return err("AMENDMENT_ALREADY_DECIDED", e.message, 409);
  }
  return e;
}

export interface PatientLifecycleRouteDeps {
  readonly lifecycle: PatientLifecyclePort;
}

const PATIENT_READ = { resourceKind: "patient", patientIdParam: "id" } as const;

export function registerPatientLifecycleRoutes(
  app: FastifyInstance,
  deps: PatientLifecycleRouteDeps,
): void {
  const { lifecycle } = deps;
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw mapLifecycleError(e);
    }
  };

  // --- §4.3 PATCH demographics (MRN immutable; status + SSN have their own paths) -----------------
  app.patch(
    "/api/v1/patients/:id",
    { preHandler: [perm("patient.edit"), chartScope("patient.edit")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const body = parse(PatchPatientBodySchema, request.body);
      return run(() => lifecycle.updateDemographics(organizationId, id, body, userId));
    },
  );

  // --- §4.3 status transition (§2.4.1 state machine) ----------------------------------------------
  app.post(
    "/api/v1/patients/:id/status",
    {
      preHandler: [perm("patient.transition_status"), chartScope("patient.transition_status")],
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const body = parse(StatusBodySchema, request.body);
      return run(() => lifecycle.transitionStatus(organizationId, id, body, userId));
    },
  );

  // --- §4.3 record death (§7.8 cascade; step-up) --------------------------------------------------
  app.post(
    "/api/v1/patients/:id/deceased",
    {
      preHandler: [
        perm("patient.record_death"),
        stepUp("patient.record_death"),
        chartScope("patient.record_death"),
      ],
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const body = parse(DeceasedBodySchema, request.body);
      return run(() => lifecycle.recordDeath(organizationId, id, body, userId));
    },
  );

  // --- §4.3 identifiers (MRN immutable; SSN/state-id deferred to the encrypted path) --------------
  app.post(
    "/api/v1/patients/:id/identifiers",
    {
      preHandler: [perm("patient.edit_identifiers"), chartScope("patient.edit_identifiers")],
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const body = parse(IdentifierBodySchema, request.body);
      if (body.kind === "mrn") {
        throw err("MRN_IMMUTABLE", "the MRN is assigned once at creation and is immutable", 409);
      }
      if (body.kind === "ssn" || body.kind === "state_id") {
        throw mapLifecycleError(new SensitiveIdentifierUnsupportedError(body.kind));
      }
      const created = await run(() =>
        lifecycle.addIdentifier(
          organizationId,
          id,
          {
            kind: body.kind as NewIdentifierKind,
            value: body.value,
            issuer: body.issuer ?? null,
            effectiveFrom: body.effectiveFrom,
          },
          userId,
        ),
      );
      return reply.code(201).send(created);
    },
  );

  // --- §4.3 caregivers ----------------------------------------------------------------------------
  app.get(
    "/api/v1/patients/:id/caregivers",
    {
      preHandler: [perm("patient.read"), chartScope("patient.read")],
      config: {
        auditRead: { ...PATIENT_READ, fields: ["caregivers"], list: true },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const rows = await run(() => lifecycle.listCaregivers(organizationId, id));
      if (rows === null) throw err("NOT_FOUND", "patient not found", 404);
      return { caregivers: rows };
    },
  );

  app.post(
    "/api/v1/patients/:id/caregivers",
    { preHandler: [perm("patient.edit"), chartScope("patient.edit")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const body = parse(CaregiverBodySchema, request.body);
      const created = await run(() => lifecycle.addCaregiver(organizationId, id, body, userId));
      return reply.code(201).send(created);
    },
  );

  // --- §4.3 soft-duplicate review queue (§7.3) ----------------------------------------------------
  app.get(
    "/api/v1/patient-matches",
    {
      preHandler: [perm("patient.match_review")],
      config: {
        auditRead: {
          resourceKind: "patient_match_review",
          list: true,
          fields: ["match_score", "candidate_patient_id", "new_patient_id"],
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(MatchQueueQuerySchema, request.query);
      const items = await run(() =>
        lifecycle.listMatchReviews(organizationId, {
          status: q.status ?? "open",
          limit: q.limit ?? DEFAULT_QUEUE_LIMIT,
        }),
      );
      return { items };
    },
  );

  app.post(
    "/api/v1/patient-matches/:id/merge",
    { preHandler: [perm("patient.merge"), stepUp("patient.merge")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const body = parse(MatchMergeBodySchema, request.body);
      return run(() =>
        lifecycle.mergeMatchReview(
          organizationId,
          id,
          { fieldResolutions: body.fieldResolutions ?? {}, reason: body.reason },
          userId,
        ),
      );
    },
  );

  app.post(
    "/api/v1/patient-matches/:id/not-a-match",
    { preHandler: [perm("patient.match_review")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const body = parse(NotAMatchBodySchema, request.body);
      return run(() => lifecycle.markNotAMatch(organizationId, id, body, userId));
    },
  );

  // --- §4.3 unmerge (<= 30 days; the >30d platform_ops break-glass is a documented deferral) ------
  app.post(
    "/api/v1/patient-merges/:id/unmerge",
    { preHandler: [perm("patient.merge"), stepUp("patient.merge")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const body = parse(UnmergeBodySchema, request.body);
      return run(() => lifecycle.unmerge(organizationId, id, body, userId));
    },
  );

  // --- §4.3 amendments: per-patient list, the staff inbox (GAP-012), statement of disagreement ----
  app.get(
    "/api/v1/patients/:id/amendments",
    {
      preHandler: [perm("patient.read"), chartScope("patient.read")],
      config: { auditRead: { ...PATIENT_READ, fields: ["amendments"], list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const rows = await run(() => lifecycle.listAmendments(organizationId, id));
      if (rows === null) throw err("NOT_FOUND", "patient not found", 404);
      return { amendments: rows };
    },
  );

  app.get(
    "/api/v1/amendments",
    {
      preHandler: [perm("patient.amend_review")],
      config: {
        auditRead: {
          resourceKind: "patient_amendment_request",
          list: true,
          fields: ["patient_id", "scope", "rationale", "status", "sla_due_at"],
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(AmendmentInboxQuerySchema, request.query);
      const items = await run(() =>
        lifecycle.listPendingAmendments(organizationId, {
          status: q.status ?? "pending",
          limit: q.limit ?? DEFAULT_QUEUE_LIMIT,
        }),
      );
      return { items };
    },
  );

  app.post(
    "/api/v1/amendments/:id/statement",
    { preHandler: [perm("patient.amend_request_submit")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const body = parse(StatementBodySchema, request.body);
      return run(() => lifecycle.recordStatement(organizationId, id, body, userId));
    },
  );
}
