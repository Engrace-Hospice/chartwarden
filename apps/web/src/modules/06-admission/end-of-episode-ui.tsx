import {
  Glyph,
  type GlyphName,
  InfoRows,
  Panel,
  PatientWorkspaceLayout,
  StatusPill,
  type StatusTone,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/06-admission — the shared frame of the M6 end-of-episode workflows (discharge /
// revocation / transfer-out, death & pronouncement, for-cause cosign, transfer-in), drawn in the 2026-09-25
// redesign idiom the HOPE workspace established: the patient chart banner, a step navigator on the left
// (`.wx-hope-nav`), flat clinical sections in the centre (`.wx-clinical-section`), the field anatomy of
// label · required/optional mark · control · hint or error (`.wx-hope-field`), a locked value for anything
// the workflow controls (`.wx-locked-value`), the footer action bar (`.wx-hope-footer`), and the right
// context rail (admission, what happens on submit, patient summary). Modules may not import each other, so
// this re-draws the HOPE anatomy on the same global classes rather than importing its components.
import { type JSX, type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ChartBanner,
  PatientSummaryPanel,
  fmtDate,
  useChartIdentity,
} from "../../shell/patient-context";
import { ADMISSION_TONE, stateLabel } from "./admission-status";

// ---------- admission context ----------

/** The slice of GET /api/v1/admissions/:id these workflows read. */
export interface EpisodeAdmission {
  id: string;
  state: string;
  version: number;
  patientId?: string;
  admissionAt?: string | null;
  hospicePhysicianId?: string | null;
  hospicePhysician?: { id: string; displayName: string; npi?: string | null } | null;
}

export type Loadable<T> = T | null | "error";

/** Loads the admission aggregate once; `null` while loading, `"error"` when it is not visible. */
export function useEpisodeAdmission(
  admissionId: string | null | undefined,
  /** Bump to re-read the admission after a write (keeps the current one on screen meanwhile). */
  refreshKey = 0,
): Loadable<EpisodeAdmission> {
  const client = useApiClient();
  const [admission, setAdmission] = useState<Loadable<EpisodeAdmission>>(null);
  const loadedId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!admissionId) {
      setAdmission("error");
      return;
    }
    let active = true;
    const refreshing = loadedId.current === admissionId && refreshKey > 0;
    loadedId.current = admissionId;
    if (!refreshing) setAdmission(null);
    void Promise.resolve()
      .then(() => client.GET("/api/v1/admissions/{id}", { params: { path: { id: admissionId } } }))
      .then(({ data, error }) => {
        if (!active) return;
        if (error || !data) {
          // A failed refresh keeps the admission already on screen; only a first load fails the page.
          if (!refreshing) setAdmission("error");
          return;
        }
        setAdmission(data as EpisodeAdmission);
      })
      .catch(() => {
        if (active && !refreshing) setAdmission("error");
      });
    return () => {
      active = false;
    };
  }, [client, admissionId, refreshKey]);
  return admission;
}

// ---------- error mapping ----------

/** The `{ error: { code } }` envelope the M1 error handler returns. */
export function errorCodeOf(err: unknown): string | undefined {
  return (err as { error?: { code?: string } } | null | undefined)?.error?.code;
}

/** The first failing field of a VALIDATION_FAILED envelope, when the server named one. */
export function errorFieldOf(err: unknown): string | undefined {
  return (err as { error?: { details?: { field?: string }[] } } | null | undefined)?.error
    ?.details?.[0]?.field;
}

/**
 * Codes every end-of-episode write can return, mapped to a sentence the clinician can act on. A workflow
 * passes its own `specific` map first; anything unmapped falls back by HTTP status.
 */
export function endOfEpisodeMessage(
  status: number | undefined,
  code: string | undefined,
  specific: Record<string, string>,
  fallback: string,
): string {
  if (code && specific[code]) return specific[code];
  if (code === "VERSION_MISMATCH")
    return "This record changed since it was opened. Reload the page and review it before trying again.";
  if (code === "ILLEGAL_TRANSITION" || code === "INVALID_STATE")
    return "The admission is not in a state that allows this action. Reload to see its current state.";
  if (status === 403) return "You do not have permission for this action.";
  if (status === 404) return "This record was not found or is not visible to you.";
  if (status === 400 || status === 422) return "Validation failed. Check the values you entered.";
  return fallback;
}

// ---------- dates ----------

/** Today as a local calendar date (YYYY-MM-DD) — the clinician's day, not UTC's. */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` slice of an ISO timestamp (or the date itself), else `""`. */
export function dateOnly(value: string | null | undefined): string {
  const m = value ? /^(\d{4}-\d{2}-\d{2})/.exec(value) : null;
  return m ? (m[1] ?? "") : "";
}

// ---------- workspace frame ----------

/**
 * The patient workspace every end-of-episode workflow sits in: the chart banner (with a "Back to
 * admission" action) over the workflow, and the right context rail ending in the patient summary.
 */
export function EpisodeWorkspace({
  patientId,
  backTo,
  rail,
  children,
}: {
  patientId: string | undefined;
  backTo: string;
  rail: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const identity = useChartIdentity(patientId);
  const banner = identity ? (
    <ChartBanner
      identity={identity}
      actions={
        <Link to={backTo} className="wx-btn-secondary">
          <Glyph name="chevron-left" size={16} /> Back to admission
        </Link>
      }
    />
  ) : patientId ? (
    <div className="wx-patient-banner" aria-busy="true" style={{ minHeight: "6.25rem" }} />
  ) : null;
  return (
    <PatientWorkspaceLayout
      banner={banner}
      rail={
        <>
          {rail}
          <PatientSummaryPanel identity={identity} />
        </>
      }
    >
      {children}
    </PatientWorkspaceLayout>
  );
}

/**
 * A status pill sized for the narrow rail cards: a long label ("Notice Of Rights Acknowledged") wraps inside
 * the card instead of running past its right edge, and the full label stays available as the tooltip.
 */
export function RailStatusPill({ label, tone }: { label: string; tone: StatusTone }): JSX.Element {
  return (
    <span
      className="wx-rail-status-pill"
      title={label}
      style={{ display: "inline-block", maxWidth: "100%" }}
    >
      <StatusPill
        tone={tone}
        label={<span style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{label}</span>}
      />
    </span>
  );
}

/** Rail card: the admission this workflow acts on. */
export function AdmissionPanel({
  admission,
  extra = [],
}: {
  admission: EpisodeAdmission;
  extra?: { label: string; value: ReactNode; hint?: string }[];
}): JSX.Element {
  const admitted = dateOnly(admission.admissionAt);
  return (
    <Panel title="Admission" icon="clipboard-check">
      <InfoRows
        labelWidth="7rem"
        rows={[
          {
            label: "Status",
            value: (
              <RailStatusPill
                label={stateLabel(admission.state)}
                tone={ADMISSION_TONE[admission.state] ?? "neutral"}
              />
            ),
          },
          { label: "Admitted", value: admitted ? fmtDate(admitted) : "—" },
          ...extra,
        ]}
      />
    </Panel>
  );
}

/** Rail card: what the server runs when the workflow submits, stated plainly (never live status). */
export function WhatHappensPanel({
  title = "What happens on submit",
  children,
}: {
  title?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Panel title={title} icon="activity">
      {children}
    </Panel>
  );
}

export interface WhatHappensItem {
  icon: GlyphName;
  text: ReactNode;
}

/** The cascade list: one glyph + sentence per downstream effect. */
export function WhatHappensList({
  items,
  compact = false,
  label,
}: {
  items: readonly WhatHappensItem[];
  compact?: boolean;
  label?: string;
}): JSX.Element {
  return (
    <ul
      aria-label={label ?? (compact ? "Summary of what happens on submit" : "What happens")}
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "grid",
        gap: compact ? "0.5rem" : "0.75rem",
        fontSize: compact ? "0.8125rem" : "0.875rem",
        color: "var(--color-on-surface)",
      }}
    >
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static, ordered list.
        <li key={i} style={{ display: "flex", gap: "0.625rem", alignItems: "flex-start" }}>
          <span style={{ color: "var(--color-primary)", marginTop: "0.0625rem" }} aria-hidden>
            <Glyph name={item.icon} size={compact ? 15 : 18} />
          </span>
          <span>{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------- step navigator ----------

export type StepState = "complete" | "attention" | "empty";

export interface NavStep {
  id: string;
  title: string;
  state: StepState;
  /** Status line under the title ("Complete", "Needs attention", "Not started"). */
  line: string;
  /** Whether the step can be opened from the navigator. */
  open: boolean;
}

/** Sequential progress: every step before `current` is complete, the rest not started. */
/** Steps for a linear workflow at step `current`; pass `titles.length` once the final (success) step is
 *  reached so every step — the success step included — reads Complete. */
export function linearSteps(titles: readonly string[], current: number): NavStep[] {
  return titles.map((title, i) => ({
    id: String(i),
    title,
    state: i < current ? "complete" : "empty",
    line: i < current ? "Complete" : i === current ? "In progress" : "Not started",
    open: false,
  }));
}

export function StepNav({
  label,
  heading,
  steps,
  activeId,
  onSelect,
}: {
  label: string;
  heading: string;
  steps: readonly NavStep[];
  activeId: string | null;
  onSelect?: (id: string) => void;
}): JSX.Element {
  return (
    <aside className="wx-hope-admission-rail">
      <nav className="wx-hope-nav wx-hope-admission-section-nav" aria-label={label}>
        <div className="wx-hope-nav-title">{heading}</div>
        <ol>
          {steps.map((s, i) => {
            const isActive = s.id === activeId;
            return (
              <li key={s.id} className={isActive ? "active" : undefined}>
                <button
                  type="button"
                  onClick={() => s.open && onSelect?.(s.id)}
                  disabled={!s.open}
                  aria-current={isActive ? "step" : undefined}
                  aria-label={`${s.title} — ${s.line}`}
                >
                  <span className={`wx-hope-step wx-hope-step-${isActive ? "active" : s.state}`}>
                    {s.state === "complete" && !isActive ? (
                      <Glyph name="check" size={14} strokeWidth={3} />
                    ) : (
                      i + 1
                    )}
                  </span>
                  <span className="wx-hope-nav-text">
                    <span className="wx-hope-nav-label">{s.title}</span>
                    <span className={`wx-hope-nav-status wx-hope-nav-status-${s.state}`}>
                      {s.line}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
    </aside>
  );
}

// ---------- centre column ----------

export function WorkflowHead({
  eyebrow = "Admission",
  title,
  stepLine,
  detail,
}: {
  eyebrow?: string;
  title: string;
  stepLine?: string;
  detail?: string;
}): JSX.Element {
  return (
    <header className="wx-hope-head">
      <div>
        <p className="wx-hope-eyebrow">{eyebrow}</p>
        <h1 className="wx-hope-title">{title}</h1>
        {stepLine ? (
          <p className="wx-hope-step-line">
            {stepLine}
            {detail ? <span> · {detail}</span> : null}
          </p>
        ) : null}
      </div>
    </header>
  );
}

export function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: GlyphName;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="wx-clinical-section">
      <header>
        <span className="wx-clinical-section-icon" aria-hidden>
          <Glyph name={icon} size={22} strokeWidth={1.6} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
      </header>
      <div className="wx-clinical-section-body">{children}</div>
    </section>
  );
}

/** Field anatomy of the redesign: label · required/optional mark, control, then hint/source or error. */
export function Field({
  id,
  label,
  required,
  optional,
  locked,
  source,
  hint,
  error,
  full,
  children,
}: {
  id: string;
  label: ReactNode;
  required?: boolean;
  optional?: boolean;
  locked?: boolean;
  source?: string;
  hint?: ReactNode;
  error?: string;
  /** Span the whole field grid row. */
  full?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={full ? "wx-hope-field wx-field-grid-full" : "wx-hope-field"}>
      <div className="wx-hope-field-head">
        <label htmlFor={id} className="wx-hope-field-label">
          {label}
          {required && !locked ? (
            <span className="wx-required-mark" aria-hidden>
              {" "}
              *
            </span>
          ) : null}
          {optional ? (
            <span className="wx-optional-mark" aria-hidden>
              Optional
            </span>
          ) : null}
        </label>
      </div>
      {children}
      {/* The hint (e.g. which claim patient status the answer sets) stays visible beside an error, so the
          person fixing the field still sees why it matters. */}
      {source || hint ? <div className="wx-hope-field-hint">{source ?? hint}</div> : null}
      {error ? (
        <div className="wx-hope-field-msg wx-hope-field-msg-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** A value the workflow controls: a locked, read-only field with the lock glyph and a source line. */
export function LockedField({
  id,
  label,
  value,
  source,
  full,
}: {
  id: string;
  label: string;
  value: string;
  source: string;
  full?: boolean;
}): JSX.Element {
  return (
    <Field id={id} label={label} locked source={source} full={full}>
      <div className="wx-locked-value">
        <input id={id} readOnly aria-readonly="true" value={value} />
        <span aria-hidden>
          <Glyph name="lock" size={15} strokeWidth={1.75} />
        </span>
      </div>
    </Field>
  );
}

export interface ChoiceOption<V extends string> {
  value: V;
  label: string;
  hint?: string;
}

/** A required single choice drawn as option rows (`.wx-option-row`), with an error line under it. */
export function ChoiceRows<V extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  error,
  hint,
}: {
  name: string;
  legend: string;
  options: readonly ChoiceOption<V>[];
  value: V | "";
  onChange: (value: V) => void;
  error?: string;
  hint?: ReactNode;
}): JSX.Element {
  return (
    <fieldset className="wx-choice-fieldset">
      <legend className="wx-hope-field-label">
        {legend}
        <span className="wx-required-mark" aria-hidden>
          {" "}
          *
        </span>
      </legend>
      <div className="wx-option-rows">
        {options.map((o) => {
          const checked = value === o.value;
          return (
            <label
              key={o.value}
              className={checked ? "wx-option-row checked" : "wx-option-row"}
              style={{ alignItems: "flex-start", padding: "0.65rem 0.875rem" }}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={checked}
                aria-label={o.label}
                onChange={() => onChange(o.value)}
              />
              <span className="wx-tile-text">
                <span style={{ fontWeight: 600 }}>{o.label}</span>
                {o.hint ? <small>{o.hint}</small> : null}
              </span>
            </label>
          );
        })}
      </div>
      {hint ? <div className="wx-hope-field-hint">{hint}</div> : null}
      {error ? (
        <p className="wx-hope-field-msg wx-hope-field-msg-error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** Review rows as a key/value list (`.wx-kv`). */
export function ReviewList({
  rows,
}: {
  rows: readonly { term: string; value: ReactNode; multiline?: boolean }[];
}): JSX.Element {
  return (
    <dl className="wx-kv">
      {rows.map((r) => (
        <ReviewRow key={r.term} term={r.term} value={r.value} multiline={r.multiline} />
      ))}
    </dl>
  );
}

function ReviewRow({
  term,
  value,
  multiline,
}: {
  term: string;
  value: ReactNode;
  multiline?: boolean;
}): JSX.Element {
  return (
    <>
      <dt>{term}</dt>
      <dd style={multiline ? { whiteSpace: "pre-wrap" } : undefined}>{value}</dd>
    </>
  );
}

/** The attestation checkbox tile the confirm step ends with. */
export function AttestTile({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className={checked ? "wx-tile checked" : "wx-tile"}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span className="wx-tile-text">
        <span>{children}</span>
      </span>
    </label>
  );
}

/** The footer action bar under the centre column: a note on the left, actions on the right. */
export function WorkflowFooter({
  note,
  children,
}: {
  note: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <footer className="wx-hope-footer">
      <span className="wx-hope-footer-note">{note}</span>
      <div style={{ display: "flex", gap: "0.625rem" }}>{children}</div>
    </footer>
  );
}

export const bodyText = {
  margin: 0,
  fontSize: "0.875rem",
  color: "var(--color-on-surface-variant)",
} as const;
