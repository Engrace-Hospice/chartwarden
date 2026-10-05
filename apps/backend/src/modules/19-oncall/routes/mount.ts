// apps/backend/src/modules/19-oncall/routes/mount.ts — M19 route mount (§4.1) + plugin barrel.
//
// The five §4.1 route plugins (triage calls + the §2.7 paper re-entry · escalations · shifts + tenant
// policy · protocol catalog + vendor bindings · the M31 portal view). `mountM19Routes` is the single
// composition-root entry (the M15/M16/M21/M24/M26 mount precedent), mounted behind the same authenticate /
// security / error chain as every other module.
//
// Every route gates on its §4.6 `requirePermission` key plus its §4.7 ABAC binding; the four §4.6 step-up
// operations add `requireStepUp`; every mutation declares `Idempotency-Key` (ADR-0021) and every state
// transition requires `If-Match` (§2.5).
import type { FastifyInstance } from "fastify";
import { registerEscalationRoutes } from "./escalations.routes";
import type { M19RouteServices } from "./index";
import { registerPortalTriageRoutes } from "./portal.routes";
import { registerProtocolRoutes } from "./protocols.routes";
import { registerShiftRoutes } from "./shifts.routes";
import { registerTriageCallRoutes } from "./triage-calls.routes";
import { registerVendorSessionRoutes } from "./vendor-sessions.routes";

export { registerTriageCallRoutes, type TriageCallRouteDeps } from "./triage-calls.routes";
export { registerEscalationRoutes, type EscalationRouteDeps } from "./escalations.routes";
export { registerShiftRoutes, type ShiftRouteDeps } from "./shifts.routes";
export { registerProtocolRoutes, type ProtocolRouteDeps } from "./protocols.routes";
export { registerPortalTriageRoutes, type PortalRouteDeps } from "./portal.routes";
export {
  registerVendorSessionRoutes,
  type VendorBindingFacts,
  type VendorSessionBindReader,
  type VendorSessionRouteDeps,
} from "./vendor-sessions.routes";
export { buildDrizzleVendorSessionBindReader } from "./vendor-session-reader-drizzle";

/** Mount every M19 §4.1 route plugin over the Drizzle-backed READ + WRITE services. */
export function mountM19Routes(app: FastifyInstance, services: M19RouteServices): void {
  const { readService, writeService, caseloadPatientIds } = services;
  registerTriageCallRoutes(app, {
    readService,
    writeService,
    ...(caseloadPatientIds ? { caseloadPatientIds } : {}),
  });
  registerEscalationRoutes(app, { readService, writeService });
  registerShiftRoutes(app, { readService, writeService });
  registerProtocolRoutes(app, { readService, writeService });
  registerPortalTriageRoutes(app, { readService });
  // F-030 — the vendor-session bind route mounts only when a real reader is supplied. Absent, not a
  // deny-stub: a deployment that has not wired it should not advertise a bind endpoint that always
  // refuses, which is the shape that made the ORIGINAL defect invisible.
  if (services.vendorSessionBindReader) {
    registerVendorSessionRoutes(app, { reader: services.vendorSessionBindReader });
  }
}
