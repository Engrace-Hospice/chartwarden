// apps/backend/src/modules/36-messaging — Module 36 (Secure Messaging & Alerts) backend surface,
// owned per module-manifest.ts codePath `apps/backend/src/modules/36-messaging`.
//
// M36-T06 (./seams) registers M36's published `AlertEmitter` seam (§4.6) — the alert routing
// surface every clinical/billing module emits through — into the M1 registry, and declares
// `MessagingProvider` fail-closed (its DB-backed impl lands with routes/realtime, M36-T07/T08).
// The §4.7 PHI sanitization wrapper (`sanitizeForOutOfBand`) — the only path to out-of-band
// channels — ships in @chartwarden/messaging and is exercised by the §7.2 golden test.
//
// M36-T08 (./routes/webhook-routes) adds the three inbound vendor webhook routes (§4.9) — the
// only M36 routes NOT session-authenticated; they authenticate by the §4.9 two-layer defense
// (replay window + Twilio HMAC / Postmark IP-allowlist + bearer token) before reconciling
// `notification_delivery`. The realtime event/room CONTRACT (§4.3), the §4.4 job queue catalog +
// pure processors (hash_verify / retention legal-hold filter / DLQ OPS-035 record), and the §4.8
// cache grammar ship in @chartwarden/messaging; the §8.1.2 job-emitted audit events are catalogued
// under `m36.*` in @chartwarden/audit. The Socket.IO server + BullMQ workers + Valkey adapter WIRING
// is deferred to M1 infra (the same deferred-binding stance as the M38 jobs).
//
// M36-T09 (cross-module notification composition, ADR-0024) lands in @chartwarden/messaging
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
  getEscalationRouter,
} from "./seams";
// WP 4.9 (ADR-0076) — the per-organisation numbers behind the ops gauges and threshold notice (counts only).
export { createDbAckQueueStatsReader } from "./ack-requests/ack-queue-stats-db";
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
} from "@chartwarden/messaging";

import type { DbClient } from "@chartwarden/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createDbAckStore as _createDbAckStore } from "./ack-requests/ack-store-db";
import { createOpenRequestLookup as _createOpenRequestLookup } from "./ack-requests/open-request-lookup";
import { createDbUnacknowledgedReader as _createDbUnacknowledgedReader } from "./ack-requests/unacknowledged-reader-db";
import { createUnacknowledgedService as _createUnacknowledgedService } from "./ack-requests/unacknowledged-service";
import { buildSmartInboxService as _buildSmartInboxService, smartInboxFlag as _smartInboxFlag } from "./inbox/binding";
import { createAckBroadcastService as _createAckBroadcastService } from "./ack-broadcast/ack-broadcast-service";
import { createDbAnnouncementService as _createDbAnnouncementService } from "./announcement-service-db";
import type { AttachmentStoragePort, ScanPort } from "./attachments/attachment-ports";
import { createAttachmentService as _createAttachmentService } from "./attachments/attachment-service-db";
import { createBreakGlassReadAccess as _createBreakGlassReadAccess } from "./break-glass/break-glass-read-access";
import { createBreakGlassService as _createBreakGlassService } from "./break-glass/break-glass-service";
import type { buildClinicalLinkDeps as _buildClinicalLinkDeps } from "./clinical-link/binding";
import { createDbDeliveryTargetReader as _createDbDeliveryTargetReader } from "./delivery-target/delivery-target-reader-db";
import { createDeliveryTargetService as _createDeliveryTargetService } from "./delivery-target/delivery-target-service";
import type { EndpointVerificationSender } from "./delivery/transport-binding";
import { createDbDraftService as _createDbDraftService } from "./drafts/draft-service-db";
import type {
  ExportArtefactReader as _ExportArtefactReader,
  ExportFlagReader as _ExportFlagReader,
  ExportPermissionCheck as _ExportPermissionCheck,
} from "./export/export-ports";
import { createExportService as _createExportService } from "./export/export-service";
import {
  type AttemptLimiter as _ExternalShareLimiter,
  type ExternalShareFlagReader as _ExternalShareFlagReader,
  createExternalShareService as _createExternalShareService,
} from "./external-share/external-share-service";
import {
  createDrizzleSharePartnerStore as _createDrizzleSharePartnerStore,
  createDrizzleShareStaffStore as _createDrizzleShareStaffStore,
} from "./external-share/external-share-store";
import { createMessageBodyCipher as _createMessageBodyCipher } from "./messaging-write-core";
import { createDrizzleExportStore as _createDrizzleExportStore } from "./export/export-store";
import {
  type GlobalSearchMountOptions,
  mountGlobalSearchRoutes as _mountGlobalSearchRoutes,
} from "./global-search/mount";
import { createGlobalSearchPrerequisites as _createGlobalSearchPrerequisites } from "./global-search/prerequisites";
import { createGlobalSearchSettingsService as _createGlobalSearchSettingsService } from "./global-search/settings-service";
import { createMessageRedactionService as _createMessageRedactionService } from "./governance/message-redaction-service";
import {
  type RetentionGovernanceDeps as _RetentionGovernanceDeps,
  createRetentionGovernanceService as _createRetentionGovernanceService,
} from "./governance/retention-governance-service";
import type { buildIdgDiscussionDeps as _buildIdgDiscussionDeps } from "./idg/binding";
import { createMentionActorNameResolver as _createMentionActorNameResolver } from "./mention-non-member-service-db";
import {
  createDbMessagingRouteService as _createDbMessagingRouteService,
  isActiveMessagingUser as _isActiveMessagingUser,
} from "./messaging-route-service-db";
import type { MessagingOutboxPort } from "./messaging-route-service-db";
import {
  type OffboardingBindingInput as _OffboardingBindingInput,
  buildOffboardingService as _buildOffboardingService,
} from "./offboarding/binding";
import type { buildOnCallDirectoryDeps as _buildOnCallDirectoryDeps } from "./oncall-directory/binding";
import { createSeamPart2ChannelGate as _createSeamPart2ChannelGate } from "./part2-channel-gate";
import { createDbPollService as _createDbPollService } from "./polls/poll-service-db";
import type { AckRouteDeps as _AckRouteDeps } from "./routes/ack-routes";
import {
  buildAdminAlertDeliveriesDeps as _buildAdminAlertDeliveriesDeps,
  registerAdminAlertDeliveriesRoutes as _registerAdminAlertDeliveriesRoutes,
  registerMessagingAdminPredicates as _registerMessagingAdminPredicates,
} from "./routes/admin-alert-deliveries-routes";
import { registerAttachmentRoutes as _registerAttachmentRoutes } from "./routes/attachment-routes";
import { registerBreakGlassRoutes as _registerBreakGlassRoutes } from "./routes/break-glass-routes";
import {
  type DeathBoardRouteDeps as _DeathBoardRouteDeps,
  registerDeathBoardRoutes as _registerDeathBoardRoutes,
} from "./routes/death-board-routes";
import { registerDraftRoutes as _registerDraftRoutes } from "./routes/draft-routes";
import { registerExportRoutes as _registerExportRoutes } from "./routes/export-routes";
import { registerExternalShareRoutes as _registerExternalShareRoutes } from "./routes/external-share-routes";
import { registerGlobalSearchSettingsRoutes as _registerGlobalSearchSettingsRoutes } from "./routes/global-search-settings-routes";
import type { HandoffRouteDeps as _HandoffRouteDeps } from "./routes/handoff-routes";
import type { MedicationQuestionRouteDeps as _MedicationQuestionRouteDeps } from "./routes/medication-question-routes";
import { registerMessageRedactionRoutes as _registerMessageRedactionRoutes } from "./routes/message-redaction-routes";
import {
  registerMessagingAbacPredicates as _registerMessagingAbacPredicates,
  registerMessagingRoutes as _registerMessagingRoutes,
} from "./routes/messaging-routes";
import { registerOffboardingRoutes as _registerOffboardingRoutes } from "./routes/offboarding-routes";
import { registerPollRoutes as _registerPollRoutes } from "./routes/poll-routes";
import type { PresenceRouteDeps } from "./routes/presence-routes";
import type { PromotionRouteDeps as _PromotionRouteDeps } from "./routes/promotion-routes";
import { registerRetentionGovernanceRoutes as _registerRetentionGovernanceRoutes } from "./routes/retention-governance-routes";
import type { ReviewRouteDeps as _ReviewRouteDeps } from "./routes/review-routes";
import { registerScheduledSendRoutes as _registerScheduledSendRoutes } from "./routes/scheduled-send-routes";
import { registerSessionDeviceRoutes as _registerSessionDeviceRoutes } from "./routes/session-device-routes";
import type { SnoozeReminderRouteDeps as _SnoozeReminderRouteDeps } from "./routes/snooze-reminder-routes";
import type { TaskRouteDeps as _TaskRouteDeps } from "./routes/task-routes";
import { registerTemplateRoutes as _registerTemplateRoutes } from "./routes/template-routes";
import type { UrgentRouteDeps as _UrgentRouteDeps } from "./routes/urgent-routes";
import type { buildSbarDeps as _buildSbarDeps } from "./sbar/binding";
import { createDbScheduledSendService as _createDbScheduledSendService } from "./scheduled/scheduled-send-service-db";
import {
  type SessionDeviceBindingInput as _SessionDeviceBindingInput,
  buildSessionDeviceService as _buildSessionDeviceService,
} from "./session-devices/binding";
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
    /** WP 2.7b: global search. Omitted => inert (throwing key provider, fail-closed limiter, flags OFF). */
    globalSearch?: GlobalSearchMountOptions;
    /** WP 2.7b C4: true only once the ADR-0058 P2 per-route rate limit covers the search routes. Default false => ON refused. */
    globalSearchRateLimitActive?: boolean;
    /** WP 2.12: presence/typing store (Valkey in production), the tenant-flag reader and an optional per-route limit. */
    presence?: PresenceRouteDeps;
    /** WP 3.2: clinical links (tenant flag + source seams + link store). Omitted => flag off. */
    clinicalLinks?: ReturnType<typeof _buildClinicalLinkDeps>;
    /** WP 3.3: SBAR (tenant flag + policy store). Omitted => flag off. */
    sbar?: ReturnType<typeof _buildSbarDeps>;
    /** WP 3.4: communication tasks (tenant flag + service). Omitted => flag off. */
    tasks?: _TaskRouteDeps;
    /** WP 3.5: clinical handoffs (tenant flag + service). Omitted => flag off. */
    handoffs?: _HandoffRouteDeps;
    /** WP 3.8: lifecycle review queue (tenant flag + service). Omitted => flag off. */
    review?: _ReviewRouteDeps;
    /** WP 3.10: medication questions (service). Omitted => flag off. */
    medicationQuestions?: _MedicationQuestionRouteDeps;
    /** WP 4.1: urgent clinical message (service). Omitted => flag off. */
    urgent?: _UrgentRouteDeps;
    /** WP 4.2: acknowledgment requests (service + limiter). Omitted => every route is the uniform 404. */
    ackRequests?: _AckRouteDeps;
    /** WP 4.10: snooze and reminders (service). Omitted => every route is the uniform 404. */
    snoozeReminders?: _SnoozeReminderRouteDeps;
    /** WP 6.1 (ADR-0091): the smart work inbox. `flags` is the platform flag reader for `messaging.smart_inbox`; omitted => off. */
    smartInbox?: { flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined };
    /** WP 6.8 (ADR-0097): acknowledge-required broadcast. `flags` reads `messaging.ack_broadcast` (absent = off); `rateLimit` is the optional route budget. */
    ackBroadcast?: {
      flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
      rateLimit?: ((request: FastifyRequest, reply: FastifyReply) => Promise<void>) | undefined;
    };
    /** ADR-0082: the optional budget of the after-hours thread-line read. */
    afterHoursTriageRateLimit?: ((request: FastifyRequest, reply: FastifyReply) => Promise<void>) | undefined;
    /** WP 4.12: the on-call directory (read-only). Omitted => the uniform 404. */
    oncall?: ReturnType<typeof _buildOnCallDirectoryDeps>;
    /** WP 3.7: chart promotion (tenant flag + service). Omitted => flag off. */
    promotions?: _PromotionRouteDeps;
    /** WP 3.6: IDG discussions (tenant flags + read-only store). Omitted => flag off. */
    idgDiscussions?: ReturnType<typeof _buildIdgDiscussionDeps>;
    /** WP 5.5 (ADR-0083): the device and session manager; `disconnectSession` closes a session's sockets on every api node. Always mounted. */
    sessionDevices?: Pick<_SessionDeviceBindingInput, "disconnectSession" | "warn">;
    /**
     * WP 5.9 (ADR-0084): workforce offboarding. The composition root supplies the sweeps the deactivation event already runs and the ack
     * service / alert emitter of the supervisor reassign; the session revoke is the WP 5.5 service built here. Omitted => not mounted
     * (no database or no acknowledgment binding).
     */
    offboarding?: Omit<_OffboardingBindingInput, "db" | "sessionDevices">;
    /**
     * WP 5.6 (ADR-0086, PROPOSED): retention view and legal-hold apply / release. The composition root supplies M4's hold seam and the audit
     * reader; omitted => not mounted (no database).
     */
    retentionGovernance?: Omit<_RetentionGovernanceDeps, "db">;
    /**
     * WP 5.8 (ADR-0087, PROPOSED): the M1 flag reader for `messaging.break_glass`. Omitted => a break-glass grant is never honoured
     * (the read routes keep membership-only visibility).
     */
    breakGlass?: {
      flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
      /** Whether the user still holds messaging.break_glass.invoke; checked at every read under a grant. */
      holdsInvoke?: ((orgId: string, userId: string) => Promise<boolean>) | undefined;
    };
    /**
     * WP 5.7 (ADR-0089, PROPOSED): restricted messaging export. `flags` is the M1 reader for `messaging.export` (gates REQUESTING only; absent =>
     * requests are the uniform 404), `holds` rechecks a permission at the point of request, decision and download, `artefactReader` is the
     * builder side's decrypting reader (absent => a download is refused with 503 before anything is recorded). Omitted => not mounted.
     */
    messagingExport?: {
      flags?: _ExportFlagReader | undefined;
      holds?: _ExportPermissionCheck | undefined;
      artefactReader?: _ExportArtefactReader | undefined;
    };
    /**
     * WP 6.6 (ADR-0096, PROPOSED): external partner share. `flags` is the M1 reader for `messaging.external_partners` (absent or off => creating a
     * share and EVERY partner route are the uniform 404; listing and revoking never depend on it). The limiters are the composition root's budgets.
     * Omitted => not mounted.
     */
    externalShare?: {
      flags?: _ExternalShareFlagReader | undefined;
      redeemIpLimiter?: _ExternalShareLimiter | undefined;
      verifyIpLimiter?: _ExternalShareLimiter | undefined;
      bearerIpLimiter?: _ExternalShareLimiter | undefined;
      readLimiter?: _ExternalShareLimiter | undefined;
      /** D17: false => partner routes are not mounted and create / reissue answer PARTNER_ACCESS_UNAVAILABLE (503). Default true. */
      partnerAccessAvailable?: boolean | undefined;
    };
    /** WP 6.9 (ADR-0098, PROPOSED): the death-event coordination board (flag `messaging.death_board` + service). Omitted => not mounted. */
    deathBoard?: _DeathBoardRouteDeps;
  } = {},
): void {
  // GAP-063 — the §4.2 OTP sender; with none bound, sms/email endpoint registration answers 503.
  const service = _createDbMessagingRouteService(db, {
    ...(opts.breakGlass ? { breakGlass: opts.breakGlass } : {}),
    ...(opts.outbox ? { outbox: opts.outbox } : {}),
    ...(opts.sendEndpointVerificationCode
      ? { sendEndpointVerificationCode: opts.sendEndpointVerificationCode }
      : {}),
  });
  _registerMessagingAbacPredicates(service); // idempotent — single-owner registry, re-boot-safe
  const announcements = _createDbAnnouncementService(db);
  const unacknowledged = _createUnacknowledgedService({
    read: _createDbUnacknowledgedReader(db),
    canViewChannel: service.canViewChannel,
    displayName: _createMentionActorNameResolver(db),
  });
  // WP 6.6 (ADR-0096): ONE service serves the staff and partner routes AND the member banner on the channel detail.
  const externalShareService = opts.externalShare
    ? _createExternalShareService({
        staffStore: _createDrizzleShareStaffStore(db),
        partnerStore: _createDrizzleSharePartnerStore(db),
        outbox: opts.outbox,
        cipher: _createMessageBodyCipher(),
        // Membership only: the plain visibility predicate, never the break-glass read grant (ADR-0096 D1).
        canViewChannel: service.canViewChannel,
        ...opts.externalShare,
      })
    : undefined;
  _registerMessagingRoutes(app, {
    service,
    announcements,
    ...(externalShareService ? { externalShare: { indicator: externalShareService.indicator } } : {}),
    ...(opts.presence ? { presence: opts.presence } : {}),
    ...(opts.clinicalLinks ? { clinicalLinks: opts.clinicalLinks } : {}),
    ...(opts.sbar ? { sbar: opts.sbar } : {}),
    ...(opts.tasks ? { tasks: opts.tasks } : {}),
    ...(opts.handoffs ? { handoffs: opts.handoffs } : {}),
    ...(opts.review ? { review: opts.review } : {}),
    ...(opts.medicationQuestions ? { medicationQuestions: opts.medicationQuestions } : {}),
    ...(opts.urgent ? { urgent: opts.urgent } : {}),
    ...(opts.ackRequests ? { ackRequests: opts.ackRequests } : {}),
    ...(opts.snoozeReminders ? { snoozeReminders: opts.snoozeReminders } : {}),
    ...(opts.oncall ? { oncall: opts.oncall } : {}),
    // WP 4.9: the supervisor's unacknowledged queue (read-only; self-contained over `db`, no flag: with no requests it is empty).
    unacknowledged: { service: unacknowledged },
    // WP 6.1: read-only aggregation over the unacknowledged queue (narrowed to the caller), tasks, handoffs and the channel list.
    inbox: {
      service: _buildSmartInboxService({
        isEnabled: _smartInboxFlag(opts.smartInbox?.flags),
        unacknowledged,
        tasks: opts.tasks,
        handoffs: opts.handoffs,
        listChannels: service.listChannels,
      }),
    },
    // WP 6.8 (ADR-0097): acknowledge-required broadcast; every route answers the uniform 404 while the tenant flag is off.
    ackBroadcast: {
      service: _createAckBroadcastService({ db, flags: opts.ackBroadcast?.flags }),
      ...(opts.ackBroadcast?.rateLimit ? { rateLimit: opts.ackBroadcast.rateLimit } : {}),
    },
    ...(opts.afterHoursTriageRateLimit ? { afterHoursTriageRateLimit: opts.afterHoursTriageRateLimit } : {}),
    deliveryTarget: {
      service: _createDeliveryTargetService({
        read: _createDbDeliveryTargetReader(db),
        messaging: service,
        openRequestId: _createOpenRequestLookup(_createDbAckStore(db)),
      }),
    },
    ...(opts.promotions ? { promotions: opts.promotions } : {}),
    ...(opts.idgDiscussions ? { idgDiscussions: opts.idgDiscussions } : {}),
  }); // WP 2.9, 2.12, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
  // WP 2.5 — private encrypted drafts (own row per user + channel + thread root).
  _registerDraftRoutes(app, { service: _createDbDraftService({ db }) });
  // WP 2.10 — polls (non-clinical, single choice, named votes); a poll is written through the message write core.
  _registerPollRoutes(app, {
    service: _createDbPollService({
      db,
      canViewChannel: service.canViewChannel,
      ...(opts.outbox ? { outbox: opts.outbox } : {}),
    }),
    announcements,
    canManageMembers: service.canManageMembers,
  });
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
  // WP 2.7b (ADR-0058, Accepted) — global search; refused until operators enable it (see ./global-search/mount.ts).
  _mountGlobalSearchRoutes(app, db, opts.globalSearch);
  // WP 2.7b C4 - the tenant global search switch + go-live checklist (registered, nothing enabled by default).
  _registerGlobalSearchSettingsRoutes(app, {
    service: _createGlobalSearchSettingsService({
      db,
      prerequisites: _createGlobalSearchPrerequisites({
        db,
        rateLimitActive: opts.globalSearchRateLimitActive === true,
      }),
    }),
  });
  // WP 5.5 (ADR-0083) - list/revoke staff sessions (self-service and the security officer's variant). No tenant flag: a security control.
  const sessionDeviceService = _buildSessionDeviceService({ db, ...(opts.sessionDevices ?? {}) });
  _registerSessionDeviceRoutes(app, { service: sessionDeviceService });
  // WP 5.9 (ADR-0084) - preview and run the offboarding of a departed user; reuses the session revoke above. No tenant flag: a security control.
  if (opts.offboarding) {
    _registerOffboardingRoutes(app, {
      service: _buildOffboardingService({
        db,
        sessionDevices: sessionDeviceService,
        ...opts.offboarding,
      }),
    });
  }
  // WP 5.6 (ADR-0086) - retention overview and legal holds. No tenant flag: a compliance control.
  if (opts.retentionGovernance) {
    _registerRetentionGovernanceRoutes(app, {
      service: _createRetentionGovernanceService({ db, ...opts.retentionGovernance }),
    });
    // WP 5.6 (ADR-0055 item 7) - redaction: a two-person mask that never destroys the cipher, so a hold does not block it.
    _registerMessageRedactionRoutes(app, {
      service: _createMessageRedactionService({
        db,
        activeHolds: opts.retentionGovernance.holds.activeHolds,
        ...(opts.retentionGovernance.staffNames
          ? { staffNames: opts.retentionGovernance.staffNames }
          : {}),
        ...(opts.retentionGovernance.redactionFallback
          ? { singleOfficerFallback: opts.retentionGovernance.redactionFallback }
          : {}),
      }),
    });
  }
  // WP 5.8 (ADR-0087, PROPOSED) - break-glass: open, list, end and review a self-approved, time-limited, read-only grant on one channel.
  // Opening is behind the tenant flag `messaging.break_glass`; ending and reviewing never are (a grant that exists stays accountable).
  _registerBreakGlassRoutes(app, {
    service: _createBreakGlassService({
      db,
      outbox: opts.outbox,
      flags: opts.breakGlass?.flags,
      access: _createBreakGlassReadAccess({
        db,
        part2Gate: _createSeamPart2ChannelGate(db),
        flags: opts.breakGlass?.flags,
        holdsInvoke: opts.breakGlass?.holdsInvoke,
        isActiveUser: (tx, orgId, userId) => _isActiveMessagingUser(tx, orgId, userId),
      }),
      canViewChannel: service.canViewChannel,
    }),
  });
  // WP 5.7 (ADR-0089, PROPOSED) - restricted messaging export: request, second-person approval, requester-only expiring download. Requesting
  // is behind the tenant flag `messaging.export`; approve, reject, cancel and download never are (a job that exists stays decidable).
  if (opts.messagingExport) {
    _registerExportRoutes(app, {
      service: _createExportService({
        store: _createDrizzleExportStore(db),
        outbox: opts.outbox,
        flags: opts.messagingExport.flags,
        holds: opts.messagingExport.holds,
        artefactReader: opts.messagingExport.artefactReader,
      }),
    });
  }
  // WP 6.6 (ADR-0096, PROPOSED) - external partner share: a read-only, expiring, single-conversation grant for a non-workforce partner. Creating is
  // behind the tenant flag `messaging.external_partners`, and so is every partner route; revoking is not (a share that exists stays revocable).
  if (externalShareService) {
    _registerExternalShareRoutes(app, {
      service: externalShareService,
      partnerRoutes: opts.externalShare?.partnerAccessAvailable !== false,
    });
  }
  // WP 6.9 (ADR-0098, PROPOSED) - death-event coordination board; every route is the uniform 404 while the tenant flag is off.
  if (opts.deathBoard) _registerDeathBoardRoutes(app, opts.deathBoard);
  // GAP-165 — the platform-ops cross-tenant delivery drill (§4.1 `messaging.admin.read`): own predicate, own
  // SECURITY DEFINER reader (0474), audited per read. Not tenant-scoped, so it takes the pooled handle directly.
  _registerMessagingAdminPredicates();
  _registerAdminAlertDeliveriesRoutes(app, _buildAdminAlertDeliveriesDeps(db));
}

// WP 2.12 - ephemeral presence/typing: the composition-root binding (Valkey or in-memory store, tenant flag, route limit).
export { buildPresenceDeps } from "./presence/binding";
export { buildClinicalLinkDeps } from "./clinical-link/binding";
export { buildSbarDeps } from "./sbar/binding";
export { buildTaskDeps } from "./tasks/deps";
export { buildHandoffDeps } from "./handoffs/deps";
export { buildReviewDeps } from "./review/deps";
export { buildDeathBoardDeps } from "./death-board/deps";
export { buildMedicationQuestionDeps } from "./medication-questions/deps";
export { buildUrgentDeps } from "./urgent/deps";
export { buildAckDeps } from "./ack-requests/deps";
// WP 4.10 (ADR-0077): snooze and reminders.
export { buildSnoozeReminderBinding } from "./snooze-reminders/binding";
export {
  registerM36ReminderSweepWorker,
  scheduleM36ReminderSweepJobs,
} from "./snooze-reminders/reminder-sweep-worker";
// WP 4.4 (ADR-0070): the escalation timers - binding, BullMQ timer port and workers, and the DLQ audit recorder.
export { buildEscalationBinding } from "./ack-escalation/binding";
export { createUnreachableWatch } from "./ack-escalation/unreachable-watch";
export { createDlqAuditRecorder } from "./ack-escalation/dlq-audit";
export { createBullmqTimerPort } from "./ack-escalation/escalation-timers";
export {
  registerM36AckEscalationWorkers,
  scheduleM36AckEscalationJobs,
} from "./ack-escalation/escalation-worker";
export { buildPromotionDeps } from "./promotions/deps";
export { buildIdgDiscussionDeps } from "./idg/deps";
export { buildOnCallDirectoryDeps } from "./oncall-directory/binding";
export {
  type M36HandoffExpiryWorkerDeps,
  handoffExpiryTick,
  registerM36HandoffExpiryWorker,
  scheduleM36HandoffExpiryJobs,
} from "./handoffs/handoff-expiry-worker";
export { PRESENCE_FLAG_KEY } from "./routes/presence-routes";

// GAP-010 — M36's consumer for M3's `m3.breakglass.invoked` (durable Compliance notification).
export {
  M36_BREAKGLASS_ALERT_CONSUMER,
  buildM36BreakGlassAlertConsumer,
} from "./outbox-consumers/breakglass-alert";
// WP 6.9 (ADR-0098 D13): the hourly death-board stall sweep (an open item whose owner lost eligibility -> needs_owner + a supervisor alert).
export {
  deathBoardStallTick,
  registerM36DeathBoardStallWorker,
  scheduleM36DeathBoardStallJobs,
} from "./death-board/death-board-stall-worker";
// WP 5.8 (ADR-0087): the hourly overdue-review sweep (an open review three days after its grant ended -> one alert).
export { createBreakGlassReviewSweep } from "./break-glass/break-glass-review-sweep";
export {
  breakGlassReviewTick,
  registerM36BreakGlassReviewWorker,
  scheduleM36BreakGlassReviewJobs,
} from "./break-glass/break-glass-review-worker";
// WP 5.8 (ADR-0087): M36's own break-glass grant -> a generic in-app alert for the reviewers.
export {
  M36_BREAK_GLASS_NOTIFICATION_CONSUMER,
  buildM36BreakGlassNotificationsConsumer,
} from "./outbox-consumers/break-glass-notifications";
// WP 5.7 (ADR-0089): the restricted export's requested event -> a generic in-app alert for the approvers.
export {
  M36_EXPORT_NOTIFICATION_CONSUMER,
  buildM36ExportNotificationsConsumer,
} from "./outbox-consumers/export-notifications";
// WP 5.7 (ADR-0089): the export's event helpers (the builder and the expiry sweep publish ready / expired with them) and its reader port.
export { M36_EXPORT_EVENTS, publishExportEvent } from "./export/export-events";
export type { ExportArtefactReader, ExportArtefactRef } from "./export/export-ports";

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
  M36_ACK_QUEUE_METRICS_PLATFORM_JOB_ID,
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

// WP 2.8 — message templates & saved replies: Drizzle service + routes (the in-memory twin lives in @chartwarden/messaging).
export { createDbTemplateService } from "./templates/template-service-db";
export { registerTemplateRoutes } from "./routes/template-routes";

// WP 2.10 — polls: Drizzle service + routes (non-clinical; refused in patient-linked channels).
export { createDbPollService, pollBlockedChannelKinds } from "./polls/poll-service-db";
export type { MessagePollService } from "./polls/poll-service-db";
export { registerPollRoutes } from "./routes/poll-routes";

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
