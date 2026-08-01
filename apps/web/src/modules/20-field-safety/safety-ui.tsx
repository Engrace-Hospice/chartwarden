// apps/web/src/modules/20-field-safety — the shared Lantern presentation atoms every M20 screen reuses
// (Track B / ADR-0030, §5 / DESIGN.md §6.7). Extracted so the fourteen screens share ONE No-Line table
// vocabulary, one card, one field and one modal chrome instead of re-declaring them per file (the M15
// discipline-ui.tsx / M16 bereavement-ui.tsx / M19 oncall-ui.tsx precedent — each web slice owns its own,
// because apps/web/src/modules/* may not import a sibling module).
//
// Zero raw hex — `t.*` / CSS-var tokens only, so `arch:design-tokens` stays green and the twilight dark
// mode is automatic.
//
// TWO ATOMS HERE EXIST FOR §5.4 (WCAG 2.1 AA) SPECIFICALLY, and neither is decorative:
//   • {@link SosButton} — SC 2.5.5's largest tap target on the screen, 44×44 CSS px minimum, red, with the
//     word "SOS" inside it. A colour-only emergency control fails SC 1.4.1 for the clinician most likely
//     to be using it one-handed in the dark.
//   • {@link CancelCountdown} — SC 1.4.1's non-colour-only countdown: the ring AND the sentence "N seconds
//     to cancel", announced through an assertive live region so a screen-reader user gets the same
//     realtime feedback a sighted one does (SC 4.1.3).
import { StatusPill, t } from "@wardenx/ui";
import type { StatusTone } from "@wardenx/ui";
import type { CSSProperties, JSX, ReactNode } from "react";
import {
  CHECK_IN_STATUS_TONE,
  INCIDENT_SEVERITY_TONE,
  INCIDENT_STATE_TONE,
  OVERDUE_BADGE_TONE,
  SOS_STATE_TONE,
  checkInStatusLabel,
  humanize,
  sosStateLabel,
  toneOf,
} from "./safety-status";

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

/** Screen-reader-only text — keeps a control labelled without occupying visual space (§5.4). */
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
export const mutedStyle: CSSProperties = { fontSize: "0.8rem", color: t.onSurfaceVariant };
export const alertStyle: CSSProperties = { margin: 0, fontSize: "0.82rem", color: t.error };
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
  // §5.4 — the field clinician is the primary MOBILE user of this module, so every control clears the
  // 44 CSS-px SC 2.5.5 floor: the padding below plus the 0.82rem line box does it on a phone.
  padding: "0.7rem 1.1rem",
  borderRadius: t.radiusMd,
  border: "none",
  cursor: "pointer",
  background: t.primary,
  color: t.onPrimary,
  fontSize: "0.82rem",
  fontWeight: 600,
  minHeight: "2.75rem",
};
export const ghostButtonStyle: CSSProperties = {
  padding: "0.7rem 1.1rem",
  borderRadius: t.radiusMd,
  border: "none",
  cursor: "pointer",
  background: t.surfaceContainer,
  color: t.onSurface,
  fontSize: "0.82rem",
  fontWeight: 600,
  textDecoration: "none",
  minHeight: "2.75rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};
export const dangerButtonStyle: CSSProperties = {
  ...primaryButtonStyle,
  background: t.error,
  // `onEmphasis`, not `onPrimary`: the token exists precisely for text on a saturated STATUS fill, and it
  // is theme-reactive (white in light, twilight ink in dark). `onPrimary` is the brand fill's pair and
  // would be the wrong contrast partner on red in one of the two themes.
  color: t.onEmphasis,
};
export const disabledButtonStyle: CSSProperties = {
  ...ghostButtonStyle,
  cursor: "not-allowed",
  opacity: 0.5,
};

// ── modal chrome (the §5 ceremonies: acknowledge, resolve, sign off, transition, grant) ────────────────
export const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: t.scrim,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: t.space4,
  zIndex: 1000,
};
export const modalStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: t.space4,
  width: "min(36rem, 100%)",
  maxHeight: "90vh",
  overflowY: "auto",
  background: t.surfaceLowest,
  borderRadius: t.radiusXl,
  boxShadow: t.shadowFloat,
  padding: t.space5,
};
export const modalTitleStyle: CSSProperties = {
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

/** A horizontal filter row — the §5 ledger filter bar. */
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
  hint,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "number" | "date" | "datetime-local" | "email" | "tel";
  placeholder?: string;
  hint?: string;
  mono?: boolean;
}): JSX.Element {
  const hintId = hint ? `${label.replace(/\W+/g, "-").toLowerCase()}-hint` : undefined;
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={{ fontSize: "0.7rem", color: t.onSurfaceVariant }}>{label}</span>
      <input
        aria-label={label}
        aria-describedby={hintId}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        // A mono field needs its own floor: every glyph is wider, so `inputStyle`'s 9rem clipped the
        // placeholder that tells the caller what happens if they leave it blank ("all locations in
        // reach" wanted 180px of a 170px content box). These fields take UUIDs, so 14rem is the
        // useful minimum rather than a round number.
        style={mono ? { ...inputStyle, fontFamily: t.fontMono, minWidth: "14rem" } : inputStyle}
      />
      {hint ? (
        <span id={hintId} style={mutedStyle}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

/**
 * A labelled multi-line field with the SERVER's minimum-length floor rendered as a live counter.
 *
 * The counter mirrors the server's own gate (§4.2's `minLength`, §3.3's `length(btrim(...))` CHECK) so the
 * clinician learns before the round trip — NEVER instead of it. It counts TRIMMED characters, because the
 * CHECK does: forty spaces satisfies a naive `.length` and is refused by the database, which is the worst
 * of both. Errors announce through an assertive live region (SC 3.3.1).
 */
export function TextAreaField({
  label,
  value,
  onChange,
  rows = 4,
  hint,
  minChars,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  hint?: string;
  minChars?: number;
}): JSX.Element {
  const slug = label.replace(/\W+/g, "-").toLowerCase();
  const hintId = hint ? `${slug}-hint` : undefined;
  const owed = minChars === undefined ? 0 : Math.max(0, minChars - value.trim().length);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={{ fontSize: "0.7rem", color: t.onSurfaceVariant }}>{label}</span>
      <textarea
        aria-label={label}
        aria-describedby={[hintId, minChars === undefined ? undefined : `${slug}-count`]
          .filter(Boolean)
          .join(" ")}
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
      {minChars === undefined ? null : (
        <span
          id={`${slug}-count`}
          role="status"
          aria-live="polite"
          style={{ ...mutedStyle, color: owed > 0 ? t.error : t.onSurfaceVariant }}
        >
          {owed > 0
            ? `${owed} more character${owed === 1 ? "" : "s"} required — the server asks for at least ${minChars}.`
            : `Minimum of ${minChars} characters met.`}
        </span>
      )}
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

/** A multi-select of wire-enum chips — `alert_kinds[]` is the only place M20 needs one. */
export function ChipMultiSelect({
  label,
  values,
  selected,
  onChange,
  labeller = humanize,
}: {
  label: string;
  values: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  labeller?: (v: string) => string;
}): JSX.Element {
  return (
    <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
      <legend style={{ fontSize: "0.7rem", color: t.onSurfaceVariant, padding: 0 }}>{label}</legend>
      <div style={{ display: "flex", flexWrap: "wrap", gap: t.space2 }}>
        {values.map((v) => {
          const on = selected.includes(v);
          return (
            <label
              key={v}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.4rem",
                padding: `${t.space1} ${t.space3}`,
                minHeight: "2.75rem",
                borderRadius: t.radiusMd,
                background: on ? t.surfaceContainer : t.surfaceLow,
                color: t.onSurface,
                fontSize: "0.82rem",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                aria-label={labeller(v)}
                checked={on}
                onChange={(e) =>
                  onChange(e.target.checked ? [...selected, v] : selected.filter((x) => x !== v))
                }
              />
              {labeller(v)}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** The §5 modal shell — backdrop + dialog + footer actions. Every M20 ceremony reuses it. */
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
    <div style={backdropStyle}>
      <div role="dialog" aria-modal="true" aria-label={title} style={modalStyle}>
        <h2 style={modalTitleStyle}>{title}</h2>
        {children}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: t.space2 }}>
          <button type="button" onClick={onClose} style={ghostButtonStyle}>
            Cancel
          </button>
          {footer}
        </div>
      </div>
    </div>
  );
}

/**
 * A tonal advisory strip. `tone` maps to a status token; the copy ALWAYS carries the reason, never a bare
 * colour (Hard Rule §10.10 — colour is never the only signal).
 *
 * `assertive` is §5.4's `aria-live='assertive'` case and is reserved for the messages in M20 that MUST
 * interrupt: an SOS raised, an SOS state change while the clinician is watching, a rejected cancel, and a
 * coordinate-access warning. Everything else is polite, because a screen that shouts at every state change
 * is one the clinician learns to ignore before the night it matters.
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

/** The SOS lifecycle badge. The state TEXT rides inside the pill (§10.10), so a monochrome print of a
 *  supervisor board still says which alerts are escalating. */
export function SosStatePill({ state }: { state: string }): JSX.Element {
  return <StatusPill label={sosStateLabel(state)} tone={toneOf(SOS_STATE_TONE, state)} />;
}

/** The overdue-ladder badge (D4). */
export function OverduePill({ state }: { state: string }): JSX.Element {
  return <StatusPill label={humanize(state)} tone={toneOf(OVERDUE_BADGE_TONE, state)} />;
}

/** The check-in attestation badge — the clinician's own words, as she chose them. */
export function CheckInStatusPill({ status }: { status: string }): JSX.Element {
  return (
    <StatusPill label={checkInStatusLabel(status)} tone={toneOf(CHECK_IN_STATUS_TONE, status)} />
  );
}

/** The incident lifecycle badge. */
export function IncidentStatePill({ state }: { state: string }): JSX.Element {
  return <StatusPill label={humanize(state)} tone={toneOf(INCIDENT_STATE_TONE, state)} />;
}

/** The incident severity badge. */
export function SeverityPill({ severity }: { severity: string }): JSX.Element {
  return <StatusPill label={humanize(severity)} tone={toneOf(INCIDENT_SEVERITY_TONE, severity)} />;
}

/** A count chip row — the §5 KPI tiles. COUNTS over a fetched page, never rates: M20 publishes no
 *  aggregate route (`SafetyMetricsProvider` is a SEAM for M30/M33, not an HTTP surface), and a rate
 *  computed from one page reads like a census. Each screen using this says so beside it. */
export function CountGrid({
  entries,
}: { entries: readonly { label: string; value: number | string; tone?: StatusTone }[] }): JSX.Element {
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
              color:
              e.tone === "critical" ? t.alert : e.tone === "error" ? t.error : t.onSurface,
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
 * A vertical timeline of `*_at` stamps with the actor that produced each — the §2.2.2 SOS ledger and the
 * §2.2.3 incident ledger share it. Entries with a null instant are DROPPED by the caller, not rendered as
 * "—": a step that has not happened is absent from a state narrative, never a blank row that reads like a
 * lost record.
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
 * The cipher three-state renderer (§8.4 / the read service's own rule).
 *
 * `null` narrative + `available: false` means "we cannot open it here" — the Phase-1 DEK decipher is not
 * bound — and that is a DIFFERENT answer from "there is no narrative". Rendering both as an em dash would
 * let a reviewer read an unopenable incident as an empty one, which is the failure the paired boolean on
 * the DTO exists to prevent.
 */
export function CipherText({
  value,
  available,
  emptyLabel = "Nothing recorded.",
}: { value: string | null; available: boolean; emptyLabel?: string }): JSX.Element {
  if (value !== null && value !== "")
    return (
      <p style={{ margin: 0, fontSize: "0.85rem", color: t.onSurface, whiteSpace: "pre-wrap" }}>
        {value}
      </p>
    );
  if (!available)
    return (
      <Notice tone="warning">
        <strong>Stored, but not readable here.</strong> This text rides the per-tenant encryption envelope
        and no decipher is bound in this deployment. The record is NOT empty — do not read this as
        "nothing was written".
      </Notice>
    );
  return <span style={mutedStyle}>{emptyLabel}</span>;
}

/**
 * §5.2 / §5.4 — the SOS control. Red, `t.error`-toned, at least 44×44 CSS px, with the WORD "SOS" inside
 * it and an explicit `aria-label` naming what it does.
 *
 * `disabled` renders visibly disabled with the reason beside it rather than hiding: a clinician who cannot
 * find the button assumes the app is broken; one who sees it greyed out with "your membership is not
 * field-eligible" knows who to ask. The button NEVER refuses for want of a coordinate — M20-F16 makes the
 * press succeed without one — so no disabled state here is ever about consent.
 */
export function SosButton({
  onPress,
  disabled,
  busy,
}: { onPress: () => void; disabled?: boolean; busy?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      aria-label="SOS — press to call for help now"
      onClick={onPress}
      disabled={disabled || busy}
      style={{
        minWidth: "11rem",
        minHeight: "11rem",
        borderRadius: "50%",
        border: "none",
        cursor: disabled || busy ? "not-allowed" : "pointer",
        background: disabled ? t.surfaceContainer : t.error,
        color: disabled ? t.onSurfaceVariant : t.onEmphasis,
        fontFamily: t.fontDisplay,
        fontSize: "2rem",
        fontWeight: 700,
        letterSpacing: "0.08em",
        boxShadow: disabled ? "none" : t.shadowFloat,
        opacity: busy ? 0.7 : 1,
      }}
    >
      {busy ? "SENDING…" : "SOS"}
    </button>
  );
}

/**
 * §5.2 / §5.4 (SC 1.4.1, SC 4.1.3) — the D5 cancel window, in BOTH colour and words.
 *
 * The ring is decorative (`aria-hidden`); the sentence is the accessible content and it is announced
 * assertively, because the whole point of the five seconds is that the clinician learns about them while
 * they are still running. Once the window closes the copy changes to say so — an expired countdown that
 * merely stopped moving would read as a UI that froze.
 */
export function CancelCountdown({
  secondsLeft,
  onCancel,
  biometricRequired,
  busy,
}: {
  secondsLeft: number;
  onCancel: () => void;
  biometricRequired: boolean;
  busy?: boolean;
}): JSX.Element {
  const open = secondsLeft > 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: t.space3 }}>
        <span
          aria-hidden="true"
          style={{
            width: "2.5rem",
            height: "2.5rem",
            borderRadius: "50%",
            border: `4px solid ${open ? t.error : t.surfaceContainer}`,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "0.9rem",
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
            color: open ? t.error : t.onSurfaceVariant,
          }}
        >
          {secondsLeft}
        </span>
        <p role="alert" aria-live="assertive" style={{ margin: 0, fontSize: "0.85rem" }}>
          {open
            ? `${secondsLeft} second${secondsLeft === 1 ? "" : "s"} to cancel. After that the alert cannot be withdrawn from here.`
            : "The cancel window has closed. This alert stays open until a responder acknowledges and resolves it."}
        </p>
      </div>
      {open ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <button type="button" onClick={onCancel} disabled={busy} style={ghostButtonStyle}>
            Cancel this SOS
          </button>
          <span style={mutedStyle}>
            {biometricRequired
              ? "Your agency requires a biometric check to cancel. A cancel that fails it is RECORDED and the alert keeps going — that is deliberate, so a phone taken from you cannot silence it."
              : "Your agency does not require a biometric check to cancel. The attempt is recorded either way."}
          </span>
        </div>
      ) : null}
    </div>
  );
}
