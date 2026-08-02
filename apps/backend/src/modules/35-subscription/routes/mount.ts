// apps/backend/src/modules/35-subscription/routes/mount.ts — M35 route mount (§4.1–4.3) + plugin barrel.
//
// `mountM35Routes` is the single composition-root entry (the M27 `mountM27Routes` precedent), mounted
// behind the same authenticate/security/error chain as every other module's routes. The three plugin
// groups — the §4.1 tenant surface, the §4.2 platform-ops surface (both over the single Drizzle
// {@link M35RouteService}), and the §4.3 webhook surface (over the injected ingest handler) — are also
// re-exported so a route test can mount one group over a fresh in-memory backend.
import type { FastifyInstance } from "fastify";
import { type AdminRouteDeps, registerAdminRoutes } from "./admin.routes";
import type { M35RouteService } from "./service";
import { type TenantRouteDeps, registerTenantRoutes } from "./tenant.routes";
import { type WebhookRouteDeps, registerWebhookRoutes } from "./webhooks.routes";

export { registerTenantRoutes, type TenantRouteDeps } from "./tenant.routes";
export { registerAdminRoutes, type AdminRouteDeps } from "./admin.routes";
export {
  registerWebhookRoutes,
  type WebhookRouteDeps,
  type M35WebhookIngest,
  type M35WebhookResultKind,
} from "./webhooks.routes";

/** The deps `mountM35Routes` binds: the Drizzle route service + the webhook ingest handler. */
export interface M35MountDeps {
  readonly service: M35RouteService;
  readonly webhook?: WebhookRouteDeps;
}

/**
 * Mount every M35 route plugin over the Drizzle-backed route service, behind the same
 * authenticate/security/error chain as the other modules (the `mountM27Routes` precedent).
 */
export function mountM35Routes(app: FastifyInstance, deps: M35MountDeps): void {
  const tenant: TenantRouteDeps = { service: deps.service };
  const admin: AdminRouteDeps = { service: deps.service };
  registerTenantRoutes(app, tenant);
  registerAdminRoutes(app, admin);
  registerWebhookRoutes(app, deps.webhook ?? {});
}
