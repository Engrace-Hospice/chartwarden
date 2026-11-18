// apps/web/src/modules/15-discipline-care-plans — the shared Lantern presentation atoms every M15 screen
// reuses (Track B / ADR-0030, §5 / DESIGN.md §6.7). Extracted so the thirteen screens share ONE No-Line
// table vocabulary, one card, one field and one modal chrome instead of re-declaring them per file (the
// M24 medicaid-ui.tsx precedent). Zero raw hex — `t.*` / CSS-var tokens only, so `arch:design-tokens`
// stays green and the twilight dark mode is automatic.
import { Button, Modal as SharedModal, t } from "@chartwarden/ui";
import { useEffect } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";

// ── No-Line table (§6.7): no vertical rules, a hairline row separator, uppercase micro-heads ───────────
export const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
};
export const th: CSSProperties = {
  padding: "0.5rem 0.75rem",
  textAlign: "left",
  fontSize: "0.7rem",
  fontWeight: 600,
  color: t.onSurfaceVariant,
};
export const thNum: CSSProperties = { ...th, textAlign: "right" };
export const td: CSSProperties = {
  padding: "0.55rem 0.75rem",
  color: t.onSurface,
  verticalAlign: "top",
};
export const tdMono: CSSProperties = { ...td, fontFamily: t.fontMono };
export const tdNum: CSSProperties = {
  ...td,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};
export const rowLine: CSSProperties = { borderTop: `1px solid ${t.surfaceContainer}` };

/**
 * Keeps clinical tables usable at narrow widths without forcing the whole patient workspace to overflow.
 * The labelled region is keyboard-focusable so keyboard users can reach and horizontally scroll it.
 */
export function TableScroll({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: overflow regions must be keyboard-scrollable.
      tabIndex={0}
      style={{ width: "100%", maxWidth: "100%", overflowX: "auto" }}
    >
      {children}
    </section>
  );
}

/** Screen-reader-only text — keeps a control labelled without occupying visual space (§16 WCAG AA). */
export const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/** Native reload/close protection plus an explicit guard for links and modal cancellation. */
export function useUnsavedChangesWarning(dirty: boolean): () => boolean {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  return () => !dirty || window.confirm("Discard the unsaved changes on this screen?");
}

// ── card + section chrome ──────────────────────────────────────────────────────────────────────────────
export const pageTitleStyle: CSSProperties = {
  // Matches PageHeader's own title (the redesign's bold sans heading).
  margin: 0,
  fontFamily: t.fontSans,
  fontSize: "1.875rem",
  fontWeight: 700,
  letterSpacing: "-0.01em",
  lineHeight: 1.2,
  color: t.onSurface,
};
export const sectionTitleStyle: CSSProperties = {
  margin: `0 0 ${t.space2}`,
  fontFamily: t.fontDisplay,
  fontSize: "1rem",
  fontWeight: 500,
  color: t.onSurface,
};
export const mutedStyle: CSSProperties = { fontSize: "0.8rem", color: t.onSurfaceVariant };
export const alertStyle: CSSProperties = { margin: 0, fontSize: "0.82rem", color: t.error };
export const linkStyle: CSSProperties = {
  fontSize: "0.8rem",
  color: t.primary,
  textDecoration: "none",
};
export const linkMonoStyle: CSSProperties = { ...linkStyle, fontFamily: t.fontMono };
export const columnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: t.space4,
  padding: t.space5,
  minWidth: 0,
};

// ── controls ───────────────────────────────────────────────────────────────────────────────────────────
export const ghostButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "2.5rem",
  padding: "0 1rem",
  borderRadius: t.radiusMd,
  border: `1px solid ${t.cardBorder}`,
  cursor: "pointer",
  background: t.surfaceLowest,
  color: t.onSurface,
  fontSize: "0.875rem",
  fontWeight: 600,
  textDecoration: "none",
};

// ── modal chrome (the §5.1 modals: sign, supervisory visit, volunteer assignment, gate) ────────────────
export const modalTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontSize: "1.1rem",
  fontWeight: 500,
  color: t.onSurface,
};

/** A label/value pair — the summary-grid and card atom (mono for identifiers). */
export function Field({
  label,
  value,
  mono,
}: { label: string; value: ReactNode; mono?: boolean }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
      <span style={{ fontSize: "0.7rem", color: t.onSurfaceVariant }}>{label}</span>
      <span
        style={{
          fontSize: "0.85rem",
          color: t.onSurface,
          fontFamily: mono ? t.fontMono : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** An auto-fitting label/value grid — the detail header atom. */
export function SummaryGrid({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(12rem, 1fr))",
        gap: `${t.space3} ${t.space5}`,
      }}
    >
      {children}
    </div>
  );
}

/** A horizontal filter row — the §5.1 queue filter bar. */
export function FilterRow({ children }: { children: ReactNode }): JSX.Element {
  return <div className="wx-filter-panel">{children}</div>;
}

// The labelled controls are the kit's, behind the string-valued `onChange(value)` these screens use.
export { SelectField, TextAreaField, TextField } from "../../shell/value-fields";

/** The §5.1 modal shell — backdrop + dialog + footer actions. Every M15 ceremony reuses it. Delegates
 * to `@chartwarden/ui`'s focus-trapped `Modal` (UI-005) for the scrim, Escape-to-close, and focus
 * trap/restore, keeping this call-site's `{title, onClose, footer, children}` shape unchanged. */
export function Modal({
  title,
  onClose,
  closeDisabled = false,
  footer,
  children,
}: {
  title: string;
  onClose: () => void;
  closeDisabled?: boolean;
  footer: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <SharedModal
      open
      onClose={closeDisabled ? undefined : onClose}
      dismissOnScrim={!closeDisabled}
      ariaLabel={title}
      width="34rem"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: t.space4, padding: t.space5 }}>
        <h2 style={modalTitleStyle}>{title}</h2>
        {children}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: t.space2 }}>
          <Button tone="secondary" type="button" onClick={onClose} disabled={closeDisabled}>
            Cancel
          </Button>
          {footer}
        </div>
      </div>
    </SharedModal>
  );
}

/**
 * A tonal advisory strip — the §7.1 supervisory next-due banner, the §7.8/§7.9 redaction notice, the
 * §7.6 "cost basis unavailable" note. `tone` maps to a status token; the copy always carries the reason,
 * never a bare color (Hard Rule §10.10 — color is never the only signal).
 */
export function Notice({
  tone = "info",
  children,
}: { tone?: "info" | "warning" | "error" | "success"; children: ReactNode }): JSX.Element {
  const color =
    tone === "error"
      ? t.error
      : tone === "warning"
        ? t.warning
        : tone === "success"
          ? t.success
          : t.primary;
  return (
    <p
      role={tone === "error" ? "alert" : undefined}
      aria-live={tone === "error" ? "assertive" : undefined}
      style={{
        margin: 0,
        padding: `${t.space2} ${t.space3}`,
        borderRadius: t.radiusMd,
        background: `color-mix(in srgb, ${color} 10%, ${t.surfaceLowest})`,
        color: t.onSurface,
        fontSize: "0.82rem",
      }}
    >
      {children}
    </p>
  );
}
