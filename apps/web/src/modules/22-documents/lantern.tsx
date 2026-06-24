// apps/web/src/modules/22-documents/lantern.tsx — small Lantern visual primitives shared by the M22
// Track-B screens (M22-T10). These render to the "Lantern" design language (docs/design/DESIGN.md):
// warm-paper surfaces, twilight-indigo brand, strictly-semantic state colors, the §6.6 status-pill
// taxonomy (color ALWAYS paired with a glyph/text per Hard Rule §10.10), the §6.2 Lantern Card
// (surface-lowest + radius-xl + shadow-soft, No-Line §10.1), and the mono identifier face (§3.1).
// All values come from the index.css `@theme` tokens (`var(--color-*)` / `var(--radius-*)` /
// `var(--shadow-soft)` / `var(--font-*)`) — never ad-hoc hex — so the screens track the unified theme
// (incl. twilight dark mode) instead of cloning an old screen's inline styling.
import type { CSSProperties, JSX, ReactNode } from "react";

/** §6.6 status family → Lantern semantic token pair (bg/fg) + a non-color glyph (Hard Rule §10.10). */
type BadgeTone = "success" | "progress" | "warning" | "error" | "alert" | "neutral";

const TONE: Record<BadgeTone, { bg: string; fg: string; glyph: string }> = {
  // success uses the §2.3 success pair; the tints come from color-mix so one token drives both.
  success: { bg: "color-mix(in srgb, var(--color-success) 14%, transparent)", fg: "var(--color-success)", glyph: "✓" },
  progress: { bg: "var(--color-primary-tint)", fg: "var(--color-primary)", glyph: "◷" },
  warning: { bg: "color-mix(in srgb, var(--color-warning) 16%, transparent)", fg: "var(--color-warning)", glyph: "⏱" },
  error: { bg: "color-mix(in srgb, var(--color-error) 14%, transparent)", fg: "var(--color-error)", glyph: "✕" },
  alert: { bg: "color-mix(in srgb, var(--color-alert) 16%, transparent)", fg: "var(--color-alert)", glyph: "!" },
  neutral: { bg: "var(--color-surface-container)", fg: "var(--color-on-surface-variant)", glyph: "•" },
};

/** A Lantern status pill — radius-full, label-md, color paired with a leading glyph (never color-only). */
export function StatusPill({ tone, children }: { tone: BadgeTone; children: ReactNode }): JSX.Element {
  const t = TONE[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3rem",
        padding: "0.15rem 0.6rem",
        borderRadius: "var(--radius-full, 9999px)",
        background: t.bg,
        color: t.fg,
        fontSize: "0.75rem",
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden style={{ fontWeight: 700 }}>{t.glyph}</span>
      {children}
    </span>
  );
}

/**
 * Map an M22 document/render/intake lifecycle status to a Lantern tone (§6.6 "document/render"
 * lifecycle: queued → rendering → rendered → failed; plus the intake batch + review states). The
 * server is authoritative for the status string; this is only the visual tone.
 */
export function lifecycleTone(status: string): BadgeTone {
  const s = status.toLowerCase();
  if (/(fail|error|parse_failed|stalled)/.test(s)) return "error";
  if (/(rendered|complete|writeback_complete|active|signed|posted)/.test(s)) return "success";
  if (/(rendering|classif|extract|review|awaiting|pending|uploaded|in_progress|queued|docling)/.test(s)) return "progress";
  if (/(discard|void|superseded|abandoned|split_resolved)/.test(s)) return "neutral";
  return "neutral";
}

/** The §6.2 Lantern Card: white (surface-lowest), radius-xl, shadow-soft, no border (No-Line §10.1). */
export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }): JSX.Element {
  return (
    <section
      style={{
        background: "var(--color-surface-lowest)",
        borderRadius: "var(--radius-xl)",
        boxShadow: "var(--shadow-soft)",
        padding: "1.5rem",
        ...style,
      }}
    >
      {children}
    </section>
  );
}

/** A Fraunces §3.2 headline-md card header (the editorial/human voice, DESIGN.md §3.1). */
export function CardTitle({ children }: { children: ReactNode }): JSX.Element {
  return (
    <h2 style={{ margin: "0 0 0.75rem", fontFamily: "var(--font-display)", fontWeight: 500, fontSize: "1.125rem" }}>
      {children}
    </h2>
  );
}

/** An identifier rendered in the IBM Plex Mono face (§3.1 — MRN/IDs are copy-safe and unmistakable). */
export function Mono({ children }: { children: ReactNode }): JSX.Element {
  return <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.8125rem" }}>{children}</code>;
}

/** A `label-sm` all-caps eyebrow (the §3.3 Big/Small editorial rule — small metadata over a big figure). */
export function Eyebrow({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div style={{ fontSize: "0.6875rem", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--color-on-surface-variant)" }}>
      {children}
    </div>
  );
}

/** Trim an ISO timestamp to `YYYY-MM-DD HH:MM` for dense table cells. */
export const ts = (v: string): string => (v ? v.slice(0, 16).replace("T", " ") : "—");
