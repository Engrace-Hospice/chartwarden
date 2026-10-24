// apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/account-flags-routes.ts - M34 GAP-164 (§4.1).
//
// GET /tenant/account (tenant.read_own), GET /tenant/feature-flags (feature_flag.read_own) and
// POST /tenant/feature-flags/:flagKey (feature_flag.write_tenant + `feature_flag_write_authority` + step-up).
// The write's ABAC target is built SERVER-SIDE from the verified session org: `organizationId` is the actor's
// own org, never a body field, so an org_admin can only reach a flag row scoped to its own tenant.
import {
  type GuardRequest,
  requireAbac,
  requirePermission,
  requireStepUp,
} from "@chartwarden/auth";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { TenantFlagWriteRequest } from "../typebox";
import type { TenantAccountFlagsService } from "./account-flags-service";
import { actorOf } from "./actor";
import { parse } from "./tenant-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface TenantAccountFlagsRouteDeps {
  readonly service: TenantAccountFlagsService;
}

export const TenantFlagKeyParamsSchema = Type.Object({
  flagKey: Type.String({ minLength: 1, maxLength: 128 }),
});

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

const ownScopeTarget = (request: GuardRequest): Record<string, unknown> => {
  const p = request.params as { flagKey?: unknown } | undefined;
  const ctx = (request as unknown as { context?: { organizationId?: string } }).context;
  return { flagKey: p?.flagKey, organizationId: ctx?.organizationId ?? null };
};

export function registerTenantAccountFlagsRoutes(
  app: FastifyInstance,
  deps: TenantAccountFlagsRouteDeps,
): void {
  const { service } = deps;

  app.get(
    "/api/v1/tenant/account",
    {
      preHandler: [P("tenant.read_own")],
      config: { auditRead: { resourceKind: "tenant_account" } },
    },
    async (request) => service.getAccount(actorOf(request).organizationId),
  );

  app.get(
    "/api/v1/tenant/feature-flags",
    { preHandler: [P("feature_flag.read_own")] },
    async (request) => ({ items: await service.listFlags(actorOf(request).organizationId) }),
  );

  app.post(
    "/api/v1/tenant/feature-flags/:flagKey",
    {
      preHandler: [
        P("feature_flag.write_tenant"),
        requireAbac("feature_flag.write_tenant", "feature_flag_write_authority", {
          getTarget: ownScopeTarget,
        }) as PreHandler,
        requireStepUp("feature_flag.write_tenant") as PreHandler,
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const { flagKey } = parse(TenantFlagKeyParamsSchema, request.params);
      const body = parse(TenantFlagWriteRequest, request.body);
      return service.writeFlag(actor.organizationId, actor.userId, flagKey, body.enabled);
    },
  );
}
