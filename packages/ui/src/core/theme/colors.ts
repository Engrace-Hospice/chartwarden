// @chartwarden/ui — shared color tokens (spec §5.1 theme/colors.ts). Plain data so the leaf
// pulls no styling runtime; consumers (Tailwind, inline styles) read these tokens.

/** Semantic status colors used by the degraded-mode banner + status surfaces. */
export const statusColors = {
  operational: { fg: "#065f46", bg: "#d1fae5", border: "#6ee7b7" },
  degraded: { fg: "#92400e", bg: "#fef3c7", border: "#fcd34d" },
  outage: { fg: "#991b1b", bg: "#fee2e2", border: "#fca5a5" },
} as const;

/**
 * Brand palette seed — ChartWarden design system (docs/design/DESIGN.md §2; 2026-09-25 clinical-blue redesign).
 * `primary` / `surface` / `muted` / `border` are the keys the shared Tailwind config reads;
 * the remaining keys carry the full Lantern token set so this stays the single source of truth.
 * Light values; dark-mode values live in apps/web/src/index.css `.dark`.
 */
export const brandColors = {
  // consumed by sharedTailwindConfig
  primary: "#1a56eb", // clinical blue (2026-09-25 redesign)
  surface: "#ffffff", // card surface (surface-container-lowest)
  // WX-PR-018: muted text must hold WCAG AA 4.5:1 on every light surface (the E2E axe scan checks it);
  // #586476 holds 4.57:1 on the darkest, --color-surface-highest (see apps/web/src/index.css).
  muted: "#586476", // slate muted text
  border: "#dfe4eb", // slate hairline (outline-variant)
  // full Lantern palette
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

export const colors = { status: statusColors, brand: brandColors } as const;
