import { Type } from "@sinclair/typebox";
// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/ops-routes.ts - M34 GAP-164 (§4.1).
//
// Three platform-ops routes, all gated by the §4.5 permission key AND the `tenant_lifecycle_platform_ops`
// ABAC predicate (the spec's route-table scope). The skip route additionally requires a fresh M2 step-up
// (§6 / D10) and carries a recorded rationale; idempotency rides the M1 `Idempotency-Key` middleware.
// Every read is `auditRead`-declared (the cross-tenant platform-bypass anchor, F09).
import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SkipOnboardingTaskRequest } from "../typebox";
import type { PlatformOpsService } from "./ops-service";
import { OrgSlugParamsSchema, parse } from "./platform-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface PlatformOpsRouteDeps {
  readonly service: PlatformOpsService;
}

export const PlatformDsarListQuerySchema = Type.Object({
  status: Type.Optional(
    Type.Union([
      Type.Literal("requested"),
      Type.Literal("generating"),
      Type.Literal("review_pending"),
      Type.Literal("extended"),
      Type.Literal("fulfilled"),
      Type.Literal("denied"),
    ]),
  ),
  organizationId: Type.Optional(Type.String({ format: "uuid" })),
  slaBreached: Type.Optional(Type.Boolean()),
  cursor: Type.Optional(Type.String({ maxLength: 256 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const OnboardingTaskIdParamsSchema = Type.Object({
  orgSlug: Type.String({ minLength: 1, maxLength: 128 }),
  taskId: Type.String({ format: "uuid" }),
});

function actorOf(request: FastifyRequest): { userId: string; membershipId: string } {
  const ctx = request.context;
  const membershipId = ctx?.attributes?.membershipId;
  if (!ctx?.organizationId || !ctx.userId || typeof membershipId !== "string") {
    throw new UnauthorizedError();
  }
  return { userId: ctx.userId, membershipId };
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const OPS = (key: string): PreHandler =>
  requireAbac(key, "tenant_lifecycle_platform_ops") as PreHandler;

export function registerPlatformOpsRoutes(app: FastifyInstance, deps: PlatformOpsRouteDeps): void {
  const { service } = deps;

  // Cross-tenant DSAR list with SLA filtering (PHI-minimal projection; no patient id).
  app.get(
    "/api/v1/platform/dsar-export-jobs",
    {
      preHandler: [P("dsar_export.list_platform"), OPS("dsar_export.list_platform")],
      config: { auditRead: { resourceKind: "dsar_export_job", list: true } },
    },
    async (request) => {
      actorOf(request);
      const q = parse(PlatformDsarListQuerySchema, request.query);
      return service.listDsarJobs(
        { status: q.status, organizationId: q.organizationId, slaBreached: q.slaBreached },
        q.cursor,
        q.limit,
      );
    },
  );

  // A tenant's full onboarding task list + the machine's current step.
  app.get(
    "/api/v1/platform/tenants/:orgSlug/onboarding",
    {
      preHandler: [P("onboarding.read_platform"), OPS("onboarding.read_platform")],
      config: { auditRead: { resourceKind: "onboarding_task", list: true } },
    },
    async (request) => {
      actorOf(request);
      return service.getOnboarding(parse(OrgSlugParamsSchema, request.params).orgSlug);
    },
  );

  // Platform-ops skip with a required rationale (step-up).
  app.post(
    "/api/v1/platform/tenants/:orgSlug/onboarding/:taskId/skip",
    {
      preHandler: [
        P("onboarding.skip"),
        OPS("onboarding.skip"),
        requireStepUp("onboarding.skip") as PreHandler,
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const { orgSlug, taskId } = parse(OnboardingTaskIdParamsSchema, request.params);
      const body = parse(SkipOnboardingTaskRequest, request.body);
      return service.skipOnboardingTask(orgSlug, taskId, actor, body.skipRationale);
    },
  );
}
