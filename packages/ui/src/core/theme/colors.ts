// @wardenx/ui — shared color tokens (spec §5.1 theme/colors.ts). Plain data so the leaf
// pulls no styling runtime; consumers (Tailwind, inline styles) read these tokens.

/** Semantic status colors used by the degraded-mode banner + status surfaces. */
export const statusColors = {
  operational: { fg: "#065f46", bg: "#d1fae5", border: "#6ee7b7" },
  degraded: { fg: "#92400e", bg: "#fef3c7", border: "#fcd34d" },
  outage: { fg: "#991b1b", bg: "#fee2e2", border: "#fca5a5" },
} as const;

/**
 * Brand palette seed — WardenX "Lantern" design system (docs/design/DESIGN.md §2).
 * `primary` / `surface` / `muted` / `border` are the keys the shared Tailwind config reads;
 * the remaining keys carry the full Lantern token set so this stays the single source of truth.
 * Light values; dark-mode values live in apps/web/src/index.css `.dark`.
 */
export const brandColors = {
  // consumed by sharedTailwindConfig
  primary: "#3b45a8", // twilight indigo
  surface: "#ffffff", // card surface (surface-container-lowest)
  // WX-PR-018: was #8c877f (~3.57:1 on white — fails WCAG AA 4.5:1 for normal-weight text, caught
  // by the E2E suite's axe scan on the nav-group toggle buttons). #726d64 keeps the warm-gray hue
  // while giving ~5.1:1 against --color-surface-lowest.
  muted: "#726d64", // warm muted text
  border: "#d7d3cb", // warm ghost border (outline-variant)
  // full Lantern palette
  primaryStrong: "#2b338a",
  primaryTint: "#ecedfb",
  accent: "#c98a1f", // Lantern gold — brand warmth only, never status
  success: "#1f8a5b",
  warning: "#9a5b00",
  error: "#c12b3b",
  alert: "#e0413f", // critical clinical/safety
  background: "#f6f5f2", // warm paper canvas
  onSurface: "#1c1b1a",
  onSurfaceVariant: "#56524c",
  outline: "#6e6a62",
} as const;

export const colors = { status: statusColors, brand: brandColors } as const;
