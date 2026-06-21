// @wardenx/ui core — the platform-neutral, react-dom-free layer (ADR-0035): typed API client,
// context providers, hooks, theme tokens, and native-capability ports. Safe for the web build,
// the Capacitor native build, and a future React Native consumer. This layer may NOT import the
// web rendering layer (`../web`) — enforced by dependency-cruiser `ui-core-renderer-free`.

// Types (view-layer mirror of M1's system-status / feature-flag wire contracts)
export type { FeatureFlags, SystemStatusComponent, SystemStatusLevel } from "./types";

// API client (typed, generated from docs/api/openapi.json — ADR-0032)
export { ApiClientProvider, createApiClient, useApiClient } from "./api";
export type {
  ApiClient,
  ApiClientOptions,
  ApiClientProviderProps,
  components,
  operations,
  paths,
} from "./api";

// Providers (transport-agnostic React context — no DOM)
export { FeatureFlagProvider, useFeatureFlagContext } from "./providers/feature-flag-provider";
export type {
  FeatureFlagContextValue,
  FeatureFlagProviderProps,
} from "./providers/feature-flag-provider";
export { SocketProvider, useSocket } from "./providers/socket-provider";
export type { SocketLike, SocketProviderProps } from "./providers/socket-provider";
export { SystemStatusProvider, useSystemStatus } from "./providers/system-status-provider";
export type {
  SystemStatusContextValue,
  SystemStatusProviderProps,
} from "./providers/system-status-provider";

// Hooks
export { CorrelationIdProvider, useCorrelationId } from "./hooks/use-correlation-id";
export { useFeatureFlag } from "./hooks/use-feature-flag";
export { useIsDegraded } from "./hooks/use-system-status";

// Theme tokens (plain data — no styling runtime)
export { brandColors, colors, statusColors } from "./theme/colors";

// Native-capability ports + web adapters (ADR-0035; Capacitor adapters wired at the native entry)
export * from "./capabilities";
