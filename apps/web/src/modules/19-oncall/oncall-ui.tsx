// apps/web/src/modules/19-oncall — the shared Lantern presentation atoms every M19 screen reuses
// (Track B / ADR-0030, §5). Cards, fields and tables come from the kit now (`Panel`, the value-field adapters
// re-exported below, the base table chrome and the `wx-*` text classes); what remains here is the modal chrome
// and a few layout constants (the M15 discipline-ui.tsx / M16 bereavement-ui.tsx / M21 supplies-ui.tsx
// precedent — each web slice owns its own, because apps/web/src/modules/* may not import a sibling module).
//
// Zero raw hex — `t.*` / CSS-var tokens only, so `arch:design-tokens` stays green and the twilight dark
// mode is automatic.
import { Button, Modal as SharedModal, StatusPill, t } from "@chartwarden/ui";
import type { CSSProperties, JSX, ReactNode } from "react";
import {
  CALL_STATE_TONE,
  ESCALATION_TIER_TONE,
  humanize,
  tierLabel,
  toneOf,
} from "./oncall-status";

// ── numeric table cells: the table's own chrome (padding, hairlines, header weight) is the kit's; a number
// column only right-aligns and sets tabular figures ───────────────────────────────────────────────────
export const thNum: CSSProperties = { textAlign: "right" };
export const tdNum: CSSProperties = { textAlign: "right", fontVariantNumeric: "tabular-nums" };

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
export const primaryButtonStyle: CSSProperties = {
  // §5.4 — 44×44 is the Apple HIG / Material AA floor, and the on-call clinician is the primary MOBILE
  // user of this module. The padding below plus the 0.82rem line box clears it on a phone.
  padding: "0.7rem 1.1rem",
  borderRadius: t.radiusMd,
  border: "none",
  cursor: "pointer",
  background: t.primary,
  color: t.onPrimary,
  fontSize: "0.875rem",
  fontWeight: 600,
  minHeight: "2.75rem",
};
export const ghostButtonStyle: CSSProperties = {
  padding: "0.7rem 1.1rem",
  borderRadius: t.radiusMd,
  border: `1px solid ${t.cardBorder}`,
  cursor: "pointer",
  background: t.surfaceLowest,
  color: t.onSurface,
  fontSize: "0.875rem",
  fontWeight: 600,
  textDecoration: "none",
  minHeight: "2.75rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};
export const disabledButtonStyle: CSSProperties = {
  ...ghostButtonStyle,
  cursor: "not-allowed",
  opacity: 0.5,
};

// ── modal chrome (the §5 ceremonies: identify, apply protocol, disposition, escalate, resolve) ─────────
const modalTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontSize: "1.1rem",
  fontWeight: 500,
  color: t.onSurface,
};

/** A label/value pair — the summary-grid and card atom (mono for identifiers, per §8's identifier rule). */
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

/** A horizontal filter row — the §5 queue filter bar. */
export function FilterRow({ children }: { children: ReactNode }): JSX.Element {
  return <div className="wx-filter-panel">{children}</div>;
}

// The text, select and textarea fields are the kit's, behind string-valued `onChange(value)` adapters.
// §5.2's voice-dictation-aware fields are ordinary textareas: dictation is the platform's, and marking a field
// "dictation-aware" in markup we do not read back would be a claim the app cannot honour.
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
        minHeight: "2.75rem",
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

/** The §5 modal shell — backdrop + dialog + footer actions. Every M19 ceremony reuses it. Delegates
 * to `@chartwarden/ui`'s focus-trapped `Modal` (UI-005) for the scrim, Escape-to-close, and focus
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
    <SharedModal open onClose={onClose} ariaLabel={title} width="36rem">
      <div style={{ display: "flex", flexDirection: "column", gap: t.space4, padding: t.space5 }}>
        <h2 style={modalTitleStyle}>{title}</h2>
        {children}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: t.space2 }}>
          <Button tone="secondary" size="lg" type="button" onClick={onClose}>
            Cancel
          </Button>
          {footer}
        </div>
      </div>
    </SharedModal>
  );
}

/**
 * A tonal advisory strip. `tone` maps to a status token; the copy ALWAYS carries the reason, never a bare
 * colour (Hard Rule §10.10 — colour is never the only signal).
 *
 * `live` renders the strip as a polite live region; `assertive` is §5.4's `aria-live='assertive'` case and
 * is reserved for the two messages in M19 that must interrupt: a red-flag answer and a mandatory
 * escalation. Everything else is polite, because a panel that shouts at every state change is one the
 * clinician learns to ignore before the night it matters.
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

/** The call-state badge. The state TEXT rides inside the pill (§10.10), so a monochrome print of a
 *  supervisor board still says which calls are escalated. */
export function CallStatePill({ state }: { state: string }): JSX.Element {
  return <StatusPill label={humanize(state)} tone={toneOf(CALL_STATE_TONE, state)} />;
}

/** The escalation-tier badge — the ladder rung, spelled out. */
export function TierPill({ tier }: { tier: string }): JSX.Element {
  return <StatusPill label={tierLabel(tier)} tone={toneOf(ESCALATION_TIER_TONE, tier)} />;
}

/**
 * A vertical timeline of `*_at` stamps with the actor that produced each — the §5.1 call history and the
 * shift lifecycle share it. Entries with a null instant are DROPPED by the caller, not rendered as "—": a
 * step that has not happened is absent from a state narrative, never a blank row that reads like a lost
 * record.
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
      {entries.map((e, i) => (
        <li key={`${e.label}-${e.at}-${i}`} style={{ display: "flex", gap: t.space3 }}>
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

/**
 * The §8.2 redaction marker. A withheld category is SHOWN as withheld — a clinician who does not know the
 * medication list is incomplete reads "no opioid on file" as a clinical fact, which is the one failure mode
 * redaction-without-notice creates that no-redaction does not (`read-service.ts` rule 3).
 */
export function RedactionNotice({
  categories,
}: { categories: readonly string[] }): JSX.Element | null {
  if (categories.length === 0) return null;
  const label = categories.map((c) => humanize(c)).join(", ");
  return (
    <Notice tone="warning" live>
      Some content on this call is withheld from you: <strong>{label}</strong>. The record is
      incomplete as shown — this is a consent/authority decision the server made, not an absence of
      data.
    </Notice>
  );
}
