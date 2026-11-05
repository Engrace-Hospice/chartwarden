// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-wizard-routes.ts — M34 onboarding wizard v2.
//
// The PLATFORM-OPS side of the wizard (§4.1; `withPlatformContext`, audited). Every route is gated by a §4.5 permission key
// AND the `tenant_lifecycle_platform_ops` ABAC predicate (the `platform_ops` role). Every WRITE additionally needs a fresh
// step-up (§6/D10) and refuses an AI principal: the platform decisions here (attest a step, skip, re-open, assign the
// compliance officer, approve or revoke a go-live) are human acts. The strict sequence, evidence and two-party rules are
// enforced in the service (onboarding/wizard-service.ts), not here.
//   GET   /platform/tenants/:orgSlug/onboarding                       read the ordered wizard (+ go-live + org profile)
//   POST  .../onboarding/:taskId/skip | attest | reopen              settle or re-open a step
//   PATCH /platform/tenants/:orgSlug/org-profile                     display name + IANA time zone
//   PUT   /platform/tenants/:orgSlug/compliance-officer              assign the officer who attests go-live (a reason is required)
//   POST  /platform/tenants/:orgSlug/go-live/approve | revoke        the second party of the two-party go-live
import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";
import { UnauthorizedError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { rejectAiActor } from "../../../../bootstrap/reject-ai-actor";
import type { PlatformActor } from "../../onboarding/model";
import type { OnboardingWizard } from "../../onboarding/wizard-service";
import {
  OrgProfileRequest,
  PlatformAttestStepRequest,
  PlatformReasonRequest,
  SetComplianceOfficerPlatformRequest,
} from "../onboarding-wizard-typebox";
import { SkipOnboardingTaskRequest } from "../typebox";
import { OrgSlugParamsSchema, parse } from "./platform-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface OnboardingWizardRouteDeps {
  readonly wizard: OnboardingWizard;
}

const TaskParamsSchema = Type.Object({
  orgSlug: Type.String({ minLength: 1, maxLength: 128 }),
  taskId: Type.String({ format: "uuid" }),
});

function actorOf(request: FastifyRequest): PlatformActor {
  const ctx = request.context;
  const membershipId = ctx?.attributes?.membershipId;
  if (!ctx?.organizationId || !ctx.userId || typeof membershipId !== "string") {
    throw new UnauthorizedError();
  }
  return { kind: "platform", userId: ctx.userId, membershipId };
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const OPS = (key: string): PreHandler =>
  requireAbac(key, "tenant_lifecycle_platform_ops") as PreHandler;
const NO_AI = rejectAiActor(
  "AI principals cannot change a tenant's onboarding or go-live",
) as PreHandler;
/** The guard chain of a platform write: permission, platform_ops ABAC, fresh step-up, human actor. */
const WRITE = (key: string): PreHandler[] => [
  P(key),
  OPS(key),
  requireStepUp(key) as PreHandler,
  NO_AI,
];

const MANAGE = "onboarding.manage_platform";
const APPROVE = "go_live.approve_platform";

export function registerOnboardingWizardRoutes(
  app: FastifyInstance,
  deps: OnboardingWizardRouteDeps,
): void {
  const { wizard } = deps;

  app.get(
    "/api/v1/platform/tenants/:orgSlug/onboarding",
    {
      preHandler: [P("onboarding.read_platform"), OPS("onboarding.read_platform")],
      config: { auditRead: { resourceKind: "onboarding_task", list: true } },
    },
    async (request) => {
      actorOf(request);
      const view = await wizard.getPlatform(parse(OrgSlugParamsSchema, request.params).orgSlug);
      return { ...view, currentStep: view.currentStepKey, tasks: view.steps };
    },
  );

  app.post(
    "/api/v1/platform/tenants/:orgSlug/onboarding/:taskId/skip",
    { preHandler: WRITE("onboarding.skip") },
    async (request) => {
      const actor = actorOf(request);
      const { orgSlug, taskId } = parse(TaskParamsSchema, request.params);
      const body = parse(SkipOnboardingTaskRequest, request.body);
      return wizard.skipPlatform(orgSlug, taskId, actor, body.skipRationale);
    },
  );

  app.post(
    "/api/v1/platform/tenants/:orgSlug/onboarding/:taskId/attest",
    { preHandler: WRITE(MANAGE) },
    async (request) => {
      const actor = actorOf(request);
      const { orgSlug, taskId } = parse(TaskParamsSchema, request.params);
      return wizard.attestPlatform(
        orgSlug,
        taskId,
        actor,
        parse(PlatformAttestStepRequest, request.body),
      );
    },
  );

  app.post(
    "/api/v1/platform/tenants/:orgSlug/onboarding/:taskId/reopen",
    { preHandler: WRITE(MANAGE) },
    async (request) => {
      const actor = actorOf(request);
      const { orgSlug, taskId } = parse(TaskParamsSchema, request.params);
      const body = parse(PlatformReasonRequest, request.body);
      return wizard.reopenPlatform(orgSlug, taskId, actor, body.reason);
    },
  );

  app.patch(
    "/api/v1/platform/tenants/:orgSlug/org-profile",
    { preHandler: WRITE(MANAGE) },
    async (request) => {
      const actor = actorOf(request);
      const { orgSlug } = parse(OrgSlugParamsSchema, request.params);
      return wizard.setOrgProfilePlatform(orgSlug, actor, parse(OrgProfileRequest, request.body));
    },
  );

  app.put(
    "/api/v1/platform/tenants/:orgSlug/compliance-officer",
    { preHandler: WRITE(MANAGE) },
    async (request) => {
      const actor = actorOf(request);
      const { orgSlug } = parse(OrgSlugParamsSchema, request.params);
      const body = parse(SetComplianceOfficerPlatformRequest, request.body);
      return wizard.setComplianceOfficerPlatform(orgSlug, actor, body.membershipId, body.reason);
    },
  );

  app.post(
    "/api/v1/platform/tenants/:orgSlug/go-live/approve",
    { preHandler: WRITE(APPROVE) },
    async (request) => {
      const actor = actorOf(request);
      const { orgSlug } = parse(OrgSlugParamsSchema, request.params);
      return wizard.approveGoLive(
        orgSlug,
        actor,
        parse(PlatformReasonRequest, request.body).reason,
      );
    },
  );

  app.post(
    "/api/v1/platform/tenants/:orgSlug/go-live/revoke",
    { preHandler: WRITE(APPROVE) },
    async (request) => {
      const actor = actorOf(request);
      const { orgSlug } = parse(OrgSlugParamsSchema, request.params);
      return wizard.revokeGoLive(orgSlug, actor, parse(PlatformReasonRequest, request.body).reason);
    },
  );
}
