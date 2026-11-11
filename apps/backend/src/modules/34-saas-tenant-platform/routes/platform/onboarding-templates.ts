import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";
// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-templates.ts — M34 (§4.1).
//
// The platform-ops onboarding-template catalog routes (§4.1 platform-ops table): list the platform-seed
// catalog (the data-driven onboarding step floor, SD-036 pattern-2) + add/edit a NON-canonical template
// (canonical=true is migration-only — the route refuses to set it). Gated by the §4.5 keys + the
// `tenant_lifecycle_platform_ops` ABAC predicate; the write route additionally requires §6 step-up.
// The catalog is platform-shared/org-less, so reads run under `withPlatformContext` (F03/F09, audited)
// in prod. Mirrors the M22 route-plugin shape.
import {
  type PreHandler,
  actorOf,
  rejectAiActor,
  requireIdempotencyKey,
  writeActorOf,
} from "@chartwarden/shared/route-kit";
import type { FastifyInstance } from "fastify";
import { screenFreeText, screenNames } from "../free-text";
import { splitReason } from "./onboarding-data-typebox";
import {
  OnboardingTemplateListQuerySchema,
  UpsertOnboardingTemplateRequest,
  parse,
} from "./platform-typebox";
import type { TenantPlatformRouteService } from "./service";

export interface OnboardingTemplateRouteDeps {
  service: TenantPlatformRouteService;
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
/**
 * The catalog is shown in every tenant's wizard, so a change is a named operator's decision like every other ops write: a fresh step-up,
 * no AI principal, and an Idempotency-Key (a retry replays, it does not write twice).
 */
const WRITE_GUARDS: PreHandler[] = [
  WRITE,
  ABAC_WRITE,
  STEPUP_WRITE,
  rejectAiActor("AI principals cannot change the onboarding-step catalog") as PreHandler,
  requireIdempotencyKey() as PreHandler,
];

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

  // 2 — add/edit a NON-canonical template (step-up, a reason, an Idempotency-Key, no AI principal; canonical=true is migration-only).
  // The operator is named on the audit row and on the row-level audit trail. §4.1.
  app.post(
    "/api/v1/platform/onboarding-templates",
    { preHandler: WRITE_GUARDS },
    async (request, reply) => {
      const operator = writeActorOf(request);
      const { reason, fields } = splitReason(parse(UpsertOnboardingTemplateRequest, request.body));
      screenFreeText({ description: fields.description });
      screenNames({ title: fields.title });
      const res = await service.upsertOnboardingTemplate(operator.userId, {
        key: fields.key,
        title: fields.title,
        description: fields.description ?? null,
        canonicalOrder: fields.canonicalOrder,
        isCanonical: fields.isCanonical ?? false,
        reason,
        operatorMembershipId: operator.membershipId,
      });
      return reply.code(201).send(res);
    },
  );
}
