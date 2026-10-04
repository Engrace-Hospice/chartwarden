import { type StatusTone, StatusPill as UiStatusPill } from "@wardenx/ui";
// apps/web/src/modules/22-documents/lantern.tsx — small Lantern visual primitives shared by the M22
// Track-B screens (M22-T10). These render to the "Lantern" design language (docs/design/DESIGN.md):
// warm-paper surfaces, twilight-indigo brand, strictly-semantic state colors, the §6.6 status-pill
// taxonomy (color ALWAYS paired with a glyph/text per Hard Rule §10.10), the §6.2 Lantern Card
// (surface-lowest + radius-xl + shadow-soft, No-Line §10.1), and the mono identifier face (§3.1).
// All values come from the index.css `@theme` tokens (`var(--color-*)` / `var(--radius-*)` /
// `var(--shadow-soft)` / `var(--font-*)`) — never ad-hoc hex — so the screens track the unified theme
// (incl. twilight dark mode) instead of cloning an old screen's inline styling.
import type { CSSProperties, JSX, ReactNode } from "react";

/**
 * A Lantern status pill (R1: reconciled to the canonical `@wardenx/ui` StatusPill — single source of
 * truth, with the §10.10 inline-SVG glyph partners instead of the old emoji glyphs). Kept as a thin
 * children-based wrapper so the M22 call sites stay unchanged.
 */
export function StatusPill({
  tone,
  children,
}: { tone: StatusTone; children: ReactNode }): JSX.Element {
  return <UiStatusPill label={children} tone={tone} />;
}

/** Moved to `apps/web/src/shell/document-lifecycle-tone.ts` with the shared document workspace. */
export { lifecycleTone } from "../../shell/document-lifecycle-tone";

/** The §6.2 Lantern Card: white (surface-lowest), radius-xl, shadow-soft, no border (No-Line §10.1). */
export function Card({
  children,
  style,
}: { children: ReactNode; style?: CSSProperties }): JSX.Element {
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
    <h2
      style={{
        margin: "0 0 0.75rem",
        fontFamily: "var(--font-display)",
        fontWeight: 500,
        fontSize: "1.125rem",
      }}
    >
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
    <div
      style={{
        fontSize: "0.6875rem",
        fontWeight: 600,
        color: "var(--color-on-surface-variant)",
      }}
    >
      {children}
    </div>
  );
}

/** Trim an ISO timestamp to `YYYY-MM-DD HH:MM` for dense table cells. */
export const ts = (v: string): string => (v ? v.slice(0, 16).replace("T", " ") : "—");
