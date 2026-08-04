// apps/backend/src/modules/35-subscription/routes/index.ts — M35 routes barrel.
//
// Re-exports the §4.1–4.3 route mount + the Drizzle route-service builder + the service contract/view
// types the composition root binds (the M27 routes/index.ts precedent).
export { mountM35Routes, type M35MountDeps } from "./mount";
export {
  buildDrizzleM35RouteService,
  type M35RouteServiceDeps,
  type PlatformRunner,
  type WriteOutboxPort,
  type WriteTx,
} from "./service-drizzle";
export type { M35RouteService } from "./service";
export type {
  M35WebhookIngest,
  M35WebhookResultKind,
  WebhookRouteDeps,
} from "./webhooks.routes";
