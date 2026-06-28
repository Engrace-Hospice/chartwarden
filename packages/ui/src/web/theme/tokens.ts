// @wardenx/ui web — Lantern token pointers for the rendering layer (R0.2, DESIGN.md §2/§3/§10).
//
// These are *CSS custom-property references*, not hex. The runtime values come from the consuming
// app's Lantern stylesheet (apps/web/src/index.css `@theme` + `.dark`), so a component styled with
// `t.onSurfaceVariant` follows the active theme — including the designed twilight dark mode — by
// construction, and never hardcodes a color. The web layer may import core, but colors.ts holds
// raw hex for the JS-config/status path; the rendering layer points at the CSS vars instead so it
// stays theme-reactive. Keep this the single place the layout kit reaches for tokens.

export const t = {
  // Brand
  primary: "var(--color-primary)",
  primaryStrong: "var(--color-primary-strong)",
  primaryTint: "var(--color-primary-tint)",
  onPrimary: "var(--color-on-primary)",
  accent: "var(--color-accent)",
  accentTint: "var(--color-accent-tint)",

  // Semantic status (also mirrored as the statusColors triad in core/theme/colors.ts)
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  error: "var(--color-error)",
  alert: "var(--color-alert)",

  // Surfaces — warm paper hierarchy (§2.5)
  background: "var(--color-background)",
  surface: "var(--color-surface)",
  surfaceLowest: "var(--color-surface-lowest)", // cards / primary content
  surfaceLow: "var(--color-surface-low)", // zebra, secondary sectioning, input rest
  surfaceContainer: "var(--color-surface-container)", // default container, hover
  surfaceHigh: "var(--color-surface-high)",
  surfaceHighest: "var(--color-surface-highest)",

  // Text & line (§2.6)
  onSurface: "var(--color-on-surface)",
  onSurfaceVariant: "var(--color-on-surface-variant)",
  muted: "var(--color-muted)",
  outline: "var(--color-outline)",
  outlineVariant: "var(--color-outline-variant)",

  // On-emphasis — text/icons on a saturated brand/status fill (white in light, twilight ink in
  // dark). Scrim — modal/overlay backdrop. Both theme-reactive (§10.3 / §6.6).
  onEmphasis: "var(--color-on-emphasis)",
  scrim: "var(--color-scrim)",

  // Type — Lantern trio (§3)
  fontDisplay: "var(--font-display)", // Fraunces — names, titles, KPI labels, empty states
  fontSans: "var(--font-sans)", // Inter — all functional text + numerals (tabular-nums)
  fontMono: "var(--font-mono)", // IBM Plex Mono — identifiers/codes

  // Radius (§4.2)
  radiusSm: "var(--radius-sm, 0.375rem)",
  radiusMd: "var(--radius-md)",
  radiusLg: "var(--radius-lg)",
  radiusXl: "var(--radius-xl)",
  radius2xl: "var(--radius-2xl)",

  // Elevation (§4.3)
  shadowSoft: "var(--shadow-soft)",
  shadowFloat: "var(--shadow-float)",
  shadowAmbient: "var(--shadow-ambient)",
} as const;

/**
 * Ghost border — Hard Rule §10.3. Boundaries are tonal; where an edge is genuinely required for
 * scanning/a11y, use `outline-variant` at ≤15% opacity, never an opaque 1px line. Prefer a tonal
 * surface shift (e.g. a card on `surfaceLowest` over `background`) where one will do.
 */
export const ghostBorder = `1px solid color-mix(in srgb, ${t.outlineVariant} 15%, transparent)`;

/** Lantern card surface — No-Line: surface-lowest fill + soft shadow + xl radius, no border. */
export const cardSurface = {
  background: t.surfaceLowest,
  borderRadius: t.radiusXl,
  boxShadow: t.shadowSoft,
} as const;

/**
 * Tonal tint of a status token over the card surface — for status pills/containers that read as
 * tinted, not flooded (§6.6 / §8 / §9). `pct` is the token's share (default 12%). Theme-reactive:
 * resolves against `surface-lowest`, so it stays legible in light and twilight dark.
 */
export const tint = (color: string, pct = 12): string =>
  `color-mix(in srgb, ${color} ${pct}%, ${t.surfaceLowest})`;
