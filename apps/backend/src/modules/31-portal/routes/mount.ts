// apps/backend/src/modules/31-portal/routes/mount.ts — M31 route mount (§4.1) + plugin barrel.
//
// The five §4.1 route plugins (the portal session surface · the lay-language reads · the portal writes ·
// telehealth · the staff admin surface). `mountM31Routes` is the single composition-root entry (the
// M19/M20 mount precedent), mounted behind the same authenticate / security / error chain as every other
// module. Every route gates on its §4.6 `requirePermission` key plus its §4.7 ABAC binding; the six §4.1
// step-up operations add `requireStepUp` at the route; every mutation declares `Idempotency-Key`
// (ADR-0021) except the read routes and the HMAC-only vendor webhooks.
import type { FastifyInstance } from "fastify";
import { registerPortalAdminRoutes } from "./admin.routes";
import type { PortalRouteDeps } from "./index";
import { registerPortalReadRoutes } from "./read.routes";
import { registerPortalSessionRoutes } from "./session.routes";
import { registerPortalSignInRoutes } from "./sign-in.routes";
import { registerTelehealthRoutes } from "./telehealth.routes";
import { registerPortalWriteRoutes } from "./write.routes";

export { registerPortalSessionRoutes } from "./session.routes";
export { registerPortalSignInRoutes } from "./sign-in.routes";
export { registerPortalReadRoutes } from "./read.routes";
export { registerPortalWriteRoutes } from "./write.routes";
export { registerTelehealthRoutes } from "./telehealth.routes";
export { registerPortalAdminRoutes } from "./admin.routes";

/** Mount every M31 §4.1 route plugin over the Drizzle-backed store + injected telehealth adapter. */
export function mountM31Routes(app: FastifyInstance, deps: PortalRouteDeps): void {
  registerPortalSignInRoutes(app, deps);
  registerPortalSessionRoutes(app, deps);
  registerPortalReadRoutes(app, deps);
  registerPortalWriteRoutes(app, deps);
  registerTelehealthRoutes(app, deps);
  registerPortalAdminRoutes(app, deps);
}
