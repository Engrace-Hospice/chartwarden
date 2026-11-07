// @chartwarden/ui — shared color tokens (spec §5.1 theme/colors.ts). Plain data so the leaf
// pulls no styling runtime. `arch:design-tokens` checks every hex here against the @theme block of
// apps/web/src/index.css.

/**
 * Brand palette seed — ChartWarden design system (docs/design/DESIGN.md §2; 2026-09-25 clinical-blue redesign).
 * Light values; dark-mode values live in apps/web/src/index.css `.dark`.
 */
export const brandColors = {
  primary: "#1a56eb", // clinical blue (2026-09-25 redesign)
  surface: "#ffffff", // card surface (surface-container-lowest)
  // WX-PR-018: muted text must hold WCAG AA 4.5:1 on every light surface (the E2E axe scan checks it);
  // #586476 holds 4.57:1 on the darkest, --color-surface-highest (see apps/web/src/index.css).
  muted: "#586476", // slate muted text
  border: "#dfe4eb", // slate hairline (outline-variant)
  primaryStrong: "#1443c6",
  primaryTint: "#e6edfd",
  accent: "#d97706", // warm amber — brand warmth only, never status
  success: "#16a34a",
  warning: "#b45309",
  error: "#dc2626",
  alert: "#e5484d", // critical clinical/safety
  background: "#f7f8fa", // cool slate canvas
  onSurface: "#0f172a",
  onSurfaceVariant: "#475569",
  outline: "#94a3b8",
} as const;
