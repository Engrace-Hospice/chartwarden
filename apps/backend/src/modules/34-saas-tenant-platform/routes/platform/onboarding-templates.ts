// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-templates.ts — M34 (§4.1).
//
// The platform-ops onboarding-template catalog routes (§4.1 platform-ops table): list the platform-seed
// catalog (the data-driven onboarding step floor, SD-036 pattern-2) + add/edit a NON-canonical template
// (canonical=true is migration-only — the route refuses to set it). Gated by the §4.5 keys + the
// `tenant_lifecycle_platform_ops` ABAC predicate; the write route additionally requires §6 step-up.
// The catalog is platform-shared/org-less, so reads run under `withPlatformContext` (F03/F09, audited)
// in prod. Mirrors the M22 route-plugin shape.
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  OnboardingTemplateListQuerySchema,
  UpsertOnboardingTemplateRequest,
  parse,
} from "./platform-typebox";
import type { TenantPlatformRouteService } from "./service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface OnboardingTemplateRouteDeps {
  service: TenantPlatformRouteService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

// §4.5 permission + §4.6 ABAC (`tenant_lifecycle_platform_ops`) + §6 step-up (write only).
const LIST = requirePermission("onboarding_template.list") as PreHandler;
const WRITE = requirePermission("onboarding_template.write") as PreHandler;
const ABAC_LIST = requireAbac(
  "onboarding_template.list",
  "tenant_lifecycle_platform_ops",
) as PreHandler;
const ABAC_WRITE = requireAbac(
  "onboarding_template.write",
  "tenant_lifecycle_platform_ops",
) as PreHandler;
const STEPUP_WRITE = requireStepUp("onboarding_template.write") as PreHandler;

/** Register the §4.1 platform-ops onboarding-template catalog routes. */
export function registerOnboardingTemplateRoutes(
  app: FastifyInstance,
  deps: OnboardingTemplateRouteDeps,
): void {
  const { service } = deps;

  // 1 — list the platform-seed onboarding-template catalog (cursor-paginated). §4.1.
  app.get(
    "/api/v1/platform/onboarding-templates",
    { preHandler: [LIST, ABAC_LIST] },
    async (request) => {
      actorOf(request);
      const q = parse(OnboardingTemplateListQuerySchema, request.query);
      return service.listOnboardingTemplates(q.cursor, q.limit);
    },
  );

  // 2 — add/edit a NON-canonical template (step-up; canonical=true is migration-only). §4.1.
  app.post(
    "/api/v1/platform/onboarding-templates",
    { preHandler: [WRITE, ABAC_WRITE, STEPUP_WRITE] },
    async (request, reply) => {
      const { userId } = actorOf(request);
      const body = parse(UpsertOnboardingTemplateRequest, request.body);
      const res = await service.upsertOnboardingTemplate(userId, {
        key: body.key,
        title: body.title,
        description: body.description ?? null,
        canonicalOrder: body.canonicalOrder,
        isCanonical: body.isCanonical ?? false,
      });
      return reply.code(201).send(res);
    },
  );
}
