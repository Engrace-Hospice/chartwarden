// apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/onboarding-tasks.ts — M34 §4.1, wizard v2.
//
// The TENANT-scoped onboarding routes (the tenant's own org, via the wizard service's `withOrgContext`). The wizard is
// data-driven off the platform-shared `onboarding_task_template` catalog; this surface lets the tenant read its ordered
// wizard and act on the steps IT owns: start, block, attest (a human marks a step done with required evidence), re-open,
// and - for the org_admin - set the org profile and assign the compliance officer, who attests go-live readiness (the
// first party of the two-party go-live). The strict sequence, owner-role, evidence and go-live rules live in the service
// (onboarding/wizard-service.ts), not here; these routes compose the §4.5 keys, the §4.6 ABAC predicates, step-up where a
// decision is security-relevant, and the human-actor (no AI) block.
import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";
import type { FastifyInstance } from "fastify";
import { rejectAiActor } from "../../../../bootstrap/reject-ai-actor";
import type { OnboardingWizard } from "../../onboarding/wizard-service";
import {
  GoLiveAttestRequest,
  OrgProfileRequest,
  SetComplianceOfficerRequest,
  TenantAttestStepRequest,
  TenantCompleteStepRequest,
  TenantReopenStepRequest,
} from "../onboarding-wizard-typebox";
import { type PreHandler, actorOf } from "./actor";
import {
  OnboardingBlockRequest,
  OnboardingListQuerySchema,
  OnboardingStartRequest,
  OnboardingTaskParamsSchema,
  parse,
} from "./tenant-typebox";

export interface OnboardingRouteDeps {
  wizard: OnboardingWizard;
}

// §4.5 permission guards.
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("onboarding.read_own");
const UPDATE = P("onboarding.update");
const MANAGE_OWN = P("onboarding.manage_own");
const GO_LIVE_ATTEST = P("go_live.attest");

// §4.6 ABAC. A step is the task's assignee's OR the org_admin's; the owner-role rule per step is the service's. The org
// profile and the officer assignment are the org_admin's; go-live readiness is the compliance officer's.
const ABAC_UPDATE = requireAbac(
  "onboarding.update",
  "onboarding_task_assignee_or_owner",
) as PreHandler;
const ABAC_ORG_ADMIN = requireAbac("onboarding.manage_own", "tenant_org_admin_role") as PreHandler;
const ABAC_OFFICER = requireAbac("go_live.attest", "tenant_compliance_officer_role") as PreHandler;

// §6/D10 step-up on the decisions that decide who may take the tenant live.
const STEP_UP_OFFICER = requireStepUp("onboarding.manage_own") as PreHandler;
const STEP_UP_GO_LIVE = requireStepUp("go_live.attest") as PreHandler;

// Every state change a tenant makes to its onboarding (start, block, attest, re-open, assignment) is a human act.
const NO_AI = rejectAiActor(
  "AI principals cannot change a tenant's onboarding or go-live",
) as PreHandler;

export function registerOnboardingRoutes(app: FastifyInstance, deps: OnboardingRouteDeps): void {
  const { wizard } = deps;

  // The ordered wizard: steps (lock state, owner, mode, evidence, who/when), the current step, the go-live state and the
  // org profile. The whole catalog is a dozen rows, so there is no cursor; `items` is the older name of `steps`.
  // The read is audited like the platform one (a list read of onboarding_task), and carries no ChartWarden operator's id.
  app.get(
    "/api/v1/tenant/onboarding",
    { preHandler: [READ], config: { auditRead: { resourceKind: "onboarding_task", list: true } } },
    async (request) => {
      const { organizationId } = actorOf(request);
      parse(OnboardingListQuerySchema, request.query);
      const view = await wizard.getTenant(organizationId);
      return { ...view, items: view.steps, nextCursor: null, hasMore: false };
    },
  );

  // pending/blocked -> in_progress; refused out of sequence or by a non-owner.
  app.post(
    "/api/v1/tenant/onboarding/:taskId/start",
    { preHandler: [UPDATE, ABAC_UPDATE, NO_AI] },
    async (request) => {
      const actor = actorOf(request);
      const { taskId } = parse(OnboardingTaskParamsSchema, request.params);
      parse(OnboardingStartRequest, request.body);
      return wizard.startTask(tenantActor(actor), actor.organizationId, taskId);
    },
  );

  // Mark a step done with evidence (human actor, owner role, in sequence). `evidenceNote` is required (422 otherwise).
  app.post(
    "/api/v1/tenant/onboarding/:taskId/attest",
    { preHandler: [UPDATE, ABAC_UPDATE, NO_AI] },
    async (request) => {
      const actor = actorOf(request);
      const { taskId } = parse(OnboardingTaskParamsSchema, request.params);
      const body = parse(TenantAttestStepRequest, request.body);
      return wizard.attestTask(tenantActor(actor), actor.organizationId, taskId, body);
    },
  );

  // DEPRECATED alias of /attest (the first build's route, kept so existing clients do not break). The schema keeps every
  // field optional; the service requires `evidenceNote`.
  app.post(
    "/api/v1/tenant/onboarding/:taskId/complete",
    { preHandler: [UPDATE, ABAC_UPDATE, NO_AI] },
    async (request) => {
      const actor = actorOf(request);
      const { taskId } = parse(OnboardingTaskParamsSchema, request.params);
      const body = parse(TenantCompleteStepRequest, request.body);
      return wizard.attestTask(tenantActor(actor), actor.organizationId, taskId, body);
    },
  );

  // Re-open a done or skipped step so it can be edited (later steps keep their state; see the service).
  app.post(
    "/api/v1/tenant/onboarding/:taskId/reopen",
    { preHandler: [UPDATE, ABAC_UPDATE, NO_AI] },
    async (request) => {
      const actor = actorOf(request);
      const { taskId } = parse(OnboardingTaskParamsSchema, request.params);
      const body = parse(TenantReopenStepRequest, request.body);
      return wizard.reopenTask(tenantActor(actor), actor.organizationId, taskId, body.reason);
    },
  );

  // pending/in_progress -> blocked with a reason.
  app.post(
    "/api/v1/tenant/onboarding/:taskId/block",
    { preHandler: [UPDATE, ABAC_UPDATE, NO_AI] },
    async (request) => {
      const actor = actorOf(request);
      const { taskId } = parse(OnboardingTaskParamsSchema, request.params);
      const body = parse(OnboardingBlockRequest, request.body);
      return wizard.blockTask(tenantActor(actor), actor.organizationId, taskId, body.blockerReason);
    },
  );

  // The org's display name and IANA time zone (org_admin, during onboarding).
  app.patch(
    "/api/v1/tenant/org-profile",
    { preHandler: [MANAGE_OWN, ABAC_ORG_ADMIN, NO_AI] },
    async (request) => {
      const actor = actorOf(request);
      return wizard.setOrgProfile(
        tenantActor(actor),
        actor.organizationId,
        parse(OrgProfileRequest, request.body),
      );
    },
  );

  // Assign the compliance officer (an active member of this org) who will attest go-live readiness.
  app.put(
    "/api/v1/tenant/compliance-officer",
    { preHandler: [MANAGE_OWN, ABAC_ORG_ADMIN, STEP_UP_OFFICER, NO_AI] },
    async (request) => {
      const actor = actorOf(request);
      const body = parse(SetComplianceOfficerRequest, request.body);
      return wizard.setComplianceOfficer(
        tenantActor(actor),
        actor.organizationId,
        body.membershipId,
      );
    },
  );

  // The compliance officer attests go-live readiness; a platform operator then approves (first party of two).
  app.post(
    "/api/v1/tenant/go-live/attest",
    { preHandler: [GO_LIVE_ATTEST, ABAC_OFFICER, STEP_UP_GO_LIVE, NO_AI] },
    async (request) => {
      const actor = actorOf(request);
      const body = parse(GoLiveAttestRequest, request.body);
      return wizard.attestGoLive(tenantActor(actor), actor.organizationId, body.note);
    },
  );
}

function tenantActor(actor: ReturnType<typeof actorOf>) {
  return {
    kind: "tenant" as const,
    membershipId: actor.membershipId,
    userId: actor.userId,
    roles: actor.roles,
  };
}
