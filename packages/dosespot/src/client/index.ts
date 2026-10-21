// @chartwarden/dosespot — the DoseSpot adapter boundary (M12-T06, spec §2.5 / §4.10 / D5). The ONLY package
// allowed to talk to DoseSpot: it owns the typed `DoseSpotClient` contract, the per-tenant circuit breaker,
// the typed `DegradedError` / `RetryableError`, the per-call backoff schedule, and the Phase-1 deny-stub.
// The live HTTP transport (`http.ts`) binds at boot with the per-tenant clinic credentials; until then the
// deny-stub keeps the draft/queue path (D11) functional. Re-exports the whole client surface.
export {
  DegradedError,
  RetryableError,
  isDegradedError,
  isRetryableError,
  type DoseSpotOperation,
} from "./errors";
export {
  DOSESPOT_CIRCUIT_BREAKER_CONFIG,
  INITIAL_BREAKER_SNAPSHOT,
  applyOutcome,
  didTransition,
  evaluateBreaker,
  openCircuitError,
  type BreakerSnapshot,
  type BreakerState,
  type DoseSpotCircuitBreakerConfig,
} from "./circuit-breaker";
export {
  DOSESPOT_RETRY_CONFIG,
  classifyRetryableStatus,
  computeBackoffDelays,
  nextRetryDecision,
  type DoseSpotRetryConfig,
} from "./retry";
export type {
  DoseSpotClient,
  DoseSpotCredentials,
  DoseSpotEpcsSessionResponse,
  DoseSpotMedHistoryItem,
  DoseSpotMedHistoryPayload,
  DoseSpotMedHistoryResponse,
  DoseSpotNewRxPayload,
  DoseSpotNewRxResponse,
  DoseSpotPatientPayload,
  DoseSpotPatientResponse,
  DoseSpotPrescriptionStatusResponse,
  DoseSpotPrescriberPayload,
  DoseSpotPrescriberResponse,
  DoseSpotRefillResponsePayload,
  DoseSpotRxBenefitPayload,
  DoseSpotRxBenefitResponse,
} from "./contract";
export { createUnboundDoseSpotClient } from "./unbound";
export {
  DOSESPOT_ENDPOINTS,
  TOKEN_ENDPOINT,
  buildPath,
  unverifiedEndpoints,
  type DoseSpotEndpoint,
  type DoseSpotEndpointName,
  type EndpointVerification,
} from "./endpoints";
export {
  DOSESPOT_TENANT_CONFIGS_ENV,
  createEnvTenantConfigResolver,
  createUnboundTenantConfigResolver,
  parseTenantConfig,
  type DoseSpotTenantConfig,
  type DoseSpotTenantConfigResolver,
} from "./tenant-config";
export { WIRE_FIELD_MAPPING_VERIFIED, phaseOfStatus, sigDirections } from "./mappers";
export {
  createHttpDoseSpotClient,
  type DoseSpotFetch,
  type HttpDoseSpotClientDeps,
} from "./http";
