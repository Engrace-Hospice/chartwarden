// @chartwarden/ui core — the platform-neutral, react-dom-free layer (ADR-0035): typed API client,
// context providers, hooks, theme tokens, and native-capability ports. Safe for the web build,
// the Capacitor native build, and a future React Native consumer. This layer may NOT import the
// web rendering layer (`../web`) — enforced by dependency-cruiser `ui-core-renderer-free`.

// Types (view-layer mirror of M1's system-status / feature-flag wire contracts)
export type { FeatureFlags, SystemStatusComponent, SystemStatusLevel } from "./types";

// API client (typed, generated from docs/api/openapi.json — ADR-0032)
export {
  ApiClientProvider,
  BACKGROUND_REQUEST_HEADERS,
  createApiClient,
  useApiClient,
} from "./api";
export type {
  ApiClient,
  ApiClientOptions,
  ApiClientProviderProps,
  components,
  operations,
  paths,
} from "./api";
// The M22 verified-upload ceremony (hash, reserve, PUT, commit, abort), shared by every module that files a document.
export {
  abortUpload,
  completeUpload,
  initiateUpload,
  putUploadBytes,
  sha256Hex,
  writeFailure,
} from "./api";
export type {
  CompleteUploadResult,
  InitiateUploadBody,
  InitiateUploadResult,
  UploadMimeType,
  WriteResult,
} from "./api";

// Providers (transport-agnostic React context — no DOM)
export { FeatureFlagProvider, useFeatureFlagContext } from "./providers/feature-flag-provider";
export type {
  FeatureFlagContextValue,
  FeatureFlagProviderProps,
} from "./providers/feature-flag-provider";
export { SystemStatusProvider, useSystemStatus } from "./providers/system-status-provider";
export type {
  SystemStatusContextValue,
  SystemStatusProviderProps,
} from "./providers/system-status-provider";

// Hooks
export { CorrelationIdProvider, useCorrelationId } from "./hooks/use-correlation-id";
export { useFeatureFlag } from "./hooks/use-feature-flag";
export { useIsDegraded } from "./hooks/use-system-status";
// In-memory search-needle hand-off — PHI must never ride in the URL (GAP-080).
export {
  __resetSearchTermForTest,
  clearSearchTerm,
  setSearchTerm,
  useSearchTerm,
} from "./hooks/use-search-term";

// Platform-ops writes (2026-11 tenant onboarding): the reason an operator gives, what a refusal means, one Idempotency-Key per attempt
export { REASON_RULES, checkReason, normalizeReason } from "./ops-write/reason";
export type { ReasonRule } from "./ops-write/reason";
export { describeOpsError } from "./ops-write/ops-error";
export type {
  OpsErrorCopy,
  OpsErrorDetail,
  OpsFailure,
  OpsFailureKind,
} from "./ops-write/ops-error";
export { createIdempotencyKeeper, useIdempotencyKeeper } from "./ops-write/idempotency";
export type { IdempotencyKeeper } from "./ops-write/idempotency";
export { AFTER_SUCCESS_TIMEOUT_MS, useOpsWrite } from "./ops-write/use-ops-write";
// Money and counts an operator types, parsed by string math (no float multiply, no "1e3" or "0x1f")
export { hundredthsText, parseHundredths, parsePriceCents, parseWholeNumber } from "./money";
export type { OpsWrite, OpsWriteOutcome } from "./ops-write/use-ops-write";

// Theme tokens (plain data — no styling runtime)
export { brandColors } from "./theme/colors";

// Date-only helpers (PARAM-004 — local-calendar parsing, never a UTC-instant off-by-one)
export {
  ageYears,
  formatDateOnly,
  isoToLocalInput,
  localInputToIso,
  nowLocalInput,
  parseLocalDateOnly,
  toLocalInput,
} from "./dates";

// API error envelope -> the server's own message (#596)
export { envelopeErrorMessage } from "./error-message";

// Short-lived minted links (signed download/stream URLs): https only, dropped when they expire.
export { LINK_FLOOR_MS, linkLifetimeMs, safeMintedUrl } from "./minted-link";

// Display-only fallback for internal enum/event identifiers when no product label is available.
export { humanizeIdentifier } from "./humanize-identifier";

// Native-capability ports + web adapters (ADR-0035; Capacitor adapters wired at the native entry)
export * from "./capabilities";
