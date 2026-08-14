// apps/admin/src/modules/32-ai-platform — shared presentational bits for the §5.1 AI Safety Owner
// console (GAP-049). The M35 §5.2 slice's `ui.tsx` precedent: token-only helpers (no raw hex — the
// design-tokens gate forbids it in render code) so table/field/button chrome is written once.
import { StatusPill, type StatusTone } from "@wardenx/ui";
import type { CSSProperties, JSX, ReactNode } from "react";

export const cell: CSSProperties = { padding: "0.6rem 0.75rem" };
export const cellRight: CSSProperties = { ...cell, textAlign: "right" };

export const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.875rem",
};
export const theadRow: CSSProperties = {
  textAlign: "left",
  color: "var(--color-on-surface-variant)",
};
export const bodyRow: CSSProperties = { borderTop: "1px solid var(--color-outline-variant)" };

export const inputStyle: CSSProperties = {
  padding: "0.55rem 0.75rem",
  borderRadius: "var(--radius-md, 0.5rem)",
  border: "1px solid var(--color-outline)",
  background: "var(--color-surface-lowest)",
  color: "var(--color-on-surface)",
  fontSize: "0.9rem",
};

export const cardStyle: CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "var(--radius-lg, 0.75rem)",
  background: "var(--color-surface)",
  padding: "1rem 1.1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};

export const pageStyle: CSSProperties = {
  padding: "1.5rem 1.75rem",
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};

export function actionButtonStyle(primary: boolean, disabled = false): CSSProperties {
  return {
    padding: "0.55rem 1.1rem",
    borderRadius: "var(--radius-md, 0.5rem)",
    border: primary ? "none" : "1px solid var(--color-outline)",
    background: primary ? "var(--color-primary)" : "transparent",
    color: primary ? "var(--color-on-primary)" : "var(--color-primary)",
    fontSize: "0.875rem",
    fontWeight: 600,
    textDecoration: "none",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
}

/** A label→value stack for the detail asides. */
export function Kv({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>{label}</span>
      <span style={{ fontSize: "0.9rem", color: "var(--color-on-surface)" }}>{children}</span>
    </div>
  );
}

/** A form field: label + control. */
export function Field({
  label,
  htmlFor,
  children,
}: { label: string; htmlFor?: string; children: ReactNode }): JSX.Element {
  return (
    <label
      htmlFor={htmlFor}
      style={{ display: "flex", flexDirection: "column", gap: "0.35rem", fontSize: "0.85rem" }}
    >
      <span style={{ fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  );
}

/** A first-class outcome banner surfacing a server result to the operator. */
export function OutcomeBanner({ ok, message }: { ok: boolean; message: string }): JSX.Element {
  return (
    <output aria-live="polite">
      <StatusPill label={message} tone={ok ? "success" : "error"} />
    </output>
  );
}

/**
 * A persistent, non-dismissible notice. §5.1.4 requires the PHI-masking banner to be a HEADER banner
 * rather than a toast: the operator must be able to see, at any moment while reading the table, that
 * what they are looking at is masked. A dismissible affordance would defeat that.
 */
export function StandingNotice({
  tone,
  children,
}: { tone: StatusTone; children: ReactNode }): JSX.Element {
  return (
    <div
      role="note"
      style={{
        ...cardStyle,
        padding: "0.7rem 0.9rem",
        flexDirection: "row",
        alignItems: "center",
        gap: "0.6rem",
      }}
    >
      <StatusPill label={tone === "success" ? "OK" : "Notice"} tone={tone} />
      <span style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
        {children}
      </span>
    </div>
  );
}

/** Title-case an underscore enum value, e.g. `dangerous_clinical_suggestion` → `Dangerous Clinical Suggestion`. */
export function cap(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Absolute-instant formatting; `null` renders an em dash rather than "Invalid Date". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** Whole-number formatting for token counts. */
export function formatInt(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString();
}
