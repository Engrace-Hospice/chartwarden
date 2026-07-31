// apps/backend/src/modules/21-supplies/routes/mount.ts — M21 route mount (§4.1) + plugin barrel.
//
// The four §4.1 route plugins (supply requests · D11 catalog + §2.3 templates · comfort-kit custody ·
// agency operations). `mountM21Routes` is the single composition-root entry (the M15/M16/M24/M26 mount
// precedent), mounted behind the same authenticate / security / error chain as every other module. Every
// route gates on its §4.3 `requirePermission` key plus its §4.4 ABAC binding; the three
// controlled-substance signatures add the step-up gate; every mutation declares `Idempotency-Key`
// (ADR-0021) and every state transition requires `If-Match` (§7.2).
import type { FastifyInstance } from "fastify";
import { registerSupplyCatalogRoutes } from "./catalog.routes";
import { registerComfortKitRoutes } from "./comfort-kits.routes";
import type { M21RouteServices } from "./index";
import { registerSupplyOperationsRoutes } from "./operations.routes";
import { registerSupplyRequestRoutes } from "./supply-requests.routes";

export { registerSupplyRequestRoutes, type SupplyRequestRouteDeps } from "./supply-requests.routes";
export { registerSupplyCatalogRoutes, type CatalogRouteDeps } from "./catalog.routes";
export { registerComfortKitRoutes, type ComfortKitRouteDeps } from "./comfort-kits.routes";
export { registerSupplyOperationsRoutes, type OperationsRouteDeps } from "./operations.routes";

/** Mount every M21 §4.1 route plugin over the Drizzle-backed (or in-memory) read + write services. */
export function mountM21Routes(app: FastifyInstance, services: M21RouteServices): void {
  const { readService, writeService } = services;
  registerSupplyRequestRoutes(app, { readService, writeService });
  registerSupplyCatalogRoutes(app, { readService, writeService });
  registerComfortKitRoutes(app, { readService, writeService });
  registerSupplyOperationsRoutes(app, { readService, writeService });
}
