// apps/backend/src/modules/29-external-interfaces — the External Interfaces backend module (M29).
//
// M29-T03 lands the feed onboarding lifecycle (§2.2 `external_feed` FSM), the M40 BAA gate (D16), the
// credential rotation planner, and the MLLP listener lifecycle (§4.11: framing, per-connection ACK/NAK,
// the listener-down circuit breaker, the supervisor orchestration, and the real TLS listener registry).
// M29-T04 lands the inbound ADT domain (§4.6/§4.12): the ADT segment projection, the deterministic
// five-level patient-match cascade (D6), the cascade-outcome router, and the propose-then-review proposal
// lifecycle (§2.2/§4.1.2 — builder, decision core, review FSM) whose accept event closes the M5/M6 deny-stubs.
// Every core is PURE / IO-injected; the ORU/ORM ingest sinks, the seam bindings, and the operator/clinician
// routes land in T05–T09. Xero GL / Gusto payroll stay Phase-2 (XI_ACCOUNTING_GL_FLAG OFF).
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
