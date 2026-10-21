// @chartwarden/iqies-client — the M10 iQIES adapter package (D6, spec §4.10 / §4.10.1). The ONLY package
// allowed to talk to iQIES: it owns the CMS HOPE submission envelope model, the per-PE circuit breaker,
// the typed `DegradedError`, the MinIO envelope-storage convention, and the typed adapter contract that
// M10's submission workers consume. M10-T07 lands the typed surface + pure logic + the Phase-1 deny-stub
// (`createUnboundIqiesAdapter`); the live transport (`transport.ts`) binds with M34's per-tenant submitter
// credentials. No HTTP client is imported here yet — the contract is what M10 depends on.
export { DegradedError, isDegradedError, type IqiesOperation } from "./errors";
export {
  IQIES_CIRCUIT_BREAKER_CONFIG,
  INITIAL_BREAKER_SNAPSHOT,
  applyOutcome,
  evaluateBreaker,
  openCircuitError,
  type BreakerSnapshot,
  type BreakerState,
  type IqiesCircuitBreakerConfig,
} from "./circuit-breaker";
export {
  assembleEnvelopeCanonical,
  envelopeSha256,
  type HopeEnvelopeItem,
  type HopeSubmissionEnvelope,
} from "./envelope";
export { IQIES_ENVELOPE_OBJECT_LOCK, buildEnvelopeStorageUri } from "./storage";
export {
  createUnboundIqiesAdapter,
  type AcceptanceItemOutcome,
  type AcceptanceReport,
  type IqiesAdapter,
  type SubmitBatchRequest,
  type SubmitBatchResult,
  type SubmitCorrectionRequest,
  type SubmitCorrectionResult,
} from "./adapter";
