import { Glyph, InlineAlert, Panel, t, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/06-admission — shared pieces of the M6 end-of-episode workflows (Death &
// Pronouncement, for-cause medical-director cosign, transfer-in), in the 2026-09-25 redesign idiom:
// flat ClinicalSection-style sections (`.wx-clinical-section`), a field anatomy of label · required
// mark · muted code tag · control · source line (`.wx-hope-field`), read-only workflow-controlled values
// as a locked field with a "From …" line, the four-dot `.wx-stepper`, and a right context rail
// (`.wx-with-rail`). The HOPE module owns the React components these classes were first drawn with;
// modules may not import each other, so this file re-draws the same anatomy on the same global classes.
import { type JSX, type ReactNode, useEffect, useState } from "react";

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
export function useEpisodeAdmission(admissionId: string | undefined): Loadable<EpisodeAdmission> {
  const client = useApiClient();
  const [admission, setAdmission] = useState<Loadable<EpisodeAdmission>>(null);
  useEffect(() => {
    if (!admissionId) {
      setAdmission("error");
      return;
    }
    let active = true;
    setAdmission(null);
    void client
      .GET("/api/v1/admissions/{id}", { params: { path: { id: admissionId } } })
      .then(({ data, error }) => {
        if (!active) return;
        setAdmission(error || !data ? "error" : (data as EpisodeAdmission));
      })
      .catch(() => {
        if (active) setAdmission("error");
      });
    return () => {
      active = false;
    };
  }, [client, admissionId]);
  return admission;
}

// ---------- error mapping ----------

/** The `{ error: { code } }` envelope the M1 error handler returns. */
export function errorCodeOf(err: unknown): string | undefined {
  return (err as { error?: { code?: string } } | null | undefined)?.error?.code;
}

/** The first failing field of a 400 VALIDATION_FAILED envelope, when the server named one. */
export function errorFieldOf(err: unknown): string | undefined {
  return (err as { error?: { details?: { field?: string }[] } } | null | undefined)?.error
    ?.details?.[0]?.field;
}

/**
 * Codes every end-of-episode write can return, mapped to a sentence the clinician can act on. A
 * workflow passes its own `specific` map first; anything unmapped falls back by HTTP status.
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

/** Today as a local `YYYY-MM-DD` (what an `<input type="date">` holds and the routes accept). */
export function todayLocal(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** `YYYY-MM-DD` slice of an ISO timestamp (or the date itself), else `""`. */
export function dateOnly(value: string | null | undefined): string {
  const m = value ? /^(\d{4}-\d{2}-\d{2})/.exec(value) : null;
  return m ? m[1]! : "";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `2026-09-24` → `Sep 24, 2026` (calendar date, no timezone shift); `—` when absent. */
export function longDate(value: string | null | undefined): string {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  if (!m) return "—";
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

// ---------- page frame ----------

export function EpisodePage({
  title,
  subtitle,
  breadcrumb,
  actions,
  rail,
  railLabel,
  children,
}: {
  title: string;
  subtitle: ReactNode;
  breadcrumb: ReactNode;
  actions?: ReactNode;
  rail: ReactNode;
  railLabel: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="wx-with-rail">
      <div className="wx-with-rail-main">
        <nav aria-label="Breadcrumb" style={{ fontSize: "0.8125rem", color: t.onSurfaceVariant }}>
          {breadcrumb}
        </nav>
        <header className="wx-page-head">
          <div>
            <h1 style={{ fontSize: "1.875rem" }}>{title}</h1>
            <p>{subtitle}</p>
          </div>
          {actions ? <div style={{ display: "flex", gap: "0.625rem" }}>{actions}</div> : null}
        </header>
        {children}
      </div>
      <aside className="wx-with-rail-side" aria-label={railLabel}>
        {rail}
      </aside>
    </div>
  );
}

// ---------- stepper ----------

export function WorkflowSteps({
  steps,
  current,
  label,
}: {
  steps: readonly string[];
  /** Index of the step in progress; every earlier step reads as done. `steps.length` = all done. */
  current: number;
  label: string;
}): JSX.Element {
  return (
    <ol
      className="wx-stepper"
      aria-label={label}
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
    >
      {steps.map((s, i) => {
        const done = i < current;
        const isCurrent = i === current;
        return (
          <li
            key={s}
            className={done ? "is-done" : isCurrent ? "is-current" : undefined}
            aria-current={isCurrent ? "step" : undefined}
          >
            <span className="wx-step-dot" aria-hidden>
              {done ? <Glyph name="check" size={12} strokeWidth={3} /> : i + 1}
            </span>
            <span>{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- flat section ----------

export function EpisodeSection({
  icon,
  title,
  description,
  aside,
  children,
}: {
  icon: Parameters<typeof Glyph>[0]["name"];
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
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
        {aside ? <div className="wx-clinical-section-aside">{aside}</div> : null}
      </header>
      <div className="wx-clinical-section-body">{children}</div>
    </section>
  );
}

// ---------- field anatomy ----------

/** Muted wire/CMS identifier on the right of a field label (e.g. the request field it lands in). */
export function CodeTag({ code }: { code: string }): JSX.Element {
  return <span className="wx-cms-code">{code}</span>;
}

export function EpisodeField({
  htmlFor,
  label,
  code,
  required,
  optional,
  hint,
  error,
  full,
  children,
}: {
  htmlFor?: string;
  label: ReactNode;
  code?: string;
  required?: boolean;
  optional?: boolean;
  /** Source / guidance line under the control. */
  hint?: ReactNode;
  error?: string | null;
  /** Span the whole field grid row. */
  full?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`wx-hope-field${full ? " wx-field-grid-full" : ""}`}>
      <div className="wx-hope-field-head">
        <label htmlFor={htmlFor} className="wx-hope-field-label">
          {label}
          {required ? (
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
        {code ? <CodeTag code={code} /> : null}
      </div>
      {children}
      {hint ? <div className="wx-hope-field-hint">{hint}</div> : null}
      {error ? <div className="wx-hope-field-msg wx-hope-field-msg-error">{error}</div> : null}
    </div>
  );
}

/** A value the workflow controls: a locked read-only field with the lock glyph and a source line. */
export function LockedField({
  id,
  label,
  value,
  source,
  code,
  full,
}: {
  id: string;
  label: string;
  value: string;
  source: ReactNode;
  code?: string;
  full?: boolean;
}): JSX.Element {
  return (
    <EpisodeField
      htmlFor={id}
      label={label}
      code={code}
      full={full}
      hint={
        <span>
          <Glyph name="lock" size={11} /> {source}
        </span>
      }
    >
      <div className="wx-locked-value">
        <input id={id} type="text" readOnly value={value} aria-readonly="true" />
        <span aria-hidden>
          <Glyph name="lock" size={15} strokeWidth={1.75} />
        </span>
      </div>
    </EpisodeField>
  );
}

// ---------- rail ----------

/** "What happens next" rail card: the server-side cascade, stated as what runs, never as live status. */
export function CascadePanel({
  title,
  items,
  footnote,
}: {
  title: string;
  items: { label: string; detail: string }[];
  footnote?: ReactNode;
}): JSX.Element {
  return (
    <Panel title={title} icon="activity">
      <ul className="wx-rail-list" style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {items.map((i) => (
          <li key={i.label}>
            <div>
              <strong>{i.label}</strong>
              <span>{i.detail}</span>
            </div>
          </li>
        ))}
      </ul>
      {footnote ? (
        <p style={{ margin: "0.75rem 0 0", fontSize: "0.75rem", color: t.onSurfaceVariant }}>
          {footnote}
        </p>
      ) : null}
    </Panel>
  );
}

/** Footer action row under the form sections. */
export function EpisodeActions({
  error,
  children,
}: {
  error: string | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      <div
        className="wx-sticky-footer"
        style={{ display: "flex", justifyContent: "flex-end", gap: "0.625rem", flexWrap: "wrap" }}
      >
        {children}
      </div>
    </div>
  );
}
