// apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/index.ts — M34 tenant-route barrel.
//
// Aggregates the five TENANT-scoped route groups (§4.1 "Tenant-scoped routes", `withOrgContext` — the
// tenant's own org, M2 `staff` session class) into one `registerTenantTenantRoutes` Fastify plugin the
// composition root mounts (the M22 `registerDocumentRoutes` precedent — one register call per surface).
// Each group composes over the SAME injected TenantRouteService (in-memory slice in tests; Drizzle-backed
// under `withOrgContext` in prod so RLS scopes by `app.org_id`). The PLATFORM-scoped routes
// (`withPlatformContext`) are a sibling surface (routes/platform/*) wired separately.
import type { FastifyInstance } from "fastify";
import { registerTenantBaaRoutes } from "./baa";
import { registerDsarExportRoutes } from "./dsar-export-jobs";
import { registerOnboardingRoutes } from "./onboarding-tasks";
import type { TenantRouteService } from "./service";
import { registerSupportConsentGrantRoutes } from "./support-consent-grants";
import { registerTenantExportRoutes } from "./tenant-export-jobs";

export interface TenantRoutesDeps {
  service: TenantRouteService;
}

/** Mount all five tenant-scoped M34 route groups behind the REAL Authorization Contract (§4.1 / §6). */
export function registerTenantTenantRoutes(app: FastifyInstance, deps: TenantRoutesDeps): void {
  registerSupportConsentGrantRoutes(app, deps);
  registerDsarExportRoutes(app, deps);
  registerTenantExportRoutes(app, deps);
  registerOnboardingRoutes(app, deps);
  registerTenantBaaRoutes(app, deps);
}

export {
  type SupportConsentGrantRouteDeps,
  registerSupportConsentGrantRoutes,
} from "./support-consent-grants";
export { type DsarExportRouteDeps, registerDsarExportRoutes } from "./dsar-export-jobs";
export { type TenantExportRouteDeps, registerTenantExportRoutes } from "./tenant-export-jobs";
export { type OnboardingRouteDeps, registerOnboardingRoutes } from "./onboarding-tasks";
export { type BaaRouteDeps, registerTenantBaaRoutes } from "./baa";
export {
  type EnqueuePort,
  type M34TenantQueueName,
  type TenantBackendInspect,
  type TenantRouteSeed,
  type TenantRouteService,
  createInMemoryTenantBackend,
} from "./service";
