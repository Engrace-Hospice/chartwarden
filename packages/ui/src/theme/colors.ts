// @wardenx/ui — shared color tokens (spec §5.1 theme/colors.ts). Plain data so the leaf
// pulls no styling runtime; consumers (Tailwind, inline styles) read these tokens.

/** Semantic status colors used by the degraded-mode banner + status surfaces. */
export const statusColors = {
  operational: { fg: "#065f46", bg: "#d1fae5", border: "#6ee7b7" },
  degraded: { fg: "#92400e", bg: "#fef3c7", border: "#fcd34d" },
  outage: { fg: "#991b1b", bg: "#fee2e2", border: "#fca5a5" },
} as const;

/** Brand palette seed (extended per app via the shared Tailwind config). */
export const brandColors = {
  primary: "#1d4ed8",
  surface: "#ffffff",
  muted: "#6b7280",
  border: "#e5e7eb",
} as const;

export const colors = { status: statusColors, brand: brandColors } as const;
