// apps/backend/src/modules/29-external-interfaces — the External Interfaces backend module (M29).
//
// M29-T03 lands the feed onboarding lifecycle (§2.2 `external_feed` FSM), the M40 BAA gate (D16), the
// credential rotation planner, and the MLLP listener lifecycle (§4.11: framing, per-connection ACK/NAK,
// the listener-down circuit breaker, the supervisor orchestration, and the real TLS listener registry).
// Every core is PURE / IO-injected; the ADT/ORU/ORM ingest sinks, the seam bindings, and the operator/
// clinician routes land in T04–T09. Xero GL / Gusto payroll stay Phase-2 (XI_ACCOUNTING_GL_FLAG OFF).
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
