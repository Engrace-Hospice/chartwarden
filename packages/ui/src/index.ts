// @wardenx/ui — shared UI components delivered by M1 (Foundation spec §5.1–5.2; M1-T11).
// Module 1 has no screens of its own; it provides the cross-module UI surface every other
// module consumes: presentational components, the degraded-mode banner, context providers,
// hooks, and theme tokens. Leaf package (depends only on react) — see .dependency-cruiser
// `leaves-stay-leaves`.

// Types (view-layer mirror of M1's system-status / feature-flag wire contracts)
export type { FeatureFlags, SystemStatusComponent, SystemStatusLevel } from "./types";

// Components
export { CorrelationIdBadge } from "./components/correlation-id-badge";
export type { CorrelationIdBadgeProps } from "./components/correlation-id-badge";
export { DegradedBanner } from "./components/degraded-banner";
export { EmptyState } from "./components/empty-state";
export type { EmptyStateProps } from "./components/empty-state";
export { ErrorBoundary } from "./components/error-boundary";
export type { ErrorBoundaryProps } from "./components/error-boundary";
export { LoadingSpinner } from "./components/loading-spinner";
export type { LoadingSpinnerProps } from "./components/loading-spinner";

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

// Providers
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

// Theme
export { brandColors, colors, statusColors } from "./theme/colors";
export { sharedTailwindConfig } from "./theme/tailwind.config";
export type { SharedTailwindConfig } from "./theme/tailwind.config";
