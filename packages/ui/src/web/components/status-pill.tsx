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
  // fg uses the pill-safe darker variant (WX-PR-022) — WCAG AA contrast against this tinted bg;
  // `bg` still tints from the raw `t.success` token, unaffected.
  success: { fg: t.successPillFg, bg: tint(t.success), glyph: "check-circle" },
  progress: { fg: t.primary, bg: t.primaryTint, glyph: "dot" },
  warning: { fg: t.warning, bg: tint(t.warning), glyph: "clock" },
  error: { fg: t.error, bg: tint(t.error), glyph: "block" },
  critical: { fg: t.alert, bg: tint(t.alert), glyph: "alert" },
  neutral: { fg: t.onSurfaceVariant, bg: t.surfaceContainer, glyph: "dot" },
};

export interface StatusPillProps {
  label: ReactNode;
  tone: StatusTone;
  /** Override the default glyph for the tone. */
  glyph?: GlyphName;
}

/** A status pill — radius-full, label-md, color + glyph partner (§6.6). */
export function StatusPill({ label, tone, glyph }: StatusPillProps): JSX.Element {
  const meta = TONE[tone];
  return (
    <span
      className="wx-status-pill"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3rem",
        padding: "0.2rem 0.6rem",
        borderRadius: "9999px",
        background: meta.bg,
        color: meta.fg,
        fontFamily: t.fontSans,
        fontSize: "0.75rem",
        fontWeight: 600,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      <Glyph name={glyph ?? meta.glyph} size={13} />
      {label}
    </span>
  );
}
