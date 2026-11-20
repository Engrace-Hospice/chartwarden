// apps/web/src/modules/15-discipline-care-plans — the presentation atoms every M15 screen still shares
// (Track B / ADR-0030, §5). Cards, fields and tables come from the kit now (`Panel`, the value-field
// adapters re-exported below, the base table chrome and `wx-*` text classes); what remains here is the
// modal chrome and a few layout constants. Zero raw hex — `t.*` / CSS-var tokens only, so
// `arch:design-tokens` stays green and the twilight dark mode is automatic.
import { Button, Modal as SharedModal, t } from "@chartwarden/ui";
import { useEffect } from "react";
import type { CSSProperties, JSX, MouseEvent, ReactNode } from "react";

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

/**
 * A capture-phase click guard for every in-app link under a screen — the chart rail, the banner and the screen's own
 * links — because `beforeunload` does not fire on a client-side navigation. Spread it on a wrapper
 * (`<div style={{ display: "contents" }} {...guardLinkClicks(confirmDiscard)}>`); a declined confirm cancels the click
 * before the router sees it. Modified clicks and `target` links open elsewhere and are left alone.
 */
export function guardLinkClicks(confirmDiscard: () => boolean): {
  onClickCapture: (event: MouseEvent<HTMLElement>) => void;
} {
  return {
    onClickCapture: (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const anchor = (event.target as Element).closest?.("a[href]");
      if (!anchor || anchor.getAttribute("target")) return;
      if (!confirmDiscard()) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
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
export const linkStyle: CSSProperties = {
  fontSize: "0.8rem",
  color: t.primary,
  textDecoration: "none",
};
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
