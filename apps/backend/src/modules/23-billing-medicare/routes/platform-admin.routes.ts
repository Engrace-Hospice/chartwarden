// apps/backend/src/modules/23-billing-medicare/routes/platform-admin.routes.ts — M23 (§4.1 #41 / #42) the
// platform-only admin surface (GAP-144). Both routes gate on `billing.rule_config.platform_admin` (the platform
// administrator's key — a tenant org_admin never holds it) PLUS the §D14 step-up assertion, the §D13 AI-block
// and `Idempotency-Key`. NO PHI. See `platform-admin-service.ts` for what each command does and does not do.
import type { FastifyInstance } from "fastify";
import { rejectAiActor, writeActorOf } from "./actor";
import { parse } from "./billing-typebox";
import { requireIdempotencyKey } from "./concurrency";
import { P, STEP_UP } from "./guards";
import type { PlatformAdminRouteService } from "./platform-admin-service";
import {
  LoadWageIndexesBodySchema,
  RegisterPlatformRuleBodySchema,
} from "./platform-admin-typebox";

export interface PlatformAdminRouteDeps {
  readonly platformAdminService: PlatformAdminRouteService;
}

const PLATFORM_ADMIN = P("billing.rule_config.platform_admin");
const PLATFORM_STEPUP = STEP_UP("billing.rule_config.platform_admin");
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();

export function registerPlatformAdminRoutes(
  app: FastifyInstance,
  deps: PlatformAdminRouteDeps,
): void {
  const { platformAdminService } = deps;

  // POST /admin/billing/platform-rules — register a platform validation rule (with the regulatory-required tag). #41.
  app.post(
    "/api/v1/admin/billing/platform-rules",
    { preHandler: [PLATFORM_ADMIN, PLATFORM_STEPUP, NO_AI, IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const body = parse(RegisterPlatformRuleBodySchema, request.body);
      return platformAdminService.registerPlatformRule(actor, body);
    },
  );

  // POST /admin/billing/wage-indexes/load — load the annual CMS wage-index file into the platform table. #42.
  app.post(
    "/api/v1/admin/billing/wage-indexes/load",
    { preHandler: [PLATFORM_ADMIN, PLATFORM_STEPUP, NO_AI, IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const body = parse(LoadWageIndexesBodySchema, request.body);
      return platformAdminService.loadWageIndexes(actor, body);
    },
  );
}
