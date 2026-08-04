// apps/backend/src/modules/16-bereavement/routes/mount.ts — M16 route mount (§4.1) + plugin barrel.
//
// The four §4.1 route plugins (plans/lifecycle/risk · bereaved contacts · touchpoints · dashboards).
// `mountM16Routes` is the single composition-root entry (the M15/M24/M25/M26 mount precedent), mounted
// behind the same authenticate / security / error chain as every other module. Every route gates on its
// §4.7 `requirePermission` key plus its §4.8 ABAC binding; the two close routes add the step-up gate; every
// mutation declares `Idempotency-Key` (ADR-0021) and every state transition requires `If-Match` (§2.5).
import type { FastifyInstance } from "fastify";
import { registerBereavedContactRoutes } from "./contacts.routes";
import { registerBereavementDashboardRoutes } from "./dashboard.routes";
import type { M16RouteServices } from "./index";
import { registerBereavementOutreachRoutes } from "./outreach.routes";
import { registerBereavementPlanRoutes } from "./plans.routes";

export { registerBereavementPlanRoutes, type PlanRouteDeps } from "./plans.routes";
export { registerBereavedContactRoutes, type ContactRouteDeps } from "./contacts.routes";
export { registerBereavementOutreachRoutes, type OutreachRouteDeps } from "./outreach.routes";
export { registerBereavementDashboardRoutes, type DashboardRouteDeps } from "./dashboard.routes";

/** Mount every M16 §4.1 route plugin over the Drizzle-backed (or in-memory) read + write services. */
export function mountM16Routes(app: FastifyInstance, services: M16RouteServices): void {
  const { readService, writeService } = services;
  registerBereavementPlanRoutes(app, { readService, writeService });
  registerBereavedContactRoutes(app, { writeService });
  registerBereavementOutreachRoutes(app, { writeService });
  registerBereavementDashboardRoutes(app, { readService });
}
