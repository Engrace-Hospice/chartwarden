// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/key-ring.ts — M34 (§4.1 / §3.5).
//
// The platform-ops per-tenant key-ring routes (§4.1 platform-ops table): the §3.5 METADATA-ONLY read
// (over `tenant_key_ring_metadata_v` — the DEK ciphertext is NEVER exposed) + the manual DEK-rotate
// request (enqueues `tenant.dek_rotate`, step-up). The dek-rotate route is ALSO defined on tenants.ts
// (the `:orgSlug/dek-rotate` lifecycle command); this file owns the §3.5 key-ring metadata read screen.
// Gated by the §4.5 keys + `tenant_lifecycle_platform_ops` ABAC; reads run under `withPlatformContext`
// (F03/F09, audited) in prod. Mirrors the M22 route-plugin shape.
import { requireAbac, requirePermission } from "@chartwarden/auth";
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { OrgSlugParamsSchema, parse } from "./platform-typebox";
import type { TenantPlatformRouteService } from "./service";

/** A @chartwarden/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface TenantKeyRingRouteDeps {
  service: TenantPlatformRouteService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

// §4.1 — the key-ring metadata read reuses the `tenant.read_platform` key (metadata view only). §4.5/§4.6.
const READ = requirePermission("tenant.read_platform") as PreHandler;
const ABAC_READ = requireAbac(
  "tenant.read_platform",
  "tenant_lifecycle_platform_ops",
) as PreHandler;

/** Register the §4.1 / §3.5 platform-ops key-ring metadata route. */
export function registerTenantKeyRingRoutes(
  app: FastifyInstance,
  deps: TenantKeyRingRouteDeps,
): void {
  const { service } = deps;

  // 1 — read key-ring METADATA only (ciphertext never exposed; `tenant_key_ring_metadata_v`). §4.1/§3.5.
  app.get(
    "/api/v1/platform/tenants/:orgSlug/key-ring",
    { preHandler: [READ, ABAC_READ] },
    async (request) => {
      actorOf(request);
      const { orgSlug } = parse(OrgSlugParamsSchema, request.params);
      return service.getKeyRingMetadata(orgSlug);
    },
  );
}
