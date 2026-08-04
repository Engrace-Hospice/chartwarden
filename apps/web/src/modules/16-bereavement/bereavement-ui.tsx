// apps/web/src/modules/16-bereavement — the shared Lantern presentation atoms every M16 screen reuses
// (Track B / ADR-0030, §5 / DESIGN.md §6.7). Extracted so the eleven screens share ONE No-Line table
// vocabulary, one card, one field and one modal chrome instead of re-declaring them per file (the M15
// discipline-ui.tsx / M24 medicaid-ui.tsx precedent — each web slice owns its own atoms, because
// apps/web/src/modules/* may not import a sibling module).
//
// Zero raw hex — `t.*` / CSS-var tokens only, so `arch:design-tokens` stays green and the twilight dark
// mode is automatic.
import { Modal as SharedModal, StatusPill, t } from "@wardenx/ui";
import type { StatusTone } from "@wardenx/ui";
import type { CSSProperties, JSX, ReactNode } from "react";
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
  textTransform: "uppercase",
  letterSpacing: "0.04em",
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
  borderRadius: t.radiusXl,
  boxShadow: t.shadowSoft,
  padding: `${t.space4} ${t.space5}`,
};
export const cardTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontSize: "0.95rem",
  fontWeight: 500,
  color: t.onSurface,
};
export const pageTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontSize: "1.375rem",
  fontWeight: 500,
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
export const selectStyle: CSSProperties = {
  padding: "0.35rem 0.5rem",
  borderRadius: t.radiusMd,
  border: "none",
  background: t.surfaceLow,
  color: t.onSurface,
  fontSize: "0.85rem",
};
export const inputStyle: CSSProperties = { ...selectStyle, minWidth: "9rem" };
export const textareaStyle: CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.6rem",
  borderRadius: t.radiusMd,
  border: "none",
  background: t.surfaceLow,
  color: t.onSurface,
  fontSize: "0.85rem",
  fontFamily: "inherit",
  resize: "vertical",
};
export const primaryButtonStyle: CSSProperties = {
  padding: "0.45rem 0.95rem",
  borderRadius: t.radiusMd,
  border: "none",
  cursor: "pointer",
  background: t.primary,
  color: t.onPrimary,
  fontSize: "0.82rem",
  fontWeight: 600,
};
export const ghostButtonStyle: CSSProperties = {
  padding: "0.45rem 0.95rem",
  borderRadius: t.radiusMd,
  border: "none",
  cursor: "pointer",
  background: t.surfaceContainer,
  color: t.onSurface,
  fontSize: "0.82rem",
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
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: t.space3, alignItems: "flex-end" }}>
      {children}
    </div>
  );
}

/** A labelled <select> for the filter row / a modal field. */
export function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={{ fontSize: "0.7rem", color: t.onSurfaceVariant }}>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={selectStyle}
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "number" | "date" | "datetime-local" | "email" | "tel";
  placeholder?: string;
  describedBy?: string;
}): JSX.Element {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={{ fontSize: "0.7rem", color: t.onSurfaceVariant }}>{label}</span>
      <input
        aria-label={label}
        aria-describedby={describedBy}
        type={type}
        value={value}
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
 * to `@wardenx/ui`'s focus-trapped `Modal` (UI-005) for the scrim, Escape-to-close, and focus
 * trap/restore, keeping this call-site's `{title, onClose, footer, children}` shape unchanged. */
export function Modal({
  title,
  onClose,
  footer,
  children,
}: {
  title: string;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <SharedModal open onClose={onClose} ariaLabel={title} width="34rem">
      <div style={{ display: "flex", flexDirection: "column", gap: t.space4, padding: t.space5 }}>
        <h2 style={modalTitleStyle}>{title}</h2>
        {children}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: t.space2 }}>
          <button type="button" onClick={onClose} style={ghostButtonStyle}>
            Cancel
          </button>
          {footer}
        </div>
      </div>
    </SharedModal>
  );
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
            padding: `${t.space2} ${t.space3}`,
            borderRadius: t.radiusMd,
            background: t.surfaceLow,
          }}
        >
          <span style={{ fontSize: "0.7rem", color: t.onSurfaceVariant }}>{e.label}</span>
          <span
            style={{
              fontSize: "1.15rem",
              fontWeight: 600,
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
