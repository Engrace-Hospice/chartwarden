// apps/backend/src/modules/16-bereavement/routes/mount.ts — M16 route mount (§4.1) + plugin barrel.
//
// The four §4.1 route plugins (plans/lifecycle/risk · bereaved contacts · touchpoints · dashboards).
// `mountM16Routes` is the single composition-root entry (the M15/M24/M25/M26 mount precedent), mounted
// behind the same authenticate / security / error chain as every other module. Every route gates on its
// §4.7 `requirePermission` key plus its §4.8 ABAC binding; the two close routes add the step-up gate; every
// mutation declares `Idempotency-Key` (ADR-0021) and every state transition requires `If-Match` (§2.5).
import type { FastifyInstance } from "fastify";
import { registerBereavementAssessmentDraftRoutes } from "./assessment-draft.routes";
import { registerBereavedContactRoutes } from "./contacts.routes";
import { registerBereavementDashboardRoutes } from "./dashboard.routes";
import { registerBereavementGroupRoutes } from "./group.routes";
import type { M16RouteServices } from "./index";
import { registerBereavementMailingRoutes } from "./mailing.routes";
import { registerBereavementMemorialRoutes } from "./memorial.routes";
import { registerBereavementOutreachRoutes } from "./outreach.routes";
import { registerBereavementPhysicianLetterRoutes } from "./physician-letter.routes";
import { registerBereavementPlanRoutes } from "./plans.routes";

export { registerBereavementPlanRoutes, type PlanRouteDeps } from "./plans.routes";
export { registerBereavedContactRoutes, type ContactRouteDeps } from "./contacts.routes";
export {
  registerBereavementAssessmentDraftRoutes,
  type DraftRouteDeps,
} from "./assessment-draft.routes";
export { registerBereavementOutreachRoutes, type OutreachRouteDeps } from "./outreach.routes";
export {
  registerBereavementPhysicianLetterRoutes,
  type LetterRouteDeps,
} from "./physician-letter.routes";
export { registerBereavementDashboardRoutes, type DashboardRouteDeps } from "./dashboard.routes";
export { registerBereavementMailingRoutes, type MailingRouteDeps } from "./mailing.routes";
export { registerBereavementGroupRoutes, type GroupRouteDeps } from "./group.routes";
export { registerBereavementMemorialRoutes, type MemorialRouteDeps } from "./memorial.routes";

/** Mount every M16 §4.1 route plugin over the Drizzle-backed (or in-memory) read + write services. */
export function mountM16Routes(app: FastifyInstance, services: M16RouteServices): void {
  const { readService, writeService, draftService, letterService, mailingService, groupService } =
    services;
  registerBereavementPlanRoutes(app, { readService, writeService });
  registerBereavedContactRoutes(app, { writeService, readService });
  registerBereavementOutreachRoutes(app, { writeService });
  registerBereavementDashboardRoutes(app, { readService });
  registerBereavementAssessmentDraftRoutes(app, { draftService });
  registerBereavementPhysicianLetterRoutes(app, { letterService });
  registerBereavementMailingRoutes(app, { mailingService });
  registerBereavementGroupRoutes(app, { groupService });
  registerBereavementMemorialRoutes(app, { memorialService: services.memorialService });
}
