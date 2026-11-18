// apps/web/src/modules/21-supplies — the shared Lantern presentation atoms every M21 screen reuses
// (Track B / ADR-0030, §5 / DESIGN.md §6.7). Extracted so the ten screens share ONE No-Line table
// vocabulary and one set of fields instead of re-declaring them per file. Panels, text fields, drawers and the
// table chrome are the kit's (`Panel`, `src/shell/value-fields`, `src/shell/form-drawer`); this file keeps what the kit
// has no atom for. Each web slice owns its own (the M15 discipline-ui.tsx / M16 bereavement-ui.tsx / M19 oncall-ui.tsx
// precedent), because apps/web/src/modules/* may not import a sibling module.
//
// Zero raw hex — `t.*` / CSS-var tokens only, so `arch:design-tokens` stays green and the twilight dark
// mode is automatic.
import { Button, StatusPill, t } from "@chartwarden/ui";
import type { StatusTone } from "@chartwarden/ui";
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
export const thNum: CSSProperties = { textAlign: "right" };
export const tdNum: CSSProperties = { textAlign: "right", fontVariantNumeric: "tabular-nums" };
/** A quantity cell — mono AND tabular, because a DEA count is read column-wise against another count. */
export const tdQty: CSSProperties = { ...tdNum, fontFamily: t.fontMono };

// ── page chrome ────────────────────────────────────────────────────────────────────────────────────────
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
const selectStyle: CSSProperties = {
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

/** A failed read, announced, with the way to try again (a list that cannot be refreshed offers nothing else). */
export function LoadFailure({
  message,
  onReload,
}: { message: string; onReload: () => void }): JSX.Element {
  return (
    <div
      role="alert"
      style={{ display: "flex", alignItems: "center", gap: t.space3, flexWrap: "wrap" }}
    >
      <span className="wx-text-error">{message}</span>
      <Button tone="secondary" type="button" onClick={onReload}>
        Reload
      </Button>
    </div>
  );
}

/** A horizontal filter row — the §5 queue filter bar. */
export function FilterRow({ children }: { children: ReactNode }): JSX.Element {
  return <div className="wx-filter-panel">{children}</div>;
}

// The kit-backed string-valued fields (label, hint and focus wiring live in the shared adapter).
export { SelectField, TextAreaField, TextField } from "../../shell/value-fields";

/** Turn a wire-enum list into `SelectField` options via a labeller. */
export function enumOptions(
  values: readonly string[],
  label: (v: string) => string = humanize,
): { value: string; label: string }[] {
  return values.map((v) => ({ value: v, label: label(v) }));
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

/** A count chip row — the §5.2 KPI tiles (COUNTS, never rates). `value: null` renders an em dash: the read
 *  behind the count did not succeed, so the count is unknown, not 0. */
export function CountGrid({
  entries,
}: {
  entries: readonly { label: string; value: number | null; tone?: StatusTone }[];
}): JSX.Element {
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
            {e.value ?? "—"}
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
