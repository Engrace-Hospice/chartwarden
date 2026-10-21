// apps/backend/src/modules/07-care-plan/routes/problem-proposal-routes.ts — F-238 dx-writeback: the
// clinician's accept / dismiss surface for DocLens-extracted diagnoses (M7 `problem_proposal`).
//
//   GET  /api/v1/care-plans/:planId/problem-proposals                      care_plan.read   + caseload_or_scope
//   POST /api/v1/care-plans/:planId/problem-proposals/:proposalId/accept   care_plan.author + caseload_or_scope
//   POST /api/v1/care-plans/:planId/problem-proposals/:proposalId/dismiss  care_plan.author + caseload_or_scope
//
// Accept/dismiss carry exactly the permission + ABAC that adding a problem by hand does (`POST
// /care-plans/:planId/problems`), plus: AI principals are refused (accepting an AI-extracted diagnosis is
// the human acknowledgment AI Governance §2.1.1 requires — an AI actor cannot give it), and the acting
// membership is required (it is stamped as the problem's `added_by` and the proposal's decider).
// SUD-flagged proposals follow the §7.6 rule: omitted for a caller without disclosure, 404 on decide.
import { requireAbac, requirePermission } from "@chartwarden/auth";
import { ForbiddenError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { membershipIdOf } from "../abac-predicates";
import type { ProblemProposalService } from "../problem-proposals-db";
import type { CarePlanRouteDeps } from "./care-plan-routes";
import { PlanParamsSchema, parse } from "./care-plan-typebox";
import type { PreHandler } from "./concurrency";
import {
  AcceptProblemProposalSchema,
  DismissProblemProposalSchema,
  ProblemProposalListQuerySchema,
  ProblemProposalParamsSchema,
} from "./problem-proposal-typebox";

export interface ProblemProposalRouteDeps {
  readonly service: ProblemProposalService;
  /** The same §7.6 resolver the care-plan routes use (fail-closed default: deny). */
  readonly sudDisclosureAllowed?: CarePlanRouteDeps["sudDisclosureAllowed"];
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("care_plan.read");
const AUTHOR = P("care_plan.author");
const SCOPE = (action: string): PreHandler =>
  requireAbac(action, "caseload_or_scope", { notFoundOnDeny: true }) as PreHandler;

/** An AI principal cannot accept or dismiss an AI-extracted diagnosis (§2.1.1 human acknowledgment). */
const REJECT_AI: PreHandler = async (request) => {
  const kind = request.context?.attributes?.actorKind;
  if (typeof kind === "string" && kind.startsWith("ai_")) {
    throw new ForbiddenError("AI principals cannot decide a proposed problem");
  }
};

export function registerProblemProposalRoutes(
  app: FastifyInstance,
  deps: ProblemProposalRouteDeps,
): void {
  const { service } = deps;
  const sudDisclosureAllowed = deps.sudDisclosureAllowed ?? (async () => false);

  const callerOf = async (request: Parameters<PreHandler>[0], planId: string) => {
    const ctx = request.context;
    if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
    const membershipId = membershipIdOf(ctx);
    const allowSud = await sudDisclosureAllowed({
      organizationId: ctx.organizationId,
      patientId: "",
      planId,
      roles: ctx.roles,
      membershipId,
    });
    return { organizationId: ctx.organizationId, userId: ctx.userId, membershipId, allowSud };
  };

  app.get(
    "/api/v1/care-plans/:planId/problem-proposals",
    {
      preHandler: [READ, SCOPE("care_plan.read")],
      config: { auditRead: { resourceKind: "care_plan", resourceIdParam: "planId" } },
    },
    async (request) => {
      const { planId } = parse(PlanParamsSchema, request.params);
      const q = parse(ProblemProposalListQuerySchema, request.query);
      const caller = await callerOf(request, planId);
      return service.list(caller.organizationId, planId, {
        ...(q.status ? { status: q.status } : {}),
        sudDisclosureAllowed: caller.allowSud,
      });
    },
  );

  app.post(
    "/api/v1/care-plans/:planId/problem-proposals/:proposalId/accept",
    { preHandler: [REJECT_AI, AUTHOR, SCOPE("care_plan.author")] },
    async (request) => {
      const { planId, proposalId } = parse(ProblemProposalParamsSchema, request.params);
      const body = parse(AcceptProblemProposalSchema, request.body);
      const caller = await callerOf(request, planId);
      if (!caller.membershipId) throw new UnauthorizedError();
      return service.accept(
        caller.organizationId,
        planId,
        proposalId,
        {
          ifVersion: body.ifVersion,
          kind: body.kind,
          ...(body.icd10Code !== undefined ? { icd10Code: body.icd10Code } : {}),
        },
        {
          userId: caller.userId,
          membershipId: caller.membershipId,
          sudDisclosureAllowed: caller.allowSud,
        },
      );
    },
  );

  app.post(
    "/api/v1/care-plans/:planId/problem-proposals/:proposalId/dismiss",
    { preHandler: [REJECT_AI, AUTHOR, SCOPE("care_plan.author")] },
    async (request) => {
      const { planId, proposalId } = parse(ProblemProposalParamsSchema, request.params);
      const body = parse(DismissProblemProposalSchema, request.body);
      const caller = await callerOf(request, planId);
      if (!caller.membershipId) throw new UnauthorizedError();
      return service.dismiss(
        caller.organizationId,
        planId,
        proposalId,
        { ifVersion: body.ifVersion, ...(body.reason ? { reason: body.reason } : {}) },
        {
          userId: caller.userId,
          membershipId: caller.membershipId,
          sudDisclosureAllowed: caller.allowSud,
        },
      );
    },
  );
}
