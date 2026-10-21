// apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/baa.ts — M34 §4.1.
//
// The TENANT-scoped platform-tenant BAA routes (`withOrgContext` — the tenant's own org). The platform →
// tenant Business Associate Agreement register (D11) — DISTINCT from M40's tenant → external BAA register
// ("WardenX has a BAA with this tenant", with executed/effective/expiry dates, addendum versions, breach
// contacts, and the compliance-officer attestation). The tenant sees its OWN BAA history (read) and a
// compliance_officer attests (write). Routes gate on the §4.5 keys + the §4.6 ABAC predicate
// `tenant_platform_baa_compliance_officer` on ATTEST (actor holds the tenant's compliance_officer role);
// ATTEST carries `passkey_recent_5min` step-up (§6/D10). The BAA register read surface is auditRead-declared
// in the Drizzle service. Mirrors registerDocumentRoutes EXACTLY.
import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf } from "./actor";
import type { TenantRouteService } from "./service";
import { BaaAttestRequest, BaaListQuerySchema, BaaParamsSchema, parse } from "./tenant-typebox";

export interface BaaRouteDeps {
  service: TenantRouteService;
}

// §4.5 permission guards.
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("platform_tenant_baa.read_own");
const ATTEST = P("platform_tenant_baa.attest");

// §4.6 ABAC — actor holds the tenant's compliance_officer role.
const ABAC_ATTEST = requireAbac(
  "platform_tenant_baa.attest",
  "tenant_platform_baa_compliance_officer",
) as PreHandler;

// §6/D10 step-up — attestation is `passkey_recent_5min`.
const STEP_UP_ATTEST = requireStepUp("platform_tenant_baa.attest") as PreHandler;

export function registerTenantBaaRoutes(app: FastifyInstance, deps: BaaRouteDeps): void {
  const { service } = deps;

  // the tenant's BAA history (cursor-paginated) (§4.1).
  app.get("/api/v1/tenant/baa", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const q = parse(BaaListQuerySchema, request.query);
    return service.listBaa(organizationId, q.cursor, q.limit);
  });

  // compliance-officer attestation — step-up (§4.1 / §6).
  app.post(
    "/api/v1/tenant/baa/:id/attest",
    { preHandler: [ATTEST, ABAC_ATTEST, STEP_UP_ATTEST] },
    async (request) => {
      const { organizationId, membershipId } = actorOf(request);
      const { id } = parse(BaaParamsSchema, request.params);
      parse(BaaAttestRequest, request.body);
      return service.attestBaa(organizationId, id, membershipId);
    },
  );
}
