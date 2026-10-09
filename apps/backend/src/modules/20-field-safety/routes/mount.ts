// apps/backend/src/modules/20-field-safety/routes/mount.ts — M20 route mount (§4.1) + plugin barrel.
//
// The four §4.1 route plugins (check-ins · the SOS spine · incidents + the D9 sign-off · the three
// configuration surfaces + the board and consent). `mountM20Routes` is the single composition-root entry
// (the M15/M16/M19/M21/M24/M26 mount precedent), mounted behind the same authenticate / security / error
// chain as every other module.
//
// Every route gates on its §4.6 `requirePermission` key plus its §4.7 ABAC binding; the TWO §4.1 step-up
// operations (the OSHA sign-off and the policy PATCH) add `requireStepUp`; every mutation declares
// `Idempotency-Key` (ADR-0021) EXCEPT the SOS press, which §4.1's own Idempotent column marks `no` and
// §2.6 / M20-F10 explain — every press is a separate call for help.
import type { FastifyInstance } from "fastify";
import { registerAdminRoutes } from "./admin.routes";
import { registerCheckInRoutes } from "./check-ins.routes";
import { registerDashboardRoutes } from "./dashboard.routes";
import { registerIncidentRoutes } from "./incidents.routes";
import type { M20RouteServices } from "./index";
import { registerSosRoutes } from "./sos.routes";
import { registerTerminusRoutes } from "./terminus.routes";

export { registerCheckInRoutes, type CheckInRouteDeps } from "./check-ins.routes";
export { registerSosRoutes, type SosRouteDeps } from "./sos.routes";
export { registerIncidentRoutes, type IncidentRouteDeps } from "./incidents.routes";
export { registerAdminRoutes, type AdminRouteDeps } from "./admin.routes";
export { registerDashboardRoutes, type DashboardRouteDeps } from "./dashboard.routes";
export { registerTerminusRoutes, type TerminusRouteDeps } from "./terminus.routes";

/** Mount every M20 §4.1 route plugin over the Drizzle-backed READ + WRITE services. */
export function mountM20Routes(app: FastifyInstance, services: M20RouteServices): void {
  const { readService, writeService } = services;
  registerCheckInRoutes(app, { readService, writeService });
  registerSosRoutes(app, { readService, writeService });
  registerIncidentRoutes(app, { readService, writeService });
  registerAdminRoutes(app, { readService, writeService });
  registerDashboardRoutes(app, { readService, writeService });
  if (services.terminus) registerTerminusRoutes(app, services.terminus);
}
