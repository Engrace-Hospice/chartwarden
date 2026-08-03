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
export { ErrorState } from "./components/error-state";
export type { ErrorStateProps } from "./components/error-state";
export { LoadingSpinner } from "./components/loading-spinner";
export type { LoadingSpinnerProps } from "./components/loading-spinner";
export { NavGroup, NavLink, groupByNavGroup } from "./components/nav-link";
export type { NavGroupProps, NavLinkProps } from "./components/nav-link";
export { StatusPill } from "./components/status-pill";
export type { StatusPillProps, StatusTone } from "./components/status-pill";

// Layout kit — Tier-1 regions + foundational pattern layouts (ADR-0030, WARDENX_UI_LAYOUT_PATTERNS.md)
export * from "./layouts";

// WardenX system primitives (R0.3, DESIGN.md §7–§9) — the Guardrail / Sensitivity / Provenance
// systems that define WardenX, as reusable components mapped 1:1 to the D1–D3 boards.
export {
  BlockingDialog,
  CeremonyModal,
  CountdownChip,
  GateStepper,
  GuardChip,
} from "./system/guardrail";
export type {
  BlockingDialogProps,
  CeremonyModalProps,
  CountdownChipProps,
  GateItem,
  GateStatus,
  GateStepperProps,
  GuardChipProps,
} from "./system/guardrail";
export {
  BreakGlassBanner,
  ConsentBadge,
  MaskedIdentifier,
  maskTail,
  SealedBlock,
} from "./system/sensitivity";
export type {
  BreakGlassBannerProps,
  ConsentBadgeProps,
  MaskedIdentifierProps,
  SealedBlockProps,
} from "./system/sensitivity";
export { AiSuggestionCard, DerivedBadge } from "./system/provenance";
export type { AiSuggestionCardProps, DerivedBadgeProps } from "./system/provenance";
export { Glyph } from "./system/glyphs";
export type { GlyphName, GlyphProps } from "./system/glyphs";
export { ConfirmDialog } from "./system/confirm-dialog";
export type { ConfirmDialogProps } from "./system/confirm-dialog";
// The focus-trapped modal shell (UI-005) — exported so callers build their own dialogs on it
// instead of hand-rolling a scrim+panel (the ≥9 module copies this task migrates); ConfirmDialog and
// the Guardrail ceremonies above already compose it.
export { Modal } from "./system/modal";
export type { ModalProps } from "./system/modal";
export { ToastProvider, useToast } from "./system/toast";
export type { ToastContextValue, ToastOptions, ToastTone } from "./system/toast";

// Theme — web-only Tailwind seed (consumes core color tokens)
export { sharedTailwindConfig } from "./theme/tailwind.config";
export type { SharedTailwindConfig } from "./theme/tailwind.config";
// Theme — Lantern token pointers (CSS-var references) + No-Line helpers (R0.2, DESIGN.md §2/§3/§10)
export { cardSurface, ghostBorder, t } from "./theme/tokens";
