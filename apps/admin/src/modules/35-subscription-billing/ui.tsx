// apps/admin/src/modules/35-subscription-billing — shared presentational bits for the §5.2 console screens.
// Small, token-only helpers (no raw hex — the design-tokens gate forbids it in render code) the 14 screens
// reuse so table/field/button chrome is written once. Anything richer composes the @wardenx/ui layout kit.
import { ReverifyLink, StatusPill, isStepUpRequired } from "@wardenx/ui";
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

/** A server result surfaced to the operator. `stepUp`: the refusal was STEP_UP_REQUIRED (offer Re-verify). */
export interface Outcome {
  readonly ok: boolean;
  readonly message: string;
  readonly stepUp?: boolean;
}

export const STEP_UP_MESSAGE = "This action needs a fresh verification. Re-verify, then try again.";

/**
 * The outcome for a failed write: a STEP_UP_REQUIRED refusal (session valid but not fresh enough) becomes
 * the re-verify outcome, anything else `fallback`. `error` is the parsed error body openapi-fetch returns —
 * the standard envelope `{ error: { code } }` (reading a top-level `.code` off it never matched).
 */
export function failureOutcome(error: unknown, fallback: string): Outcome {
  return isStepUpRequired(error)
    ? { ok: false, message: STEP_UP_MESSAGE, stepUp: true }
    : { ok: false, message: fallback };
}

/**
 * A first-class outcome banner (success/error) surfacing a server result to the operator. A step-up refusal
 * also carries a Re-verify link to the console's /step-up page, which returns here — never an automatic
 * redirect, so a form with typed input is not torn away.
 */
export function OutcomeBanner({ ok, message, stepUp = false }: Outcome): JSX.Element {
  return (
    <output
      aria-live="polite"
      style={{ display: "inline-flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}
    >
      <StatusPill label={message} tone={ok ? "success" : "error"} />
      {stepUp ? <ReverifyLink /> : null}
    </output>
  );
}

/** A keyset "Load more" affordance shared by the cursor-paged lists. */
export function LoadMore({
  hasMore,
  loading,
  onMore,
}: { hasMore: boolean; loading: boolean; onMore: () => void }): JSX.Element | null {
  if (!hasMore) return null;
  return (
    <div style={{ padding: "0.75rem", textAlign: "center" }}>
      <button
        type="button"
        onClick={onMore}
        disabled={loading}
        style={actionButtonStyle(false, loading)}
      >
        {loading ? "Loading…" : "Load more"}
      </button>
    </div>
  );
}
