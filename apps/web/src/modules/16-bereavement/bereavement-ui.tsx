// apps/web/src/modules/16-bereavement — the shared Lantern presentation atoms every M16 screen reuses
// (Track B / ADR-0030, §5 / DESIGN.md §6.7). Extracted so the eleven screens share ONE No-Line table
// vocabulary, one card, one field and one modal chrome instead of re-declaring them per file (the M15
// discipline-ui.tsx / M24 medicaid-ui.tsx precedent — each web slice owns its own atoms, because
// apps/web/src/modules/* may not import a sibling module).
//
// Zero raw hex — `t.*` / CSS-var tokens only, so `arch:design-tokens` stays green and the twilight dark
// mode is automatic.
import { Modal as SharedModal, StatusPill, t } from "@chartwarden/ui";
import type { StatusTone } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { idemKey } from "./bereavement-api";
import { RISK_TIER_GLYPH, RISK_TIER_TONE, humanize, toneOf } from "./bereavement-status";

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

// ── card + section chrome ──────────────────────────────────────────────────────────────────────────────
export const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: t.space2,
  background: t.surfaceLowest,
  border: `1px solid ${t.cardBorder}`,
  borderRadius: t.radiusLg,
  padding: `${t.space4} ${t.space5}`,
};
export const cardTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontSans,
  fontSize: "1rem",
  fontWeight: 600,
  color: t.onSurface,
};
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
export const linkMonoStyle: CSSProperties = { ...linkStyle, fontFamily: t.fontMono };
export const columnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: t.space4,
  padding: t.space5,
  minWidth: 0,
};

// ── controls ───────────────────────────────────────────────────────────────────────────────────────────
export const selectStyle: CSSProperties = {
  minHeight: "2.5rem",
  padding: "0 0.75rem",
  borderRadius: t.radiusMd,
  border: `1px solid ${t.cardBorder}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  fontSize: "0.8125rem",
};
export const inputStyle: CSSProperties = { ...selectStyle, minWidth: "9rem" };
export const textareaStyle: CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.6rem",
  borderRadius: t.radiusMd,
  border: `1px solid ${t.cardBorder}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  fontSize: "0.85rem",
  fontFamily: "inherit",
  resize: "vertical",
};
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

/** A titled card — the aside/panel atom. */
export function Card({
  title,
  actions,
  children,
}: { title: string; actions?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section style={cardStyle}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: t.space3,
        }}
      >
        <h3 style={cardTitleStyle}>{title}</h3>
        {actions}
      </div>
      {children}
    </section>
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

/** A labelled <select> for the filter row / a modal field. */
export function SelectField({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={{ fontSize: "0.75rem", fontWeight: 500, color: "var(--color-on-surface)" }}>
        {label}
      </span>
      <select
        aria-label={label}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="wx-select"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A labelled text/number/date input. */
export function TextField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  describedBy,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "number" | "date" | "datetime-local" | "email" | "tel";
  placeholder?: string;
  describedBy?: string;
  maxLength?: number;
}): JSX.Element {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={{ fontSize: "0.7rem", color: t.onSurfaceVariant }}>{label}</span>
      <input
        aria-label={label}
        aria-describedby={describedBy}
        type={type}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
    </label>
  );
}

/** A labelled multi-line field — narrative / attestation / reason capture. */
export function TextAreaField({
  label,
  value,
  onChange,
  rows = 4,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  hint?: string;
}): JSX.Element {
  const hintId = hint ? `${label.replace(/\W+/g, "-").toLowerCase()}-hint` : undefined;
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={{ fontSize: "0.7rem", color: t.onSurfaceVariant }}>{label}</span>
      <textarea
        aria-label={label}
        aria-describedby={hintId}
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        style={textareaStyle}
      />
      {hint ? (
        <span id={hintId} style={mutedStyle}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

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
}: {
  title: string;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
  busy?: boolean;
  dirty?: boolean;
}): JSX.Element {
  return (
    <SharedModal
      open
      onClose={busy ? undefined : onClose}
      dismissOnScrim={!busy && !dirty}
      ariaLabel={title}
      width="34rem"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: t.space4, padding: t.space5 }}>
        <h2 style={modalTitleStyle}>{title}</h2>
        {children}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: t.space2 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={busy ? disabledButtonStyle : ghostButtonStyle}
          >
            Cancel
          </button>
          {footer}
        </div>
      </div>
    </SharedModal>
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
 * One `Idempotency-Key` per write attempt. `keyFor(fingerprint)` hands back the SAME key while the request (version +
 * body, as a string) is unchanged, so a retry after a lost response or a 5xx dedupes server-side; an edited request gets
 * a new key. `settle(status)` forgets the key once the server answered definitively (2xx or 4xx: the next try is a new
 * write); a lost response (status 0) or a 5xx keeps it.
 */
export function useIdempotencyKey(): {
  keyFor: (fingerprint: string) => string;
  settle: (status: number) => void;
} {
  const slot = useRef<{ fingerprint: string; key: string } | null>(null);
  const keyFor = useCallback((fingerprint: string): string => {
    if (slot.current?.fingerprint !== fingerprint) slot.current = { fingerprint, key: idemKey() };
    return slot.current.key;
  }, []);
  const settle = useCallback((status: number): void => {
    if (status !== 0 && status < 500) slot.current = null;
  }, []);
  return { keyFor, settle };
}

/**
 * A permanently mounted polite status line for the outcome of an action, which can also take focus. After a successful
 * action the trigger often no longer exists (a confirmed contact has no Confirm button), and a closed modal restores
 * focus to it, dropping the keyboard user on <body>: `announce` says what happened and moves focus here instead.
 * Empty it is visually hidden (the live region stays in the page so the next message is announced).
 */
export function useActionStatus(): {
  announce: (message: string) => void;
  region: JSX.Element;
} {
  const [message, setMessage] = useState("");
  const [focusRequests, setFocusRequests] = useState(0);
  const ref = useRef<HTMLOutputElement>(null);
  // An effect, not a direct call: it runs after the closing modal's cleanup has restored (and lost) focus.
  useEffect(() => {
    if (focusRequests > 0) ref.current?.focus();
  }, [focusRequests]);
  const announce = useCallback((next: string): void => {
    setMessage(next);
    setFocusRequests((n) => n + 1);
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
