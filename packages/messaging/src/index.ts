// @wardenx/messaging — Secure Messaging & Alerts (Module 36).
//
// Public surface of the package. M36-T01 ships the `channel_kind` discriminator (§2.3) and
// the type-level mirror of the §3.2 enum surface — the shared kind/enum types every later
// task builds on. M36-T04 adds the pure resolution & fan-out engine (§2.1; re-exported below).
// The Drizzle schema (M36-T02) and RLS/audit triggers (M36-T03) landed; M36-T05 adds the
// alert-payload catalog + Foundation Registry (§3.11–3.12) and the platform-default alert-rule
// seed (§3.10). The MessagingProvider/AlertEmitter seams + PHI sanitization wrapper (M36-T06),
// routes (M36-T07), realtime/jobs/webhook/cache (M36-T08), cross-module composition (M36-T09),
// and screens/eraser (M36-T10) land in their own tasks.

export { CHANNEL_KINDS, CHANNEL_KIND_DESCRIPTORS } from "./interfaces/kinds";

// ── FB-T05 message body envelope crypto (§3.4 / M36-F03) — per-tenant DEK seal/open + sha256 ───
export {
  loadMessagingKek,
  deriveOrgDek,
  sealMessageBody,
  openMessageBody,
  messageBodySha256,
  bodyEnvelopeScheme,
  sealMessageBodyRing,
  openMessageBodyRing,
  ringEnvelopeVersion,
  type BodyEnvelopeScheme,
  type RingBodyDek,
} from "./crypto";

// ── M36-T08 realtime event & room CONTRACT (§4.3) — pure room-set + sanitized event payloads ──
export {
  // room grammar + connect-time room-set computation
  accountRoom,
  userRoom,
  careTeamRoom,
  disciplineRoom,
  locationRoom,
  onCallRoom,
  fieldSafetyRoom,
  orgRoom,
  billingRoom,
  idgRoom,
  computeRoomSet,
  // event name catalogs
  MESSAGING_SERVER_EVENTS,
  MESSAGING_CLIENT_EVENTS,
  // ADR-0054 hints (PHI-free "something changed" signals)
  REALTIME_HINT_EVENT,
  buildMessageHint,
  isMessageHintOutboxEvent,
} from "./realtime";
export type {
  ConnectChannelMembership,
  MessageHintKind,
  MessageHintOutboxEvent,
  RealtimeHint,
  RoomSetInput,
  ServerEventEnvelope,
  MessageNewEvent,
  MessageEditedEvent,
  MessageDeletedEvent,
  MessageReadEvent,
  ChannelMemberEvent,
  ChannelArchivedEvent,
  PresenceUserActiveEvent,
  AlertNewEvent,
  AlertDeliveredEvent,
} from "./realtime";

// ── M36-T08 jobs (§4.4 / §4.4.1) — queue catalog + parameters + pure processors ───────────────
export {
  MESSAGING_QUEUES,
  MESSAGING_QUEUE_PARAMETERS,
  MESSAGING_JOB_SCHEDULES,
  runHashVerify,
  planRetentionDestruction,
  buildDlqAuditRecord,
  createInMemoryHashVerifyPorts,
} from "./jobs";
export type {
  QueueBackoff,
  QueueParameters,
  MessagingQueueName,
  HashVerifySampleRow,
  HashMismatchEvent,
  HashVerifyPorts,
  HashVerifyRunResult,
  RetentionCandidate,
  RetentionScanPlan,
  DlqLanding,
  DlqAuditRecord,
} from "./jobs";

// ── M36-T08 webhook security (§4.9 / SD-056 / INT-016) — replay window + signature verifiers ──
export {
  WebhookError,
  REPLAY_WINDOW_SECONDS,
  assertReplayWindow,
  computeTwilioSignature,
  verifyTwilioSignature,
  verifyPostmarkWebhook,
} from "./webhooks";
export type { TwilioVerifyRequest, PostmarkVerifyRequest } from "./webhooks";

// ── M36-T10 D9 tenant-offboarding destruction (§7.8) — DEK crypto-erase + structural delete ──
export {
  eraseTenantMessaging,
  createInMemoryMessagingEraseStore,
  DekDestroyedError,
} from "./destruction";
export type {
  MessagingEraseStore,
  MessagingEraseResult,
  MessagingEraseSeed,
  SeedMessage,
  SeedStructuralRow,
  SeedCrossTenantRow,
  InMemoryMessagingEraseStore,
} from "./destruction";

// ── M36-T08 cache & invalidation (§4.8) — key grammar + TTLs + in-memory cache ────────────────
export {
  MESSAGING_CACHE_TTL_SECONDS,
  roomMembershipKey,
  recipientResolverKey,
  recipientResolverPrefix,
  unreadCountKey,
  hashResolverArgs,
  createInMemoryMessagingCache,
} from "./cache";
export type { MessagingCache } from "./cache";

// ── M36-T06 published seam CONTRACTS (§4.6) — the surfaces every consumer imports ─────────
export type {
  MessagingProvider,
  AttachmentInput,
  MessageAttachmentView,
  ResolvedMessage,
  MessageReferenceInput,
  MessageReferenceKind,
  ResolvedMessageReference,
} from "./interfaces/provider";
export type { AlertEmitter, RecipientResolver } from "./interfaces/alert-emitter";
export type { MessageReactionPinService } from "./interfaces/reaction-pin";
export {
  SEARCH_DEFAULT_PAGE_SIZE,
  SEARCH_MAX_PAGE_SIZE,
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_MAX_SCAN_PER_REQUEST,
  SEARCH_MAX_TERMS,
  SEARCH_MIN_QUERY_LENGTH,
  assertSearchHasCriteria,
  bodyMatchesTerms,
  normalizeSearchText,
  parseSearchQuery,
  searchPageSize,
} from "./search/message-search";
export type {
  MessageSearchInput,
  MessageSearchResult,
  MessageSearchService,
} from "./search/message-search";

// ── M36-T07 route-facing application service (§4.1–4.2) — the surface the REST inventory uses ─
export type {
  MessagingRouteService,
  ChannelLastMessage,
  ChannelSummary,
  ChannelDetail,
  ChannelMemberView,
  AlertRuleView,
  AlertRulePatch,
  NotificationPreferencesView,
  NotificationPreferencesInput,
  DeliveryEndpointView,
  DeliveryEndpointInput,
  DmEligibleStaffMember,
  CareTeamConversation,
  MentionCandidate,
  MentionNonMember,
  AlertInboxItem,
  ValidatedClinicalLinkInput,
} from "./interfaces/route-service";
export {
  CLINICAL_LEAD_ROLE,
  ORG_ADMIN_ROLE,
  assertMayArchiveChannel,
  mayManageChannelMembers,
  mayManageChannelMembersResolved,
  type PatientLocationResolver,
  type MemberAdminActor,
} from "./member-admin";
// WP 2.5 server-side drafts (interface + conflict rule shared with the backend's Drizzle impl).
export {
  MAX_DRAFT_BODY_LENGTH,
  MAX_DRAFT_REFERENCES,
  assertDraftWithinLimits,
  createInMemoryDraftService,
  decideDraftSave,
  draftConflictError,
  isEmptyDraft,
  isEmptySbar,
  sbarToStore,
} from "./drafts";
export type { DraftKey, DraftView, MessageDraftService, SaveDraftInput } from "./drafts";
// WP 2.6 scheduled send (pure rules + service interface shared with the backend's Drizzle impl and dispatcher).
export {
  DEFAULT_MAX_SCHEDULED_PER_USER,
  MAX_DISPATCH_ATTEMPTS,
  MAX_SCHEDULED_BODY_LENGTH,
  MAX_SCHEDULE_HORIZON_MS,
  MIN_SCHEDULE_LEAD_MS,
  SCHEDULE_BLOCK_REASONS,
  assertScheduleTime,
  normalizeScheduleTimeZone,
  scheduleBlockReasonFor,
  scheduleBlockedMessage,
} from "./scheduled-send";
export type {
  CreateScheduledMessageInput,
  ScheduleBlockReason,
  ScheduledMessageStatus,
  ScheduledMessageView,
  ScheduledSendService,
} from "./scheduled-send";
// WP 2.9 — announcement receipts + department channels (its own service; the in-memory slice implements both).
export { RECEIPT_LIST_LIMIT } from "./interfaces/announcement-service";
export type {
  AnnouncementReader,
  AnnouncementReceiptPerson,
  AnnouncementReceiptView,
  AnnouncementService,
  CreateDepartmentChannelInput,
  DepartmentChannelKind,
} from "./interfaces/announcement-service";
export { createInMemoryMessagingService } from "./store/in-memory-service";
export type {
  InMemoryMessagingSeed,
  InMemoryMessagingServiceOptions,
} from "./store/in-memory-service";

// ── M36-T06 `AlertEmitter` seam IMPLEMENTATION (§4.6) — T04 engine wired over injected ports ─
export { createAlertEmitter, createInMemoryAlertEmitter } from "./seams";
export type {
  AlertEmitterPorts,
  EmitAlertRule,
  PersistedAlert,
  RecordedAlert,
  InMemoryAlertEmitterOptions,
} from "./seams";

// ── M36-T06 PHI sanitization wrapper (§4.7) — the only path to out-of-band channels ───────
export { sanitizeForOutOfBand, sanitizeForEmergencyContactCall } from "./notification";
export type {
  Alert,
  Message,
  SanitizedNotification,
  OutOfBandChannel,
} from "./notification";

// ── FB-T14 transactional email transport (M36-owned outbound email; DR/INT #14, Postmark) ──
export {
  selectTransactionalEmailTransport,
  createConsoleTransactionalEmailTransport,
  createNoopTransactionalEmailTransport,
} from "./notification";
export type { OutboundEmail, TransactionalEmailTransport } from "./notification";
export {
  createPostmarkTransactionalEmailTransport,
  resolvePostmarkConfig,
  postmarkConfigAttempted,
  EmailDeliveryError,
  POSTMARK_ENV,
} from "./notification";
export type {
  EmailDeliveryErrorCode,
  PostmarkConfigResult,
  PostmarkTransportOptions,
} from "./notification";

// ── M36-T05 alert-payload catalog (Foundation Registry + boot gate) — §3.11–3.12 ──────────
export {
  AlertPayloadCollisionError,
  buildAlertPayloadCatalog,
  validateAlertPayloadCatalog,
  assertAlertPayloadCatalogValid,
  isRegisteredPayloadType,
  alertPayloadCatalogRows,
  createAlertPayloadRegistry,
} from "./alert-payloads";
export type { AlertPayloadCatalogViolation, AlertPayloadRegistry } from "./alert-payloads";

// ── M36-T09 cross-module notification composition (§4.11, §3.13, ADR-0024) ─────────────────
// Composition + recipient resolution for the referral / critical-results / transmission-failure
// families moved from M14 to M36 (SD-017): load the `notification_template`, render from the
// source event payload, resolve recipients via the ADR-0024 resolvers, dispatch catalog-validated.
export {
  // template resolution + render (floor + tighten-only tenant overlay)
  resolveTemplate,
  renderTemplate,
  TemplateOverlayMismatchError,
  MissingTemplateVariableError,
  // ADR-0024 recipient resolvers (register onto M36's open registry without changing its core)
  COMPOSITION_RESOLVER_ROLE_KEYS,
  COMPOSITION_RESOLVER_NAMES,
  registerCompositionResolvers,
  // the composer + its in-memory boot/test seam
  composeAndDispatch,
  createInMemoryCrossModuleComposer,
  UnknownNotificationTemplateError,
  UnregisteredComposedPayloadError,
} from "./compose";
export type {
  NotificationTemplateRow,
  TenantTemplateOverlayRow,
  EffectiveNotificationTemplate,
  RenderedTemplate,
  CompositionResolverPorts,
  CrossModuleCompositionInput,
  ComposedDispatchRequest,
  CrossModuleCompositionResult,
  CrossModuleComposerPorts,
  RecordedComposedDispatch,
  InMemoryComposerOptions,
} from "./compose";

// ── M36-T05 platform-default alert-rule seed (§3.10) + §7.4 system_locked invariants ──────
export {
  PLATFORM_DEFAULT_ALERT_RULES,
  SYSTEM_LOCKED_EVENT_TYPES,
  toNewAlertRuleRows,
  validateAlertRuleSeed,
  assertAlertRuleSeedValid,
  // GAP-102 locked-rule tighten-only floor
  ALERT_SEVERITY_RANK,
  assertLockedRulePatchAllowed,
  isSystemLockedEventType,
  selectEffectiveAlertRules,
  // M36-T09 platform-floor notification template seed (§3.13.1 Phase C, ADR-0024)
  PLATFORM_NOTIFICATION_TEMPLATES,
  toNewNotificationTemplateRows,
  validateNotificationTemplateSeed,
  assertNotificationTemplateSeedValid,
} from "./seed";
export type {
  PlatformAlertRuleSeed,
  PlatformAlertRuleRow,
  AlertRuleSeedViolation,
  LockedRulePatch,
  EffectiveRuleRow,
  PlatformNotificationTemplateRow,
  NotificationTemplateSeedViolation,
} from "./seed";

// ── M36-T04 resolution & fan-out (§2.1) — the pure core dispatch path ─────────────────────
export {
  // recipient resolution (dynamic at emit time, §2.1.3)
  createRecipientResolverRegistry,
  resolveRecipients,
  UnknownRecipientResolverError,
  // per-recipient channel selection (§3.6)
  FLOOR_CHANNEL,
  severityAtLeast,
  preferredOutOfBandChannels,
  isVacationActive,
  localWallClock,
  isWithinQuietHours,
  suppressedByQuietHours,
  // fan-out planner + outcome roll-up (§2.4.3, §2.4.4)
  planFanOut,
  computeOutcome,
  // F-109 — the live-delivery-set roll-up `computeOutcome` never had a caller for.
  rollUpAlertOutcome,
  isTerminalDeliveryStatus,
} from "./resolution";

export type {
  ResolverArgs,
  RecipientResolverFn,
  RecipientSourcePorts,
  RoutingMap,
  QuietHoursRange,
  QuietHoursConfig,
  RecipientPreferences,
  AlertContext,
  PlannedDelivery,
  FanOutInput,
  DeliverySettlement,
  DeliveryRollupRow,
} from "./resolution";

export type {
  ChannelKind,
  ChannelKindDescriptor,
  ChannelRetentionClass,
  ChannelMembershipSource,
  ChannelSubjectRequirement,
  ChannelMemberRole,
  ChannelMemberSource,
  MessageAuthorKind,
  MessageBodyKind,
  MessageStatus,
  MessageReceiptStatus,
  PresenceStatus,
  AlertCategory,
  AlertSeverity,
  AlertRecipientResolver,
  AlertOutcome,
  SettledAlertOutcome,
  NotificationChannel,
  NotificationStatus,
  DeliveryEndpointChannel,
  DeliveryEndpointVerification,
  AlertPayloadSeverity,
} from "./interfaces/kinds";

// ── GAP-101 out-of-band dispatch (§4.4 / §4.7) + vendor-callback reconcile (§4.9) — transport seams,
//    retry/backoff policy, the per-delivery dispatch decision and the idempotent status mapping ──────
export {
  DELIVERY_CLAIM_LEASE_MS,
  DELIVERY_SWEEP_BATCH_LIMIT,
  DELIVERY_SWEEP_INTERVAL_MS,
  TRANSPORT_NOT_CONFIGURED,
  TransportError,
  backoffDelayMs,
  buildVapidAuthorization,
  canTransition,
  createDenyTransport,
  createDenyTransports,
  createFakeTransports,
  createPostmarkAlertEmailTransport,
  createTwilioSmsTransport,
  createTwilioVoiceTransport,
  createWebPushTransport,
  dispatchClaimedDelivery,
  encryptWebPushPayload,
  hasAttemptsLeft,
  mapVendorStatus,
  queueParametersFor,
  sendPostmarkEmail,
  sendTwilioSms,
} from "./dispatch";
export type {
  PostmarkAlertEmailOptions,
  TwilioSender,
  TwilioSmsOptions,
  TwilioVoiceOptions,
  VendorFetch,
  WebPushOptions,
  ClaimedDelivery,
  DispatchOutcome,
  DispatchPorts,
  FakeTransportCall,
  OutOfBandTransport,
  OutOfBandTransportChannel,
  OutOfBandTransports,
  ResolvedDestination,
  TransportSendRequest,
  TransportSendResult,
  VendorCallbackKind,
  VendorTransition,
} from "./dispatch";

// ── M36 WP 2.8 message templates & saved replies: model, PHI lint, platform seed, in-memory service ─
export * from "./templates";

// ── M36 WP 2.7b chunk C1 (ADR-0058, Proposed): pure global blind-token search foundations (tokenizer, tags, padding, cursor, key port) ─
export * from "./search/global";

// M36 WP 3.3 SBAR tenant policy
export * from "./sbar/sbar-policy";
export * from "./sbar/sbar-write";

// M36 WP 3.4 communication tasks - pure rules
export * from "./tasks";

// M36 WP 3.5 clinical handoffs - pure rules and tenant policy
export * from "./handoffs";
