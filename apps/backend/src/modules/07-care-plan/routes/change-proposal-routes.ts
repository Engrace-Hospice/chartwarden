// apps/backend/src/modules/07-care-plan/routes/change-proposal-routes.ts — WF09: the plan-of-care CHANGE PROPOSALS a visit records.
//
//   POST   /api/v1/care-plans/:planId/change-proposals                          create a DRAFT (the visit it came from is in the body)
//   PUT    /api/v1/care-plans/:planId/change-proposals/:proposalId              replace a draft
//   DELETE /api/v1/care-plans/:planId/change-proposals/:proposalId              withdraw a draft
//   GET    /api/v1/patients/:patientId/care-plan-change-proposals               one visit's proposals (the caller's drafts included), or the pending ones
//   GET    /api/v1/care-plans/:planId/change-proposals                          the plan's review list (released proposals only)
//   POST   /api/v1/care-plans/:planId/change-proposals/:proposalId/accept       apply it to the plan, through the manual route's own service operation
//   POST   /api/v1/care-plans/:planId/change-proposals/:proposalId/dismiss      decline it (optionally with a coded reason)
//
// A visit never edits the signed plan: a draft is invisible to everyone but its proposer; the visit's finalization releases it onto the review
// list (the `m8.encounter.finalized` consumer); the case manager or a supervisor then accepts or dismisses it. Every write carries the
// `caseload_or_scope` ABAC and the same AI-principal refusal as the problem-proposal routes beside it. Accepting additionally runs under the
// accepter's own §7.4 discipline scope, because it IS the manual route's operation.
//
// PROPOSE — who may record a proposal — is `care_plan.read` (every clinical role that works from the plan: the visiting RN, LPN, NP, MD ...),
// because a proposal changes nothing on the plan: it waits on the review list until someone holding `care_plan.author` (the RN case manager,
// the clinical supervisor, the DON) ACCEPTS it, and acceptance runs the manual route's own operation under the accepter's discipline scope.
// Requiring `author` here would stop a visiting RN who is not the case manager from reporting what the visit found, which is the point of the feature.
import { requireAbac, requirePermission } from "@chartwarden/auth";
import {
  type PreHandler,
  rejectAiActor,
  requireIdempotencyKey,
  writeActorOf,
} from "@chartwarden/shared/route-kit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { disciplineScopeOf, membershipIdOf } from "../abac-predicates";
import type { CarePlanChangeProposalService } from "../change-proposals-db";
import type { CarePlanRouteDeps } from "./care-plan-routes";
import { parse } from "./care-plan-typebox";
import {
  ChangeProposalParamsSchema,
  ChangeProposalPatientListQuerySchema,
  ChangeProposalPatientParamsSchema,
  ChangeProposalPlanListQuerySchema,
  ChangeProposalPlanParamsSchema,
  CreateChangeProposalSchema,
  DismissChangeProposalSchema,
  ReplaceChangeProposalSchema,
} from "./change-proposal-typebox";

export interface ChangeProposalRouteDeps {
  readonly service: CarePlanChangeProposalService;
  /** The same §7.6 resolver the care-plan routes use (fail-closed default: deny). */
  readonly sudDisclosureAllowed?: CarePlanRouteDeps["sudDisclosureAllowed"];
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("care_plan.read");
const AUTHOR = P("care_plan.author");
/**
 * Who may record a proposal — see the header. This is `care_plan.read`, not a key of its own, and that rests on two things:
 *   • CW-AC-44: the read key is held only by the roles that work from the plan; an external, portal or collaborator role never gets it
 *     (compliance/controls.yaml), so the clinical population is the key's, not this route's.
 *   • The real gate is the seam check in the service (./change-proposals-visit.ts): a proposal is recorded against a visit note, and M8 must
 *     answer that the caller AUTHORED that note, for this patient, and that it is still a draft. A holder of the read key who wrote no note
 *     cannot propose anything.
 * Do not widen the key's holders (or the seam check) without revisiting both.
 */
const PROPOSE = READ;
const SCOPE = (action: string): PreHandler =>
  requireAbac(action, "caseload_or_scope", { notFoundOnDeny: true }) as PreHandler;
const IDEMPOTENT = requireIdempotencyKey();

/** An AI principal can neither record nor decide a plan change: it is a human clinician's act (AI Governance §2.1.1). */
const REJECT_AI = rejectAiActor(
  "AI principals cannot propose or decide a plan change",
) as PreHandler;

export function registerChangeProposalRoutes(
  app: FastifyInstance,
  deps: ChangeProposalRouteDeps,
): void {
  const { service } = deps;
  const sudDisclosureAllowed = deps.sudDisclosureAllowed ?? (async () => false);

  /** The acting clinician (401 without a session, 403 without a membership) and their §7.6 verdict for the plan's patient. */
  const callerOf = async (request: FastifyRequest, planId: string) => {
    const actor = writeActorOf(request);
    return {
      organizationId: actor.organizationId,
      userId: actor.userId,
      membershipId: actor.membershipId,
      sudDisclosureAllowed: await sudDisclosureAllowed({
        organizationId: actor.organizationId,
        patientId: "",
        planId,
        roles: actor.roles,
        membershipId: actor.membershipId,
      }),
    };
  };

  app.post(
    "/api/v1/care-plans/:planId/change-proposals",
    { preHandler: [REJECT_AI, PROPOSE, SCOPE("care_plan.read"), IDEMPOTENT] },
    async (request, reply) => {
      const { planId } = parse(ChangeProposalPlanParamsSchema, request.params);
      const body = parse(CreateChangeProposalSchema, request.body);
      const { organizationId, ...caller } = await callerOf(request, planId);
      return reply.code(201).send(await service.create(organizationId, planId, body, caller));
    },
  );

  app.put(
    "/api/v1/care-plans/:planId/change-proposals/:proposalId",
    { preHandler: [REJECT_AI, PROPOSE, SCOPE("care_plan.read")] },
    async (request) => {
      const { planId, proposalId } = parse(ChangeProposalParamsSchema, request.params);
      const body = parse(ReplaceChangeProposalSchema, request.body);
      const { organizationId, ...caller } = await callerOf(request, planId);
      return service.replace(organizationId, planId, proposalId, body, caller);
    },
  );

  app.delete(
    "/api/v1/care-plans/:planId/change-proposals/:proposalId",
    { preHandler: [REJECT_AI, PROPOSE, SCOPE("care_plan.read")] },
    async (request) => {
      const { planId, proposalId } = parse(ChangeProposalParamsSchema, request.params);
      const { organizationId, ...caller } = await callerOf(request, planId);
      return service.withdraw(organizationId, planId, proposalId, caller);
    },
  );

  app.get(
    "/api/v1/patients/:patientId/care-plan-change-proposals",
    {
      preHandler: [READ, SCOPE("care_plan.read")],
      config: {
        auditRead: {
          resourceKind: "care_plan_change_proposal",
          patientIdParam: "patientId",
          list: true,
        },
      },
    },
    async (request) => {
      const { patientId } = parse(ChangeProposalPatientParamsSchema, request.params);
      const q = parse(ChangeProposalPatientListQuerySchema, request.query);
      const organizationId = request.context.organizationId as string;
      return service.listForPatient(organizationId, patientId, {
        ...(q.sourceEncounterId ? { sourceEncounterId: q.sourceEncounterId } : {}),
        ...(q.status ? { status: q.status } : {}),
        membershipId: membershipIdOf(request.context),
        sudDisclosureAllowed: await sudDisclosureAllowed({
          organizationId,
          patientId,
          planId: "",
          roles: request.context.roles,
          membershipId: membershipIdOf(request.context),
        }),
      });
    },
  );

  app.get(
    "/api/v1/care-plans/:planId/change-proposals",
    {
      preHandler: [READ, SCOPE("care_plan.read")],
      // The list names its patient in the response, so the read is accounted against the patient (§164.528).
      config: {
        auditRead: {
          resourceKind: "care_plan_change_proposal",
          list: true,
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request) => {
      const { planId } = parse(ChangeProposalPlanParamsSchema, request.params);
      const q = parse(ChangeProposalPlanListQuerySchema, request.query);
      const caller = await callerOf(request, planId);
      return service.listForPlan(caller.organizationId, planId, {
        ...(q.status ? { status: q.status } : {}),
        sudDisclosureAllowed: caller.sudDisclosureAllowed,
      });
    },
  );

  app.post(
    "/api/v1/care-plans/:planId/change-proposals/:proposalId/accept",
    { preHandler: [REJECT_AI, AUTHOR, SCOPE("care_plan.author")] },
    async (request) => {
      const { planId, proposalId } = parse(ChangeProposalParamsSchema, request.params);
      const { organizationId, ...caller } = await callerOf(request, planId);
      return service.accept(organizationId, planId, proposalId, {
        ...caller,
        disciplineScope: disciplineScopeOf(request.context),
      });
    },
  );

  app.post(
    "/api/v1/care-plans/:planId/change-proposals/:proposalId/dismiss",
    { preHandler: [REJECT_AI, AUTHOR, SCOPE("care_plan.author")] },
    async (request) => {
      const { planId, proposalId } = parse(ChangeProposalParamsSchema, request.params);
      const body = parse(DismissChangeProposalSchema, request.body);
      const { organizationId, ...caller } = await callerOf(request, planId);
      return service.dismiss(organizationId, planId, proposalId, body, caller);
    },
  );
}
