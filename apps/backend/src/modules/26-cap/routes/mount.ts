// apps/backend/src/modules/26-cap/routes/mount.ts — M26 route mount (§4.1) + plugin barrel.
//
// The four §4.1 route plugins (cap operational/lifecycle · psr · settlement · platform). `mountM26Routes`
// is the single composition-root entry (the M25/M27 mount precedent), mounted behind the same
// authenticate/security/error chain as every other module. Every route already gates on its §4.6
// requirePermission key; the lifecycle/settlement mutations compose the §4.7 ABAC + §D12 step-up; every
// mutating route declares Idempotency-Key (§F08).
import type { FastifyInstance } from "fastify";
import { registerCapRoutes } from "./cap.routes";
import type { M26RouteServices } from "./index";
import { registerPlatformRoutes } from "./platform.routes";
import { registerPsrRoutes } from "./psr.routes";
import { registerSettlementRoutes } from "./settlement.routes";

export { registerCapRoutes, type CapRouteDeps } from "./cap.routes";
export { registerPsrRoutes, type PsrRouteDeps } from "./psr.routes";
export { registerSettlementRoutes, type SettlementRouteDeps } from "./settlement.routes";
export { registerPlatformRoutes, type PlatformRouteDeps } from "./platform.routes";

/** Mount every M26 §4.1 route plugin over the Drizzle-backed (or in-memory) read + write services. */
export function mountM26Routes(app: FastifyInstance, services: M26RouteServices): void {
  const { readService, writeService } = services;
  registerCapRoutes(app, { readService, writeService });
  registerPsrRoutes(app, { readService, writeService });
  registerSettlementRoutes(app, { readService, writeService });
  registerPlatformRoutes(app, { readService, writeService });
}
