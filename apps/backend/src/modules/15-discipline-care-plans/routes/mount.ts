// apps/backend/src/modules/15-discipline-care-plans/routes/mount.ts — M15 route mount (§4.1) + plugin
// barrel.
//
// The four §4.1 route plugins (plans/versions/elements · aide supervisory · volunteer · the internal seam
// surface). `mountM15Routes` is the single composition-root entry (the M24/M25/M26 mount precedent),
// mounted behind the same authenticate / security / error chain as every other module. Every route gates
// on its §4.4 `requirePermission` key; the sign/amend routes add the §4.1 step-up gate; every mutation
// declares `Idempotency-Key` (§F08) and every PATCH/state transition requires `If-Match` (§2.5).
import type { FastifyInstance } from "fastify";
import type { M15RouteServices } from "./index";
import { registerDisciplinePlanInternalRoutes } from "./internal.routes";
import { registerDisciplinePlanRoutes } from "./plans.routes";
import { registerAideSupervisoryRoutes } from "./supervisory.routes";
import { registerVolunteerRoutes } from "./volunteer.routes";

export { registerDisciplinePlanRoutes, type PlanRouteDeps } from "./plans.routes";
export { registerAideSupervisoryRoutes, type SupervisoryRouteDeps } from "./supervisory.routes";
export { registerVolunteerRoutes, type VolunteerRouteDeps } from "./volunteer.routes";
export {
  registerDisciplinePlanInternalRoutes,
  type InternalRouteDeps,
} from "./internal.routes";

/** Mount every M15 §4.1 route plugin over the Drizzle-backed (or in-memory) read + write services. */
export function mountM15Routes(app: FastifyInstance, services: M15RouteServices): void {
  const { readService, writeService } = services;
  registerDisciplinePlanRoutes(app, { readService, writeService });
  registerAideSupervisoryRoutes(app, { writeService });
  registerVolunteerRoutes(app, { readService, writeService });
  registerDisciplinePlanInternalRoutes(app, { readService });
}
