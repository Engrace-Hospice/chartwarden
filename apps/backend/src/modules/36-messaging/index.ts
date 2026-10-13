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
// §8.1.2 / #205 — M36's one cross-module outbox event. See events-by-m36.ts's header for why it
// has no producer yet.
export { M36_OUTBOX_EVENTS } from "./events-by-m36";
// M36-T07 — the §4.1–4.2 route inventory behind `requirePermission`/`requireAbac` on the §4.5
// keys, composed over the injected `MessagingRouteService`; plus the `channel_visibility` ABAC
// predicate (§4.5) the channel-scoped routes gate on.
export {
  type MessagingRouteDeps,
  CHANNEL_MEMBER_ADMIN_PREDICATE,
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
export { createRealtimeAuditWriter } from "./audit/realtime-audit";
export {
  createDbMessagingRouteService,
  type MessagingOutboxPort,
} from "./messaging-route-service-db";
export {
  ADMIN_PLATFORM_PREDICATE as M36_ADMIN_PLATFORM_PREDICATE,
  type AdminAlertDeliveriesDeps,
  AlertDeliveriesQuerySchema,
  AlertDeliveriesResponseSchema,
  buildAdminAlertDeliveriesDeps,
  registerAdminAlertDeliveriesRoutes,
  registerMessagingAdminPredicates,
} from "./routes/admin-alert-deliveries-routes";
// FB-T05 — the production Drizzle `MessagingProvider` seam (§4.6): the cross-module channel/message
// CRUD surface, registered into the M1 registry over the deny-stub so `validateSeams()` sees it real.
export { createDbMessagingProvider } from "./messaging-provider-db";
// GAP-096 — the production Drizzle `AlertEmitterPorts` + the `AlertEmitter` they compose over (the
// M36-T04 resolution/fan-out engine, real for the first time in the composition root).
export {
  createDrizzleAlertEmitter,
  createDrizzleAlertEmitterPorts,
  createDrizzleIdgAttendeeLookup,
  createDrizzleMembershipUserLookup,
  createDrizzleRoleSetMembersReader,
} from "./alert-emitter-drizzle";
export type { MembershipsHoldingPermissionPort } from "./alert-emitter-drizzle";
export { buildM36ClinicalAlertConsumer } from "./outbox-consumers/clinical-alerts";
// M14 §2.7/D8 — the carry-forward COMPLIANCE alert: `m14.action_item.carry_forward` (the count crossing 3) ->
// the critical typed alert `m14.action_item.carry_forward.compliance`, once per action item.
export {
  IDG_CARRY_FORWARD_COMPLIANCE_CONSUMER,
  IDG_CARRY_FORWARD_COMPLIANCE_PAYLOAD_TYPE,
  buildIdgCarryForwardComplianceConsumer,
  carryForwardComplianceCorrelationId,
} from "./outbox-consumers/idg-carry-forward-compliance";
// M14 §4.10 — the remaining typed IDG alerts (packets ready / action item assigned / non-quorate decision /
// review-clock escalation / review-floor override): one M36 consumer each over a shared shape.
export {
  IDG_ALERT_CONSUMERS,
  buildIdgAlertConsumers,
  idgActionItemCreatedCorrelationId,
  idgNonQuorateCorrelationId,
  idgPacketsReadyCorrelationId,
  idgReviewClockCorrelationId,
  idgReviewFloorOverrideCorrelationId,
} from "./outbox-consumers/idg-alerts";
// GAP-096 — boot-populate alert_rule's platform-default rows (BYPASSRLS-only; see file header).
export { wireAlertRuleSeed } from "./alert-rule-seed-persister";
// FB-T14 — M36-owned TRANSACTIONAL email transport (password reset / magic-link delivery). The
// composition root binds the auth `EmailTransport` seam to this, so auth links dispatch through M36
// (DR/INT #14, Postmark = M36) — no `dependsOn` edge (the bridge lives in the composition root).
export {
  selectTransactionalEmailTransport,
  createConsoleTransactionalEmailTransport,
  createNoopTransactionalEmailTransport,
  createPostmarkTransactionalEmailTransport,
  resolvePostmarkConfig,
  postmarkConfigAttempted,
  EmailDeliveryError,
  type OutboundEmail,
  type TransactionalEmailTransport,
} from "@wardenx/messaging";

import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import { createDbAnnouncementService as _createDbAnnouncementService } from "./announcement-service-db";
import type { AttachmentStoragePort, ScanPort } from "./attachments/attachment-ports";
import { createAttachmentService as _createAttachmentService } from "./attachments/attachment-service-db";
import type { EndpointVerificationSender } from "./delivery/transport-binding";
import { createDbDraftService as _createDbDraftService } from "./drafts/draft-service-db";
import { createDbMessagingRouteService as _createDbMessagingRouteService } from "./messaging-route-service-db";
import type { MessagingOutboxPort } from "./messaging-route-service-db";
import {
  buildAdminAlertDeliveriesDeps as _buildAdminAlertDeliveriesDeps,
  registerAdminAlertDeliveriesRoutes as _registerAdminAlertDeliveriesRoutes,
  registerMessagingAdminPredicates as _registerMessagingAdminPredicates,
} from "./routes/admin-alert-deliveries-routes";
import { registerAttachmentRoutes as _registerAttachmentRoutes } from "./routes/attachment-routes";
import { registerDraftRoutes as _registerDraftRoutes } from "./routes/draft-routes";
import {
  registerMessagingAbacPredicates as _registerMessagingAbacPredicates,
  registerMessagingRoutes as _registerMessagingRoutes,
} from "./routes/messaging-routes";
import { registerScheduledSendRoutes as _registerScheduledSendRoutes } from "./routes/scheduled-send-routes";
import { registerTemplateRoutes as _registerTemplateRoutes } from "./routes/template-routes";
import { createDbScheduledSendService as _createDbScheduledSendService } from "./scheduled/scheduled-send-service-db";
import { createDbTemplateService as _createDbTemplateService } from "./templates/template-service-db";

/**
 * Mount the M36 messaging REST routes (channels / messages / notification preferences + endpoints /
 * alerts) on a server — invoked by the composition root when a DB client is present. The READ surface
 * runs over the real Drizzle-backed `MessagingRouteService` (org-scoped reads under RLS), and the
 * `channel_visibility` ABAC predicate is registered against the same service so the channel-scoped
 * routes resolve live; the write paths are live too (no route returns 501). Backs the staff-messaging +
 * notifications-inbox screens (FB-T04).
 */
export function mountMessagingRoutes(
  app: FastifyInstance,
  db: DbClient,
  opts: {
    sendEndpointVerificationCode?: EndpointVerificationSender;
    outbox?: MessagingOutboxPort;
    /** WP 1.5: object storage + malware scanner. No scanner => attachments stay pending (nothing is delivered). */
    attachments?: { storage: AttachmentStoragePort; scanner?: ScanPort | undefined };
  } = {},
): void {
  // GAP-063 — the §4.2 OTP sender; with none bound, sms/email endpoint registration answers 503.
  const service = _createDbMessagingRouteService(db, {
    ...(opts.outbox ? { outbox: opts.outbox } : {}),
    ...(opts.sendEndpointVerificationCode
      ? { sendEndpointVerificationCode: opts.sendEndpointVerificationCode }
      : {}),
  });
  _registerMessagingAbacPredicates(service); // idempotent — single-owner registry, re-boot-safe
  const announcements = _createDbAnnouncementService(db);
  _registerMessagingRoutes(app, { service, announcements }); // WP 2.9
  // WP 2.5 — private encrypted drafts (own row per user + channel + thread root).
  _registerDraftRoutes(app, { service: _createDbDraftService({ db }) });
  // WP 2.6 — scheduled send: the QUEUEING side. The `messaging.scheduled_send` sweep sends (see ./scheduled/*).
  _registerScheduledSendRoutes(app, {
    service: _createDbScheduledSendService({ db, canViewChannel: service.canViewChannel }),
    announcements,
  });
  // WP 1.5 — attachment authorize/complete/access. The visibility rule is the route service's own, so an attachment
  // is exactly as reachable as the channel it was posted in. Without storage the routes answer a typed 503.
  if (opts.attachments) {
    _registerAttachmentRoutes(app, {
      service: _createAttachmentService({
        db,
        storage: opts.attachments.storage,
        scanner: opts.attachments.scanner,
        outbox: opts.outbox,
        canViewChannel: service.canViewChannel,
      }),
    });
  }
  // WP 2.8 — message templates and saved replies (personal + shared + platform overlay).
  _registerTemplateRoutes(app, { service: _createDbTemplateService(db) });
  // GAP-165 — the platform-ops cross-tenant delivery drill (§4.1 `messaging.admin.read`): own predicate, own
  // SECURITY DEFINER reader (0474), audited per read. Not tenant-scoped, so it takes the pooled handle directly.
  _registerMessagingAdminPredicates();
  _registerAdminAlertDeliveriesRoutes(app, _buildAdminAlertDeliveriesDeps(db));
}

// GAP-010 — M36's consumer for M3's `m3.breakglass.invoked` (durable Compliance notification).
export {
  M36_BREAKGLASS_ALERT_CONSUMER,
  buildM36BreakGlassAlertConsumer,
} from "./outbox-consumers/breakglass-alert";

// GAP-101 — out-of-band delivery workers (the §4.4 send_push/sms/voice/email sweeps) + the §4.9 vendor webhooks
// mounted over a real `delivery_reconcile` service (see ./delivery/*).
export {
  type DeliveryOutboxPort,
  DELIVERY_FAILED_EVENT,
  applyDeliveryTransition,
} from "./delivery/delivery-settlement";
export {
  type DeliveryDispatchStore,
  createDrizzleDeliveryDispatchStore,
} from "./delivery/delivery-dispatch-store-db";
export {
  type DeliverySweepDeps,
  type DeliverySweepResult,
  runDeliverySweep,
} from "./delivery/delivery-sweep";
export {
  type M36DeliveryWorkerDeps,
  registerM36DeliveryWorkers,
  scheduleM36DeliveryJobs,
} from "./delivery/delivery-workers";
export {
  type EndpointVerificationSender,
  type OutOfBandBinding,
  bindOutOfBandTransports,
} from "./delivery/transport-binding";
export { createSosContactCaller } from "./delivery/sos-contact-caller";
export { createDbMessagingWebhookService } from "./delivery/webhook-service-db";
export {
  type MessagingWebhookConfig,
  mountMessagingWebhookRoutes,
  readMessagingWebhookConfig,
} from "./delivery/webhook-mount";
export {
  M36_DELIVERY_PLATFORM_JOB_ID,
  M36_INTEGRITY_PLATFORM_JOB_ID,
  wireM36DeliveryTenancy,
} from "./delivery/wiring";
export {
  type M36IntegrityWorkerDeps,
  registerM36IntegrityWorkers,
  scheduleM36IntegrityJobs,
} from "./jobs/integrity-workers";
// WP 1.5 — attachments: scan-gated upload/complete/access service, its routes, the scan sweep worker and the ports
// the composition root binds (M36 never imports M22; see apps/backend/src/m36-attachment-storage.ts).
export {
  type AttachmentService,
  createAttachmentService,
} from "./attachments/attachment-service-db";
export type { AttachmentStoragePort, ScanPort } from "./attachments/attachment-ports";
export {
  type M36AttachmentScanWorkerDeps,
  attachmentScanTick,
  registerM36AttachmentScanWorker,
  scheduleM36AttachmentScanJobs,
} from "./attachments/attachment-scan-worker";
export { registerAttachmentRoutes } from "./routes/attachment-routes";

// WP 2.8 — message templates & saved replies: Drizzle service + routes (the in-memory twin lives in @wardenx/messaging).
export { createDbTemplateService } from "./templates/template-service-db";
export { registerTemplateRoutes } from "./routes/template-routes";

// WP 2.6 — scheduled send: the dispatcher (re-check at dispatch, send, delete in one transaction), its per-minute BullMQ
// sweep, and the consumer that tells the sender a message was blocked.
export {
  type ScheduledSendDispatcher,
  type ScheduledSendDispatcherDeps,
  SCHEDULE_BLOCKED_EVENT,
  createScheduledSendDispatcher,
} from "./scheduled/scheduled-send-dispatcher";
export { createDbScheduledSendService } from "./scheduled/scheduled-send-service-db";
export {
  type M36ScheduledSendWorkerDeps,
  registerM36ScheduledSendWorker,
  scheduleM36ScheduledSendJobs,
  scheduledSendTick,
} from "./scheduled/scheduled-send-worker";
export { registerScheduledSendRoutes } from "./routes/scheduled-send-routes";
export {
  M36_SCHEDULE_BLOCKED_CONSUMER,
  buildM36ScheduleBlockedConsumer,
} from "./outbox-consumers/schedule-blocked";
