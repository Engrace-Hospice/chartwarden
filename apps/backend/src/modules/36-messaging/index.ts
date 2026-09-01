// apps/backend/src/modules/36-messaging — Module 36 (Secure Messaging & Alerts) backend surface,
// owned per module-manifest.ts codePath `apps/backend/src/modules/36-messaging`.
//
// M36-T06 (./seams) registers M36's published `AlertEmitter` seam (§4.6) — the alert routing
// surface every clinical/billing module emits through — into the M1 registry, and declares
// `MessagingProvider` fail-closed (its DB-backed impl lands with routes/realtime, M36-T07/T08).
// The §4.7 PHI sanitization wrapper (`sanitizeForOutOfBand`) — the only path to out-of-band
// channels — ships in @wardenx/messaging and is exercised by the §7.2 golden test.
//
// M36-T08 (./routes/webhook-routes) adds the three inbound vendor webhook routes (§4.9) — the
// only M36 routes NOT session-authenticated; they authenticate by the §4.9 two-layer defense
// (replay window + Twilio HMAC / Postmark IP-allowlist + bearer token) before reconciling
// `notification_delivery`. The realtime event/room CONTRACT (§4.3), the §4.4 job queue catalog +
// pure processors (hash_verify / retention legal-hold filter / DLQ OPS-035 record), and the §4.8
// cache grammar ship in @wardenx/messaging; the §8.1.2 job-emitted audit events are catalogued
// under `m36.*` in @wardenx/audit. The Socket.IO server + BullMQ workers + Valkey adapter WIRING
// is deferred to M1 infra (the same deferred-binding stance as the M38 jobs).
//
// M36-T09 (cross-module notification composition, ADR-0024) lands in @wardenx/messaging
// (`./compose`): SD-017 assigns recipient resolution + preference-aware routing to M36, so the
// referral / critical-results / transmission-failure notification families moved off M14. The
// `composeAndDispatch` engine loads a `notification_template` (tighten-only tenant overlay),
// renders title/body from the source event payload, resolves recipients via the ADR-0024
// resolvers (registered onto M36's open registry), and dispatches catalog-validated — M36 never
// importing a producer module (M36-F01). The six platform-floor templates ship as a code seed
// (`PLATFORM_NOTIFICATION_TEMPLATES`) the boot slice UPSERTs into `notification_template`; the
// Drizzle-backed template/overlay store + §4.6.1 dispatch wiring bind at boot (same deferred
// stance as the T08 infra).
//
// M36-T10 (./erasers) registers M36's REAL `messages` DataEraser (§7.8 / D9) over the Phase-0
// deny-stub: tenant-offboarding cryptographically erases every message body by destroying the
// tenant DEK, then deletes structural + sole-tenant cross-tenant rows. Screens (§5) defer — M36 has
// no `apps/web` manifest codePath (the §5 inventory targets apps/frontend/portal/admin); the §4.10
// STRIDE model + DR/INT inventory ship as module docs (./THREAT_MODEL.md).
// TASK-003/ARCH-007: `createDrizzleMessagingEraseStore` is the production store the composition
// root injects via `deps.store` (bind `soleTenantUserIds` from a platform-context membership
// enumerator; note the `presence` DELETE-grant caveat in its header).
export {
  type DrizzleMessagingEraseDeps,
  type MessagingEraserDeps,
  createDrizzleMessagingEraseStore,
  registerMessagingErasers,
  createMessagingEraser,
} from "./erasers/messaging-eraser";
export {
  type MessagingSeamDeps,
  registerMessagingSeams,
  getAlertEmitter,
  getMessagingProvider,
} from "./seams";
// M36-T07 — the §4.1–4.2 route inventory behind `requirePermission`/`requireAbac` on the §4.5
// keys, composed over the injected `MessagingRouteService`; plus the `channel_visibility` ABAC
// predicate (§4.5) the channel-scoped routes gate on.
export {
  type MessagingRouteDeps,
  CHANNEL_VISIBILITY_PREDICATE,
  registerMessagingAbacPredicates,
  registerMessagingRoutes,
} from "./routes/messaging-routes";
// M36-T08 — the §4.9 inbound vendor webhook routes (Twilio sms/voice status, Postmark event)
// behind the two-layer signature defense; the verified callback reconciles `notification_delivery`.
export {
  type MessagingWebhookDeps,
  type MessagingWebhookService,
  type VendorDeliveryUpdate,
  registerMessagingWebhookRoutes,
} from "./routes/webhook-routes";

// FB-T04/FB-T05 — the production Drizzle route-service adapter (over the M36 tables) + the
// composition-root route mount. `createDbMessagingRouteService` backs the §4.1–4.2 READ + WRITE
// surface live (channel list / detail / thread envelope decrypt / alert inbox / preferences / alert
// rules + send / edit / delete / receipts / DM / member admin / announce / preference + endpoint /
// alert-rule override). The staff-messaging + notifications-inbox screens read/write live through these.
export { createDbMessagingRouteService } from "./messaging-route-service-db";
// FB-T05 — the production Drizzle `MessagingProvider` seam (§4.6): the cross-module channel/message
// CRUD surface, registered into the M1 registry over the deny-stub so `validateSeams()` sees it real.
export { createDbMessagingProvider } from "./messaging-provider-db";
// GAP-096 — the production Drizzle `AlertEmitterPorts` + the `AlertEmitter` they compose over (the
// M36-T04 resolution/fan-out engine, real for the first time in the composition root).
export {
  createDrizzleAlertEmitter,
  createDrizzleAlertEmitterPorts,
} from "./alert-emitter-drizzle";
export { buildM36ClinicalAlertConsumer } from "./outbox-consumers/clinical-alerts";
// GAP-096 — boot-populate alert_rule's platform-default rows (BYPASSRLS-only; see file header).
export { wireAlertRuleSeed } from "./alert-rule-seed-persister";
// FB-T14 — M36-owned TRANSACTIONAL email transport (password reset / magic-link delivery). The
// composition root binds the auth `EmailTransport` seam to this, so auth links dispatch through M36
// (DR/INT #14, Postmark = M36) — no `dependsOn` edge (the bridge lives in the composition root).
export {
  selectTransactionalEmailTransport,
  createConsoleTransactionalEmailTransport,
  createNoopTransactionalEmailTransport,
  type OutboundEmail,
  type TransactionalEmailTransport,
} from "@wardenx/messaging";

import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import { createDbMessagingRouteService as _createDbMessagingRouteService } from "./messaging-route-service-db";
import {
  registerMessagingAbacPredicates as _registerMessagingAbacPredicates,
  registerMessagingRoutes as _registerMessagingRoutes,
} from "./routes/messaging-routes";

/**
 * Mount the M36 messaging REST routes (channels / messages / notification preferences + endpoints /
 * alerts) on a server — invoked by the composition root when a DB client is present. The READ surface
 * runs over the real Drizzle-backed `MessagingRouteService` (org-scoped reads under RLS), and the
 * `channel_visibility` ABAC predicate is registered against the same service so the channel-scoped
 * routes resolve live; the write paths defer to FB-T05 (501). Backs the staff-messaging +
 * notifications-inbox screens (FB-T04).
 */
export function mountMessagingRoutes(app: FastifyInstance, db: DbClient): void {
  const service = _createDbMessagingRouteService(db);
  _registerMessagingAbacPredicates(service); // idempotent — single-owner registry, re-boot-safe
  _registerMessagingRoutes(app, { service });
}
