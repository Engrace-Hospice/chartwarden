// apps/backend/src/modules/29-external-interfaces — the External Interfaces backend module (M29).
//
// M29-T03 lands the feed onboarding lifecycle (§2.2 `external_feed` FSM), the M40 BAA gate (D16), the
// credential rotation planner, and the MLLP listener lifecycle (§4.11: framing, per-connection ACK/NAK,
// the listener-down circuit breaker, the supervisor orchestration, and the real TLS listener registry).
// M29-T04 lands the inbound ADT domain (§4.6/§4.12): the ADT segment projection, the deterministic
// five-level patient-match cascade (D6), the cascade-outcome router, and the propose-then-review proposal
// lifecycle (§2.2/§4.1.2 — builder, decision core, review FSM) whose accept event closes the M5/M6 deny-stubs.
// M29-T05 lands the inbound ORU lab domain (§4.6 D7/D8). M29-T06 lands the outbound ORM^O01 sender (§4.12,
// W-XI-07..09): the pure ORM^O01 wire builder, the BAA-gated dispatch planner (fail-closed pre-persist), the
// ACK-correlation core (AA→transmitted / AR→failed no-retry / AE→retryable / orphan-discard), and the D9
// retry/DLQ policy — closing the M11 `hl7_orm` outbound forward-seam via `m29.lab_order.transmitted` /
// `m29.lab_order.transmission_failed`. Every core is PURE / IO-injected; the ORU/ORM ingest sinks, the seam
// bindings, and the operator/clinician routes land in T07–T09. Xero GL / Gusto payroll stay Phase-2
// (XI_ACCOUNTING_GL_FLAG OFF).
//
// M29-T08 adds the HTTP surface: the §4.1 operator routes + §4.2 clinician routes over the Drizzle route
// store (+ in-memory for tests), the twenty-one §4.7 permission keys, the six §4.8 ABAC predicates + their
// Drizzle resolver, and the five §4.4 published seams over the Drizzle published-seam store.
export {
  M29_CONTRIBUTED_PERMISSIONS,
  M29_PERMISSION_KEY_LIST,
  M29_STEP_UP_PERMISSION_KEYS,
  type M29ContributedPermissionKey,
  type M29PermissionKey,
} from "./permission-keys";
export {
  M29_ABAC_PREDICATES,
  HL7_OWNER_MODULE_WRITE_PERMISSION,
  buildM29AbacPredicates,
  denyStubM29AbacResolver,
  registerM29AbacPredicates,
  type M29AbacDeps,
  type M29AbacResolver,
  type M29RegisteredAbacPredicate,
} from "./abac-predicates";
export {
  buildDrizzleM29AbacResolver,
  type M29AbacDrizzleDeps,
  type M29CaseloadPort,
  type M29EffectivePermissionReader,
} from "./abac-resolver-drizzle";
export {
  mountM29Routes,
  createDrizzleM29Store,
  createInMemoryM29Store,
  M29StoreError,
  type M29RouteServices,
  type M29Store,
} from "./routes/index";
export {
  registerM29PublishedSeams,
  createDrizzleM29PublishedSeamStore,
  type M29PublishedSeamDeps,
  type M29PublishedSeamStore,
} from "./seams/index";
export {
  EXTERNAL_FEED_INITIAL_STATUS,
  EXTERNAL_FEED_TRANSITIONS,
  EXTERNAL_FEED_TERMINAL_STATUSES,
  externalFeedTransition,
  canExternalFeedTransition,
  externalFeedEdgeRequiresComplianceCoApproval,
  externalFeedCoApprovalSatisfied,
  externalFeedEdgeBindsListener,
  externalFeedServePosture,
} from "./feed/lifecycle";
export {
  type ExternalInterfaceBaaResult,
  type ExternalInterfaceBaaGate,
  type BaaGateRefuseReason,
  type BaaGateDecision,
  ExternalFeedBaaRefusedError,
  decideBaaGate,
  evaluateFeedActivationBaaGate,
} from "./feed/baa-gate";
export {
  EXTERNAL_FEED_CREDENTIAL_INITIAL_STATUS,
  type CredentialRotationRow,
  type CredentialRotationPlan,
  canRetireCredential,
  planCredentialRotation,
} from "./feed/credential-lifecycle";
export {
  type TlsCredentialMaterial,
  type TlsListenerRegistryDeps,
  createTlsListenerRegistry,
} from "./listener/index";
export {
  type SupervisorFeedDescriptor,
  type SupervisorAlert,
  type ListenerRegistryPort,
  type SupervisorDeps,
  type SupervisorBootSummary,
  type FeedBootOutcome,
  LISTENER_DRAIN_DEADLINE_MS,
  feedBindsInboundListener,
  bootFeedListeners,
  startFeedListener,
  handleFeedActivated,
  handleFeedStopped,
  drainAndShutdown,
} from "./listener/supervisor";
export {
  type MllpSocket,
  type MllpIngestSink,
  type MllpConnectionDeps,
  MLLP_READ_TIMEOUT_MS,
  isSenderAllowed,
  processInboundFrame,
  handleMllpConnection,
} from "./listener/connection";
export {
  MLLP_VT,
  MLLP_FS,
  MLLP_CR,
  MllpFramingError,
  MllpMshParseError,
  MllpFrameBuffer,
  type MshEnvelope,
  parseMshEnvelope,
  sha256Hex,
  encodeMllpFrame,
} from "./listener/mllp-framing";
export {
  type InboundAckDisposition,
  type BuildAckInput,
  buildAckMessage,
  buildAckFrame,
} from "./listener/ack";
export {
  type ListenerCircuitState,
  type ListenerProbeResult,
  type ListenerCircuitInput,
  type ListenerCircuitDecision,
  LISTENER_DOWN_THRESHOLD_FLOOR_MS,
  evaluateListenerCircuit,
} from "./listener/circuit-breaker";

// ── M29-T04: inbound ADT — projection · match cascade · outcome routing · proposal lifecycle ─────────────
export {
  type Hl7Separators,
  type AdtIdentifier,
  type AdtAddress,
  type AdtPatientCandidate,
  type AdtVisitContext,
  type ProjectedAdt,
  HL7_DEFAULT_SEPARATORS,
  splitSegments,
  readSeparators,
  hl7DateToIso,
  extractSsnLast4,
  projectAdt,
} from "./inbound/hl7-adt-projection";
export {
  type MatchOutcome,
  type CascadePid,
  type CascadeInput,
  type CascadeLog,
  type CascadeDeps,
  L4_CONFIDENCE,
  L5_CONFIDENCE,
  isValidSsnLast4,
  matchPatient,
} from "./inbound/match-cascade";
export {
  type CascadeMessageContext,
  type CascadeMessageProjection,
  type CascadeResolvedConfidentPayload,
  type CascadeResolvedCandidatePayload,
  type CascadeNoMatchPayload,
  type CascadeResolvedEvent,
  projectCascadeForMessage,
  routeCascadeOutcome,
} from "./inbound/outcome-router";
export {
  type AdtMessageType,
  type NoMatchBehavior,
  type MessageTypeRouting,
  MESSAGE_TYPE_ROUTING,
  isSupportedAdt,
} from "./proposals/message-type-routing";
export {
  type ProposalCreatedPayload,
  type RoutingDroppedPayload,
  type ProposalPlan,
  type BuildProposalInput,
  planProposal,
} from "./proposals/proposal-builder";
export {
  HL7_INBOUND_PROPOSAL_INITIAL_STATUS,
  HL7_INBOUND_PROPOSAL_TERMINAL_STATUSES,
  HL7_INBOUND_PROPOSAL_TRANSITIONS,
  hl7InboundProposalTransition,
  canHl7InboundProposalTransition,
  canDecideProposal,
  hl7ProposalReviewPosture,
} from "./proposals/lifecycle";
export {
  type ProposalSnapshot,
  type AcceptCommand,
  type RejectCommand,
  type DeferCommand,
  type ProposalDecisionCommand,
  type ProposalDecisionUpdate,
  type ProposalAcceptedPayload,
  type ProposalRejectedPayload,
  type ProposalExpiredPayload,
  type ProposalDecisionResult,
  ProposalAlreadyDecidedError,
  ProposalRejectRationaleRequiredError,
  decideProposal,
  expireProposal,
} from "./proposals/decision";

// ── M29-T05: inbound ORU labs — projection · terminology · SUD · abnormal · resolve · attach planning ─────
export {
  type ProjectedObr,
  type ProjectedObx,
  type ProjectedOru,
  projectOru,
} from "./inbound/hl7-oru-projection";
export {
  mapAbnormalFlag,
  selectValueFlag,
  isCriticalFlagSet,
  computeAbnormalSummary,
} from "./inbound/lab-abnormal";
export {
  type LabTerminologyPort,
  type TerminologyCheckInput,
  classifyObservationTerminology,
} from "./inbound/lab-terminology";
export {
  type LabSudTerminologyPort,
  type LabConsentPort,
  type LabSudDecision,
  type LabSudInput,
  type LabSudDeps,
  decideLabSudRedaction,
} from "./inbound/lab-sud-redaction";
export {
  type LabOrderPort,
  type LabPatientResolution,
  type LabResolveInput,
  type LabResolveDeps,
  resolveLabPatient,
} from "./inbound/lab-patient-resolver";
export {
  OBX_ENCAPSULATED_DATA_TYPE,
  type ExtractedPdf,
  decodeEncapsulatedPdf,
  extractPdfAttachments,
} from "./inbound/obx-pdf";
export {
  SUD_REDACTED_SENTINEL,
  type LabReceivedPayload,
  type LabAttachedPayload,
  type LabAbnormalFlagPayload,
  type LabUnmatchedPayload,
  type LabPdfHandshakePayload,
  type LabOutboxEvent,
  type LabAttachPlan,
  type LabAttachInput,
  planLabAttach,
} from "./inbound/lab-attach-planner";

// ── M29-T06: outbound ORM — ORM^O01 builder · dispatch planning · ACK correlation · retry/DLQ policy ──────
export {
  type OrmEndpoint,
  type BuildOrmInput,
  type OrmSegmentSummary,
  escapeHl7,
  isoDateToHl7,
  isoToHl7Timestamp,
  buildOrmO01,
  summarizeSegments,
} from "./outbound/orm-o01";
export {
  type LabOrderTransmittedPayload,
  type LabOrderTransmissionFailureReason,
  type LabOrderTransmissionFailedPayload,
  type OutboundOutboxEvent,
  type OutboundAlert,
  type OutboundAuditRecord,
} from "./outbound/outbound-events";
export {
  ORM_SOURCE_KIND,
  type OutboundRowDraft,
  type OutboundDispatchInput,
  type OutboundDispatchPlan,
  outboundIdempotencyKey,
  planOutboundDispatch,
} from "./outbound/dispatch-planner";
export {
  type ParsedAck,
  type CorrelatedOutboundRow,
  type AckStatusUpdate,
  type AckCorrelationInput,
  type AckCorrelationResult,
  parseAckMsa,
  correlateAck,
} from "./outbound/ack-correlation";
export {
  OUTBOUND_MAX_ATTEMPTS,
  OUTBOUND_BACKOFF_MS,
  type RetryOutboundRow,
  type RetryDecisionInput,
  type RetryStatusUpdate,
  type RetryDecision,
  decideRetry,
} from "./outbound/retry-policy";

// ── M29-T07: NPPES sync — Luhn validate · API projection · rate limiter · client · cache diff · orchestrator ─
export { isValidNpi } from "./nppes/npi-validate";
export {
  type NppesIndividualProvider,
  type NppesBasic,
  type NppesAddress,
  type NppesTaxonomy,
  type NppesIdentifier,
  type NppesFetchResult,
  type NppesApiResponse,
  type NppesApiRawResult,
  classifyNppesResponse,
  projectProvider,
  primaryTaxonomyCode,
} from "./nppes/response-projection";
export { RateLimiter, type RateLimiterConfig } from "./nppes/rate-limiter";
export {
  NppesClient,
  RetryableHttpError,
  type NppesClientConfig,
  type NppesFetchPort,
  type HttpFetch,
  type HttpFetchInit,
  type HttpFetchResponse,
} from "./nppes/nppes-client";
export {
  type NppesProviderSnapshot,
  type ProviderSyncedPayload,
  type ProviderDeactivatedPayload,
  type SyncRunStartedPayload,
  type SyncRunCompletedPayload,
  type SyncRunFailedPayload,
  type NppesOutboxEvent,
  type NppesOutboxSink,
} from "./nppes/sync-events";
export {
  type CachedProviderView,
  type CacheUpsertDecision,
  type ProviderCachePort,
  decideCacheUpsert,
  toSnapshot,
  buildProviderRow,
} from "./nppes/provider-cache";
export {
  NPPES_CIRCUIT_BREAKER_CONSECUTIVE_FAILURES,
  NPPES_CHECKPOINT_EVERY,
  NppesTenantTriggerRefusedError,
  type NppesTriggerScope,
  type NppesSyncRequest,
  type NppesNpiSourcePort,
  type SyncRunCounts,
  type NppesSyncRunStorePort,
  type SyncOrchestratorDeps,
  type SyncResult,
  NppesSyncOrchestrator,
} from "./nppes/sync-orchestrator";
export { NPPES_SYNC_SCHEDULE, type NppesSyncSchedule } from "./nppes/schedule";
