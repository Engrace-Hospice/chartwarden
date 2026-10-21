// @chartwarden/ui web — Lantern token pointers for the rendering layer (R0.2, DESIGN.md §2/§3/§10).
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
  // WX-PR-022 (UI-002 follow-up from WX-PR-018's axe scan): `success` on its own 12%-tint
  // background (StatusPill) fails WCAG AA color-contrast in light mode (~3.7:1, needs 4.5:1) — a
  // darker text-only variant for that one failing case. Dark mode's `--color-success` already
  // passes comfortably (~7.35:1) so its pill-fg value is identical to `success`, not a new color.
  successPillFg: "var(--color-success-pill-fg)",
  // F-077 — the same variant for `warning`. `warning` on the shared 12% tint measures 4.59:1: it
  // passes, by 0.09, which is why no axe scan had caught it; the care-plan guard chip tinted at 14%
  // instead and measured 4.47:1, which does not. Dark mode's `--color-warning` already passes.
  warningPillFg: "var(--color-warning-pill-fg)",
  // …and for `error` / `critical`, which measured 4.0:1 / 3.35:1 on their tints in the #243 axe scans.
  errorPillFg: "var(--color-error-pill-fg)",
  alertPillFg: "var(--color-alert-pill-fg)",

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
  focusRing: "var(--color-focus-ring)",

  // On-emphasis — text/icons on a saturated brand/status fill (white in light, twilight ink in
  // dark). Scrim — modal/overlay backdrop. Both theme-reactive (§10.3 / §6.6).
  onEmphasis: "var(--color-on-emphasis)",
  scrim: "var(--color-scrim)",

  // Spacing scale (4px base, §4.1). Use for padding/gap/margin in inline styles so rhythm is
  // consistent and named, not guessed. (5→6 is the intentional 24→28px No-Line list step.)
  space1: "var(--space-1)", // 4 — tight icon gaps
  space2: "var(--space-2)", // 8 — inline element spacing
  space3: "var(--space-3)", // 12 — dense list/row padding
  space4: "var(--space-4)", // 16 — standard card padding
  space5: "var(--space-5)", // 24 — card internal sections
  space6: "var(--space-6)", // 28 — list-item separation (no divider)
  space7: "var(--space-7)", // 32 — section gaps
  space8: "var(--space-8)", // 40 — major section separation
  space9: "var(--space-9)", // 48 — page vertical rhythm

  // Type — Lantern trio (§3)
  fontDisplay: "var(--font-display)", // Manrope — titles, names, KPI labels, empty states
  fontSans: "var(--font-sans)", // Inter — body text, UI + numerals (tabular-nums)
  fontMono: "var(--font-mono)", // IBM Plex Mono — identifiers/codes

  // Radius (§4.2)
  radiusSm: "var(--radius-sm, 0.375rem)",
  radiusMd: "var(--radius-md)",
  radiusLg: "var(--radius-lg)",
  radiusXl: "var(--radius-xl)",
  radius2xl: "var(--radius-2xl)",

  // Card hairline edge + shell sidebar wash (2026-09-25 redesign)
  cardBorder: "var(--color-card-border)",
  sidebar: "var(--color-sidebar)",

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

/**
 * Card surface — white fill, hairline edge, lg radius (2026-09-25 redesign: the mockups draw every
 * card with a 1px slate border; this supersedes Lantern's borderless shadow card).
 */
export const cardSurface = {
  background: t.surfaceLowest,
  border: `1px solid ${t.cardBorder}`,
  borderRadius: t.radiusLg,
  boxShadow: t.shadowSoft,
} as const;

/**
 * Tonal tint of a status token over the card surface — for status pills/containers that read as
 * tinted, not flooded (§6.6 / §8 / §9). `pct` is the token's share (default 12%). Theme-reactive:
 * resolves against `surface-lowest`, so it stays legible in light and twilight dark.
 */
export const tint = (color: string, pct = 12): string =>
  `color-mix(in srgb, ${color} ${pct}%, ${t.surfaceLowest})`;
