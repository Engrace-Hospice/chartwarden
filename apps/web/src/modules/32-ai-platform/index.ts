// apps/web/src/modules/32-ai-platform — M32 AI Platform tenant slice (Track A, ADR-0030, GAP-049).
//
// `AIReportButton` is the §5.5 widget consumer modules embed beside any AI-enhanced region. It is
// exported from here rather than from a `packages/ai-platform-ui` package: every consumer is a web
// module in this app, and ADR-0030 already has each module owning its own frontend slice.
export { aiPlatformScreens } from "./screens";
export { AIReportButton, type AIReportButtonProps } from "./ai-report-button";
