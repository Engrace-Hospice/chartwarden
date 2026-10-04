// apps/web/src/modules/21-supplies — the shared Lantern presentation atoms every M21 screen reuses
// (Track B / ADR-0030, §5 / DESIGN.md §6.7). Extracted so the ten screens share ONE No-Line table
// vocabulary, one card, one field and one modal chrome instead of re-declaring them per file (the M15
// discipline-ui.tsx / M16 bereavement-ui.tsx precedent — each web slice owns its own atoms, because
// apps/web/src/modules/* may not import a sibling module).
//
// Zero raw hex — `t.*` / CSS-var tokens only, so `arch:design-tokens` stays green and the twilight dark
// mode is automatic.
import { Modal as SharedModal, StatusPill, t } from "@wardenx/ui";
import type { StatusTone } from "@wardenx/ui";
import type { CSSProperties, JSX, ReactNode } from "react";
import {
  PAR_SEVERITY_GLYPH,
  PAR_SEVERITY_TONE,
  SCHEDULE_TONE,
  humanize,
  parSeverityLabel,
  toneOf,
} from "./supplies-status";

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
/** A quantity cell — mono AND tabular, because a DEA count is read column-wise against another count. */
export const tdQty: CSSProperties = { ...tdNum, fontFamily: t.fontMono };
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
  minHeight: "2.5rem",
  padding: "0 0.75rem",
  borderRadius: t.radiusMd,
  border: `1px solid ${t.cardBorder}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  fontSize: "0.8125rem",
};
export const inputStyle: CSSProperties = { ...selectStyle, minWidth: "9rem" };
export const inputNarrowStyle: CSSProperties = {
  ...selectStyle,
  minWidth: "5rem",
  width: "6rem",
  fontFamily: t.fontMono,
  textAlign: "right",
};
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

// ── modal chrome (the §5 ceremonies: assign vendor, transition, reconcile, write off, observe) ─────────
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

/** A horizontal filter row — the §5 queue filter bar. */
export function FilterRow({ children }: { children: ReactNode }): JSX.Element {
  return <div className="wx-filter-panel">{children}</div>;
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
      <span style={{ fontSize: "0.75rem", fontWeight: 500, color: "var(--color-on-surface)" }}>
        {label}
      </span>
      <select
        aria-label={label}
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

/** Turn a wire-enum list into `SelectField` options via a labeller. */
export function enumOptions(
  values: readonly string[],
  label: (v: string) => string = humanize,
): { value: string; label: string }[] {
  return values.map((v) => ({ value: v, label: label(v) }));
}

/** A labelled text/number/date input. */
export function TextField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  describedBy,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "number" | "date" | "datetime-local" | "email" | "tel";
  placeholder?: string;
  describedBy?: string;
  mono?: boolean;
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
        style={mono ? { ...inputStyle, fontFamily: t.fontMono } : inputStyle}
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

/** A labelled checkbox — the boolean capture atom. */
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

/** The §5 modal shell — backdrop + dialog + footer actions. Every M21 ceremony reuses it. Delegates
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
 * A tonal advisory strip — the §5.6 discrepancy banner, the DEA step-up notice, the §2.2 precondition
 * explanation. `tone` maps to a status token; the copy always carries the reason, never a bare colour
 * (Hard Rule §10.10 — colour is never the only signal).
 *
 * `live` renders the strip as a polite live region; `assertive` is reserved for the §5.6 non-dismissible
 * controlled-substance discrepancy banner, which is the one message in M21 that must interrupt.
 */
export function Notice({
  tone = "info",
  live,
  assertive,
  children,
}: {
  tone?: "info" | "warning" | "error" | "success";
  live?: boolean;
  assertive?: boolean;
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
      role={assertive ? "alert" : live ? "status" : undefined}
      aria-live={assertive ? "assertive" : live ? "polite" : undefined}
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
 * The controlled-substance badge. §5.4 / §5.9 require CII–CV to be visible on the line, and Hard Rule
 * §10.10 forbids colour as the only signal, so the schedule TEXT rides inside the pill — a monochrome
 * print of a DEA manifest still names the schedule.
 *
 * A NON-controlled line renders NOTHING rather than a "not controlled" pill: the absence of a schedule is
 * the ordinary case, and a badge on every row would make the four that matter stop standing out.
 */
export function SchedulePill({
  schedule,
  isControlled,
}: { schedule: string | null | undefined; isControlled?: boolean }): JSX.Element | null {
  if (!schedule) {
    // A controlled line with NO schedule is a data fault the §3.1 CHECK pair forbids — surface it rather
    // than render a clean row, because a controlled line that looks unscheduled is the one nobody counts.
    if (isControlled) return <StatusPill label="Controlled — schedule missing" tone="error" />;
    return null;
  }
  return <StatusPill label={schedule} tone={toneOf(SCHEDULE_TONE, schedule)} />;
}

/** The DERIVED par band badge — glyph INSIDE the label, per §10.10. */
export function ParSeverityPill({ severity }: { severity: string }): JSX.Element {
  const glyph = PAR_SEVERITY_GLYPH[severity] ?? "○";
  return (
    <StatusPill
      label={`${glyph} ${parSeverityLabel(severity)}`}
      tone={toneOf(PAR_SEVERITY_TONE, severity)}
    />
  );
}

/** A count chip row — the §5.2 KPI tiles (COUNTS, never rates). */
export function CountGrid({
  entries,
}: { entries: readonly { label: string; value: number; tone?: StatusTone }[] }): JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(11rem, 1fr))",
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

/**
 * A vertical timeline of `*_at` stamps with the actor that produced each — the §5.3 lifecycle timeline and
 * the §5.5 chain-of-custody timeline share it. Entries with a null instant are DROPPED by the caller, not
 * rendered as "—": a step that has not happened is absent from a custody chain, never a blank row that
 * reads like a missing record.
 */
export function Timeline({
  entries,
}: {
  entries: readonly { label: string; at: string; by?: string | null; detail?: ReactNode }[];
}): JSX.Element {
  return (
    <ol
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        gap: t.space3,
      }}
    >
      {entries.map((e) => (
        <li key={`${e.label}-${e.at}`} style={{ display: "flex", gap: t.space3 }}>
          <span
            aria-hidden="true"
            style={{
              width: "0.5rem",
              height: "0.5rem",
              marginTop: "0.4rem",
              borderRadius: "50%",
              background: t.primary,
              flexShrink: 0,
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem", minWidth: 0 }}>
            <span style={{ fontSize: "0.85rem", color: t.onSurface }}>{e.label}</span>
            <span style={mutedStyle}>
              {e.at}
              {e.by ? ` · ${e.by}` : ""}
            </span>
            {e.detail}
          </div>
        </li>
      ))}
    </ol>
  );
}
