// @wardenx/ui — Status Pill (R1, DESIGN.md §6.6 badge taxonomy). Every status pill pairs a color
// with a glyph or text so it survives color-blindness and grayscale print (Hard Rule §10.10).
// Canonical lifecycles (patient / claim / order-visit / document-render) render with this taxonomy;
// modules map their domain status → a tone, then render <StatusPill>.
import type { JSX, ReactNode } from "react";
import { Glyph, type GlyphName } from "../system/glyphs";
import { t, tint } from "../theme/tokens";

export type StatusTone =
  | "success" // complete / posted / accepted
  | "progress" // in-progress / pending / submitted
  | "warning" // due-soon / needs-attention
  | "error" // failed / denied / rejected
  | "critical" // safety / controlled
  | "neutral"; // draft / closed / inactive

const TONE: Record<StatusTone, { fg: string; bg: string; glyph: GlyphName }> = {
  // fg uses the pill-safe darker variants (WX-PR-022, F-077, #243) — WCAG AA against the tinted bg;
  // `bg` still tints from the raw `t.success` token, unaffected.
  success: { fg: t.successPillFg, bg: tint(t.success), glyph: "check-circle" },
  progress: { fg: t.primary, bg: t.primaryTint, glyph: "dot" },
  warning: { fg: t.warningPillFg, bg: tint(t.warning), glyph: "clock" },
  error: { fg: t.errorPillFg, bg: tint(t.error), glyph: "block" },
  critical: { fg: t.alertPillFg, bg: tint(t.alert), glyph: "alert" },
  neutral: { fg: t.onSurfaceVariant, bg: t.surfaceContainer, glyph: "dot" },
};

export interface StatusPillProps {
  label: ReactNode;
  tone: StatusTone;
  /** Opt-in glyph partner. The redesign's pills are text-only (the label carries the meaning, so
   *  color is never the sole signal — §10.10); pass a glyph where a pill needs one. */
  glyph?: GlyphName;
}

/** A status pill — tinted, md radius, text label (+ optional glyph) (§6.6, 2026-09-25 redesign). */
export function StatusPill({ label, tone, glyph }: StatusPillProps): JSX.Element {
  const meta = TONE[tone];
  return (
    <span
      className="wx-status-pill"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3rem",
        padding: "0.15rem 0.55rem",
        borderRadius: t.radiusSm,
        background: meta.bg,
        color: meta.fg,
        fontFamily: t.fontSans,
        fontSize: "0.75rem",
        fontWeight: 500,
        lineHeight: 1.45,
        whiteSpace: "nowrap",
      }}
    >
      {glyph ? <Glyph name={glyph} size={13} /> : null}
      {label}
    </span>
  );
}
