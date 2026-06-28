// @wardenx/ui web — Provenance & AI Governance Layer (R0.3, DESIGN.md §9 — WardenX-defining).
// "The assistant suggests; the clinician decides." AI-suggested content is always marked, cited,
// and never committed without a human action; system-derived content is a quiet factual chip.
// Token-driven + No-Line; the AI halo uses the @keyframes wx-ai-pulse defined in index.css.
import type { JSX, ReactNode } from "react";
import { t, tint } from "../theme/tokens";
import { Glyph } from "./glyphs";

// ────────────────────────────────────────────────────────────────────────────
// §9 AI-suggested (needs review) — success-tinted container + soft halo + provenance line +
// Accept / Edit / Dismiss + a citation back to source. Nothing AI-authored commits without a human.
// ────────────────────────────────────────────────────────────────────────────
export interface AiSuggestionCardProps {
  /** The suggested content under review. */
  children: ReactNode;
  /** Model that produced the suggestion (provenance line). */
  model: ReactNode;
  /** Confidence, e.g. 0.92 or "high". Rendered as a percentage when numeric ≤ 1. */
  confidence?: number | string;
  /** Citation back to the grounding source. */
  citation?: { label: ReactNode; href?: string; onClick?: () => void };
  onAccept?: () => void;
  onEdit?: () => void;
  onDismiss?: () => void;
  /** Drop the pulsing halo (e.g. reduced-motion contexts or dense lists). */
  staticHalo?: boolean;
}
function formatConfidence(c: number | string | undefined): string | null {
  if (c === undefined) return null;
  if (typeof c === "string") return c;
  return c <= 1 ? `${Math.round(c * 100)}% confidence` : `${c}`;
}
export function AiSuggestionCard({
  children,
  model,
  confidence,
  citation,
  onAccept,
  onEdit,
  onDismiss,
  staticHalo = false,
}: AiSuggestionCardProps): JSX.Element {
  const conf = formatConfidence(confidence);
  return (
    <section
      className={staticHalo ? "wx-ai-card" : "wx-ai-card wx-ai-halo"}
      aria-label="AI suggestion"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        padding: "1rem 1.25rem",
        borderRadius: t.radiusXl,
        background: tint(t.success, 8),
        boxShadow: `0 0 0 1px ${tint(t.success, 30)}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: t.success }}>
        <Glyph name="sparkle" size={18} label="AI suggestion" />
        <strong style={{ fontFamily: t.fontSans, fontSize: "0.8125rem", fontWeight: 600 }}>AI suggestion</strong>
        <span style={{ marginLeft: "auto", fontSize: "0.6875rem", color: t.onSurfaceVariant, fontWeight: 500 }}>
          suggestion — review before relying
        </span>
      </div>

      <div style={{ color: t.onSurface, fontSize: "0.875rem" }}>{children}</div>

      {/* Provenance line — model · confidence. */}
      <div style={{ fontSize: "0.75rem", color: t.onSurfaceVariant, display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
        <span>{model}</span>
        {conf ? <span>· {conf}</span> : null}
      </div>

      {citation ? (
        <a
          href={citation.href ?? "#"}
          onClick={
            citation.onClick
              ? (e) => {
                  if (!citation.href) e.preventDefault();
                  citation.onClick?.();
                }
              : undefined
          }
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.3rem",
            fontSize: "0.75rem",
            color: t.primary,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          <Glyph name="info" size={13} />
          {citation.label}
        </a>
      ) : null}

      {(onAccept || onEdit || onDismiss) && (
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              style={{ border: "none", background: "transparent", color: t.onSurfaceVariant, fontWeight: 600, cursor: "pointer", padding: "0.4rem 0.75rem" }}
            >
              Dismiss
            </button>
          ) : null}
          {onEdit ? (
            <button
              type="button"
              onClick={onEdit}
              style={{ border: "none", background: t.surfaceHigh, color: t.onSurface, fontWeight: 600, borderRadius: t.radiusMd, cursor: "pointer", padding: "0.4rem 0.85rem" }}
            >
              Edit
            </button>
          ) : null}
          {onAccept ? (
            <button
              type="button"
              onClick={onAccept}
              style={{ border: "none", background: t.success, color: t.onEmphasis, fontWeight: 600, borderRadius: "9999px", cursor: "pointer", padding: "0.4rem 1rem" }}
            >
              Accept
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// §9 System-derived (computed/imported) — a quiet, factual chip ("derived from …" / "imported via
// HL7 ADT"). Not celebratory: neutral surface tones, small glyph.
// ────────────────────────────────────────────────────────────────────────────
export interface DerivedBadgeProps {
  /** The source, e.g. "HL7 ADT" or "census rules". */
  source: ReactNode;
  /** Relationship verb. Default "derived from". */
  verb?: "derived from" | "imported via" | "computed from";
}
export function DerivedBadge({ source, verb = "derived from" }: DerivedBadgeProps): JSX.Element {
  return (
    <span
      className="wx-derived-badge"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3rem",
        padding: "0.1rem 0.5rem",
        borderRadius: "9999px",
        background: t.surfaceContainer,
        color: t.onSurfaceVariant,
        fontFamily: t.fontSans,
        fontSize: "0.6875rem",
        fontWeight: 500,
      }}
    >
      <Glyph name="info" size={12} />
      {verb} {source}
    </span>
  );
}
