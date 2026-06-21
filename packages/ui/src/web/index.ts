// @wardenx/ui web — the React DOM rendering layer (ADR-0035): presentational components and
// the layout kit. May import `../core`; `../core` may never import here (dependency-cruiser
// `ui-core-renderer-free`). A React Native consumer would replace this layer, not reuse it.

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

// Layout kit — Tier-1 regions + foundational pattern layouts (ADR-0030, WARDENX_UI_LAYOUT_PATTERNS.md)
export * from "./layouts";

// Theme — web-only Tailwind seed (consumes core color tokens)
export { sharedTailwindConfig } from "./theme/tailwind.config";
export type { SharedTailwindConfig } from "./theme/tailwind.config";
