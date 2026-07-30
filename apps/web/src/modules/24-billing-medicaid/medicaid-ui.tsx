// apps/web/src/modules/24-billing-medicaid — the shared Lantern presentation atoms every M24 screen reuses
// (R2, §5 / §6.7). Extracted so the sixteen screens share ONE No-Line table vocabulary, one card, and one
// label/value field instead of re-declaring them per file (the M23 per-file style blocks, deduplicated).
// Zero raw hex — CSS-var tokens only, so the design-tokens gate stays green and dark mode is automatic.
import type { JSX, ReactNode } from "react";

// ── No-Line table (§6.7): no vertical rules, a hairline row separator, uppercase micro-heads ───────────
export const tableStyle = {
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: "0.85rem",
};
export const th = {
  padding: "0.5rem 0.75rem",
  textAlign: "left" as const,
  fontSize: "0.7rem",
  fontWeight: 600 as const,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--color-on-surface-variant)",
};
export const thNum = { ...th, textAlign: "right" as const };
export const td = {
  padding: "0.55rem 0.75rem",
  color: "var(--color-on-surface)",
  verticalAlign: "top" as const,
};
export const tdMono = { ...td, fontFamily: "var(--font-mono)" };
export const tdNum = { ...td, textAlign: "right" as const, fontVariantNumeric: "tabular-nums" as const };
export const rowLine = { borderTop: "1px solid var(--color-surface-container)" };
/** Screen-reader-only text (§5.4) — keeps a column head announced without occupying visual space. */
export const visuallyHidden = {
  position: "absolute" as const,
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden" as const,
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap" as const,
  border: 0,
};

// ── card + section chrome ──────────────────────────────────────────────────────────────────────────────
export const cardStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.5rem",
  background: "var(--color-surface-lowest)",
  borderRadius: "var(--radius-xl, 1rem)",
  boxShadow: "var(--shadow-soft)",
  padding: "1rem 1.25rem",
};
export const cardTitleStyle = {
  margin: 0,
  fontFamily: "var(--font-display)",
  fontSize: "0.95rem",
  fontWeight: 500 as const,
  color: "var(--color-on-surface)",
};
export const sectionTitleStyle = {
  margin: "0 0 0.5rem",
  fontFamily: "var(--font-display)",
  fontSize: "1rem",
  fontWeight: 500 as const,
  color: "var(--color-on-surface)",
};
export const mutedStyle = { fontSize: "0.8rem", color: "var(--color-on-surface-variant)" };
export const alertStyle = { margin: 0, fontSize: "0.82rem", color: "var(--color-error)" };
export const linkStyle = {
  fontSize: "0.8rem",
  color: "var(--color-primary)",
  textDecoration: "none",
};
export const linkMonoStyle = { ...linkStyle, fontFamily: "var(--font-mono)" };

// ── controls ───────────────────────────────────────────────────────────────────────────────────────────
export const selectStyle = {
  padding: "0.35rem 0.5rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};
export const inputStyle = { ...selectStyle, minWidth: "9rem" };
export const textareaStyle = {
  width: "100%",
  padding: "0.5rem 0.6rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
  fontFamily: "inherit",
  resize: "vertical" as const,
};
export const primaryButtonStyle = {
  padding: "0.45rem 0.95rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontSize: "0.82rem",
  fontWeight: 600 as const,
};
export const ghostButtonStyle = {
  padding: "0.45rem 0.95rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.82rem",
  fontWeight: 600 as const,
  textDecoration: "none",
};
export const disabledButtonStyle = { ...ghostButtonStyle, cursor: "not-allowed", opacity: 0.5 };
export const iconButtonStyle = {
  padding: "0.25rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "transparent",
  color: "var(--color-on-surface-variant)",
  display: "flex",
};

// ── modal chrome (the §5.1 modals: override, submit, replace/void, R&B day) ────────────────────────────
export const backdropStyle = {
  position: "fixed" as const,
  inset: 0,
  background: "var(--color-scrim)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "1rem",
  zIndex: 1000,
};
export const modalStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "1rem",
  width: "min(34rem, 100%)",
  maxHeight: "90vh",
  overflowY: "auto" as const,
  background: "var(--color-surface-lowest)",
  borderRadius: "var(--radius-xl, 1rem)",
  boxShadow: "var(--shadow-elevated, var(--shadow-soft))",
  padding: "1.5rem",
};
export const modalTitleStyle = {
  margin: 0,
  fontFamily: "var(--font-display)",
  fontSize: "1.1rem",
  fontWeight: 500 as const,
  color: "var(--color-on-surface)",
};

/** A label/value pair — the summary-grid and card atom (mono for identifiers). */
export function Field({
  label,
  value,
  mono,
}: { label: string; value: ReactNode; mono?: boolean }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
      <span style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>{label}</span>
      <span
        style={{
          fontSize: "0.85rem",
          color: "var(--color-on-surface)",
          fontFamily: mono ? "var(--font-mono)" : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** A titled card — the aside/panel atom. */
export function Card({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section style={cardStyle}>
      <h3 style={cardTitleStyle}>{title}</h3>
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
        gap: "0.75rem 1.5rem",
      }}
    >
      {children}
    </div>
  );
}

/** A horizontal filter row — the §5.1 queue filter bar. */
export function FilterRow({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "flex-end" }}>
      {children}
    </div>
  );
}

/** A labelled <select> for the filter row. */
export function SelectFilter({
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
      <span style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>{label}</span>
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
