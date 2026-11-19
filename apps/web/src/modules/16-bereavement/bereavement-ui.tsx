// apps/web/src/modules/16-bereavement — the shared Lantern presentation atoms every M16 screen reuses
// (Track B / ADR-0030, §5). Cards, fields and tables come from the kit now (`Panel`, the value-field adapters
// re-exported below, the base table chrome and the `wx-*` text classes); what remains here is the modal chrome
// and a few layout constants (the M15 discipline-ui.tsx / M24 medicaid-ui.tsx precedent — each web slice owns
// its own atoms, because apps/web/src/modules/* may not import a sibling module).
//
// Zero raw hex — `t.*` / CSS-var tokens only, so `arch:design-tokens` stays green and the twilight dark
// mode is automatic.
import { Button, Modal as SharedModal, StatusPill, t } from "@chartwarden/ui";
import type { StatusTone } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { FormDrawer } from "../../shell/form-drawer";
import { RISK_TIER_GLYPH, RISK_TIER_TONE, humanize, toneOf } from "./bereavement-status";

// ── numeric table cells: the table's own chrome (padding, hairlines, header weight) is the kit's; a number
// column only right-aligns and sets tabular figures ───────────────────────────────────────────────────
export const thNum: CSSProperties = { textAlign: "right" };
export const tdNum: CSSProperties = { textAlign: "right", fontVariantNumeric: "tabular-nums" };

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

// ── section chrome ─────────────────────────────────────────────────────────────────────────────────────
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
const mutedStyle: CSSProperties = { fontSize: "0.8rem", color: t.onSurfaceVariant };
const alertStyle: CSSProperties = { margin: 0, fontSize: "0.82rem", color: t.error };

/** The shared error line. `role="alert"` so a failure that appears after a click is announced, not just painted red. */
export function ErrorText({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p role="alert" style={alertStyle}>
      {children}
    </p>
  );
}
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
/** A <fieldset> used only to disable its controls while a write is in flight: no border, no inset, the controls in a grid. */
export const plainFieldset: CSSProperties = {
  border: 0,
  padding: 0,
  margin: 0,
  display: "grid",
  gap: "0.75rem",
};

// ── controls ───────────────────────────────────────────────────────────────────────────────────────────
export const primaryButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "2.5rem",
  padding: "0 1rem",
  borderRadius: t.radiusMd,
  border: "none",
  cursor: "pointer",
  background: t.primary,
  color: t.onPrimary,
  fontSize: "0.875rem",
  fontWeight: 600,
};
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
/** The confirming button of a destructive dialog (cancel a run): the kit's danger tone. */
export const dangerButtonStyle: CSSProperties = {
  ...primaryButtonStyle,
  background: t.error,
  color: t.onEmphasis,
};
export const disabledButtonStyle: CSSProperties = {
  ...ghostButtonStyle,
  cursor: "not-allowed",
  opacity: 0.5,
};

// ── modal chrome (the §5.1 modals: assign, add contact, start/complete, opt-out, referral, close) ──────
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

// The text, select and textarea fields are the kit's, behind string-valued `onChange(value)` adapters.
export { SelectField, TextAreaField, TextField } from "../../shell/value-fields";

/** A labelled checkbox — the boolean capture atom (roster seeding, "did the contact respond"). */
export function CheckboxField({
  label,
  checked,
  onChange,
}: { label: string; checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        fontSize: "0.85rem",
        color: t.onSurface,
      }}
    >
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

/** The §5.1 modal shell — backdrop + dialog + footer actions. Every M16 ceremony reuses it. Delegates
 * to `@chartwarden/ui`'s focus-trapped `Modal` (UI-005) for the scrim, Escape-to-close, and focus
 * trap/restore, keeping this call-site's `{title, onClose, footer, children}` shape unchanged.
 *
 * `busy` (a write is in flight) makes the dialog undismissable by Cancel, Escape and the scrim: closing it would orphan
 * the request and its outcome. `dirty` (typed text the reader would lose) only stops a stray scrim click. */
export function Modal({
  title,
  onClose,
  footer,
  children,
  busy = false,
  dirty = false,
  role = "dialog",
  describedBy,
  cancelLabel = "Cancel",
}: {
  title: string;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
  busy?: boolean;
  dirty?: boolean;
  /** `alertdialog` for a destructive ceremony (cancel a run): read out with its description. */
  role?: "dialog" | "alertdialog";
  /** The id of the element inside the dialog that says what the action does. */
  describedBy?: string;
  /** The dismiss button's words ("Keep run" where "Cancel" would read as the destructive action). */
  cancelLabel?: string;
}): JSX.Element {
  return (
    <SharedModal
      open
      onClose={busy ? undefined : onClose}
      dismissOnScrim={!busy && !dirty}
      ariaLabel={title}
      role={role}
      {...(describedBy ? { ariaDescribedBy: describedBy } : {})}
      width="34rem"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: t.space4, padding: t.space5 }}>
        <h2 style={modalTitleStyle}>{title}</h2>
        {children}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: t.space2 }}>
          <Button tone="secondary" type="button" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          {footer}
        </div>
      </div>
    </SharedModal>
  );
}

/** One form, two shells: a dialog over the page (a record's own detail page) or a drawer beside the list (the list screen). */
export function FormShell({
  presentation,
  title,
  busy,
  onClose,
  save,
  error,
  children,
}: {
  presentation: "modal" | "drawer";
  title: string;
  busy: boolean;
  onClose: () => void;
  save: ReactNode;
  /** A failed write's refusal: after the fields in the dialog, announced in the drawer beside Save in the drawer. */
  error?: string | null;
  children: ReactNode;
}): JSX.Element {
  return presentation === "modal" ? (
    <Modal title={title} onClose={onClose} busy={busy} dirty footer={save}>
      {children}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  ) : (
    <FormDrawer title={title} busy={busy} onClose={onClose} save={save} error={error}>
      {children}
    </FormDrawer>
  );
}

/**
 * A permanently mounted polite live region for an outcome message. It stays in the page when empty (visually hidden, so it
 * takes no room) because a live region that is inserted together with its text is often not announced.
 */
export function StatusLine({
  message,
  tone = "success",
}: { message: string; tone?: "info" | "warning" | "error" | "success" }): JSX.Element {
  return (
    <div aria-live="polite" style={message ? undefined : visuallyHidden}>
      {message ? <Notice tone={tone}>{message}</Notice> : null}
    </div>
  );
}

/**
 * A permanently mounted polite status line for the outcome of an action, which can also take focus. After a successful
 * action the trigger often no longer exists (a confirmed contact has no Confirm button), and a closed modal restores
 * focus to it, dropping the keyboard user on <body>: `announce` says what happened and moves focus here instead.
 * Empty it is visually hidden (the live region stays in the page so the next message is announced).
 */
export function useActionStatus(): {
  /** `focus: false` for a message nobody acted for (a poll noticed it): it is announced, but focus stays where the reader is. */
  announce: (message: string, opts?: { readonly focus?: boolean }) => void;
  region: JSX.Element;
} {
  const [message, setMessage] = useState("");
  const [focusRequests, setFocusRequests] = useState(0);
  const ref = useRef<HTMLOutputElement>(null);
  // An effect, not a direct call: it runs after the closing modal's cleanup has restored (and lost) focus.
  useEffect(() => {
    // preventScroll: the status line sits at the top of the page; a save lower down must not jump the reader there.
    if (focusRequests > 0) ref.current?.focus({ preventScroll: true });
  }, [focusRequests]);
  const announce = useCallback((next: string, opts?: { readonly focus?: boolean }): void => {
    setMessage(next);
    if (opts?.focus !== false) setFocusRequests((n) => n + 1);
  }, []);
  const region = (
    <output ref={ref} tabIndex={-1} style={message ? mutedStyle : visuallyHidden}>
      {message}
    </output>
  );
  return { announce, region };
}

/**
 * A tonal advisory strip — the D18 cosign-pending banner, the §5.1 #17 anniversary countdown, the §7.13
 * redaction notice, the D17 confidence band. `tone` maps to a status token; the copy always carries the
 * reason, never a bare colour (Hard Rule §10.10 — colour is never the only signal).
 *
 * `live` renders the strip as a polite live region, which §5.1 requires for the anniversary countdown.
 */
export function Notice({
  tone = "info",
  live,
  children,
}: {
  tone?: "info" | "warning" | "error" | "success";
  live?: boolean;
  children: ReactNode;
}): JSX.Element {
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
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
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

/**
 * The risk-tier badge. §5.1: "risk-tier badges use both colour and icon — never colour alone", so the
 * glyph rides INSIDE the pill label rather than beside it — a screen reader and a monochrome print both
 * still carry the tier. An ABSENT tier (the D10 volunteer scope / §7.13 gate removed it) is rendered as
 * "not disclosed", which is a different fact from "no tier computed" (`null`), and the two must not
 * collapse into one badge.
 */
export function RiskTierPill({ tier }: { tier?: string | null | undefined }): JSX.Element {
  if (tier === undefined) return <StatusPill label="Not disclosed" tone="neutral" />;
  if (tier === null) return <StatusPill label="Not yet scored" tone="neutral" />;
  const glyph = RISK_TIER_GLYPH[tier] ?? "○";
  return (
    <StatusPill
      label={`${glyph} ${humanize(tier)}`}
      tone={toneOf(RISK_TIER_TONE, tier) as StatusTone}
    />
  );
}

/** A count chip row — the two dashboards' distribution rollups (COUNTS, never a rate). */
export function CountGrid({
  entries,
}: { entries: readonly { label: string; value: number; tone?: StatusTone }[] }): JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(9rem, 1fr))",
        gap: t.space3,
      }}
    >
      {entries.map((e) => (
        <div
          key={e.label}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.15rem",
            padding: `${t.space3} ${t.space4}`,
            border: `1px solid ${t.cardBorder}`,
            borderRadius: t.radiusLg,
            background: t.surfaceLowest,
          }}
        >
          <span style={{ fontSize: "0.8125rem", color: t.muted }}>{e.label}</span>
          <span
            style={{
              fontSize: "1.375rem",
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              color: t.onSurface,
            }}
          >
            {e.value}
          </span>
        </div>
      ))}
    </div>
  );
}
