import { Glyph, type GlyphName, t } from "@wardenx/ui";
// apps/web/src/modules/10-hope — presentational pieces of the redesigned HOPE workspace (2026-09-25,
// mockups "HOPE Assessment — A. Administrative" and "J. Health Conditions"). The backend still owns
// the CMS spec, applicability, validation and signing; these components only draw it:
//   • one flat ClinicalSection card per clinical concept — no card-per-question nesting,
//   • a field anatomy of label · required mark · muted CMS code, control, then a source/provenance line,
//   • read-only (workflow-controlled) values as a locked field with a "From …" line, not a pill,
//   • CMS 0/1 checkbox items shown as one "select all that apply" tile group,
//   • single-choice items as full-width option rows carrying their CMS code.
import type { CSSProperties, JSX, ReactNode } from "react";

// ---------- section navigator (left) ----------

export type NavState = "complete" | "progress" | "attention" | "empty";

export interface NavSectionView {
  id: string;
  /** Visible label, e.g. "A. Administrative". */
  title: string;
  /** Accessible name kept stable for screen readers + tests, e.g. "A Administrative". */
  accessibleName: string;
  state: NavState;
  /** Actionable status line: "2 required fields", "3 of 8 complete", "Complete", "Not started". */
  statusLine: string;
}

export function SectionNavigator({
  sections,
  active,
  onSelect,
  ariaLabel,
  renderSub,
}: {
  sections: NavSectionView[];
  active: string;
  onSelect: (id: string) => void;
  ariaLabel: string;
  /** Nested rows under a section (its question groups); return null to show none. */
  renderSub?: (id: string) => ReactNode;
}): JSX.Element {
  return (
    <nav className="wx-hope-nav" aria-label={ariaLabel}>
      <div className="wx-hope-nav-title">HOPE Assessment</div>
      <ol>
        {sections.map((s, i) => {
          const isActive = s.id === active;
          return (
            <li key={s.id} className={isActive ? "active" : undefined}>
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                aria-current={isActive ? "step" : undefined}
                aria-label={`${s.accessibleName} — ${s.statusLine}`}
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
                    {s.state === "attention" ? <span className="wx-dot" aria-hidden /> : null}
                    {s.state === "complete" ? (
                      <Glyph name="check" size={12} strokeWidth={3} />
                    ) : null}
                    {s.statusLine}
                  </span>
                </span>
              </button>
              {renderSub?.(s.id) ?? null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface NavGroupView {
  key: string;
  label: string;
  state: NavState;
  /** "3 to answer", "Done" … */
  statusLine: string;
}

/** Sub-steps of one section (Option 1 rail): ✓ done · ◉ current · ○ to do · ! needs answers. */
export function GroupSubNav({
  groups,
  active,
  onSelect,
  label,
}: {
  groups: NavGroupView[];
  active: string | null;
  onSelect: (key: string) => void;
  label: string;
}): JSX.Element {
  return (
    <ul className="wx-hope-subnav" aria-label={label}>
      {groups.map((g) => {
        const isActive = g.key === active;
        return (
          <li key={g.key} className={isActive ? "active" : undefined}>
            <button
              type="button"
              onClick={() => onSelect(g.key)}
              aria-current={isActive ? "location" : undefined}
              aria-label={`${g.label} — ${g.statusLine}`}
            >
              <span
                className={`wx-hope-subnav-mark wx-hope-subnav-${isActive ? "active" : g.state}`}
              >
                {g.state === "complete" && !isActive ? (
                  <Glyph name="check" size={10} strokeWidth={3.5} />
                ) : null}
              </span>
              <span className="wx-hope-subnav-label">
                {g.label}
                {g.state === "attention" && !isActive ? (
                  <small className="wx-hope-subnav-count">{g.statusLine}</small>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------- section card ----------

export function ClinicalSection({
  id,
  icon,
  title,
  description,
  aside,
  children,
}: {
  id?: string;
  icon: GlyphName;
  title: ReactNode;
  description?: ReactNode;
  /** Right side of the header (CMS code tag, "Required" chip…). */
  aside?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section id={id} tabIndex={id ? -1 : undefined} className="wx-clinical-section">
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

/**
 * CMS item identifier: one look everywhere in HOPE — a blue tag pushed to the right edge of its row
 * (question head, field label, tile, group legend, skipped/pending row, SFV question).
 */
export function CmsCode({ code }: { code: string }): JSX.Element {
  return <span className="wx-cms-code">{code}</span>;
}

export function RequiredChip(): JSX.Element {
  return <span className="wx-required-chip">Required</span>;
}

// ---------- field anatomy ----------

export function FieldShell({
  id,
  htmlFor,
  label,
  code,
  required,
  optional,
  hint,
  messages,
  messageTone = "error",
  errorId,
  hintId,
  children,
}: {
  id: string;
  htmlFor?: string;
  label: ReactNode;
  code: string;
  required?: boolean;
  optional?: boolean;
  hint?: ReactNode;
  messages?: string[];
  messageTone?: "error" | "warning";
  errorId?: string;
  hintId?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div id={id} tabIndex={-1} className="wx-hope-field">
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
        <CmsCode code={code} />
      </div>
      {children}
      {hint ? (
        <div id={hintId} className="wx-hope-field-hint">
          {hint}
        </div>
      ) : (
        <span id={hintId} hidden />
      )}
      {messages && messages.length > 0 ? (
        <div id={errorId} className={`wx-hope-field-msg wx-hope-field-msg-${messageTone}`}>
          {messages.map((m) => (
            <div key={m}>{m}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A workflow-controlled value: a locked, focusable read-only field — the lock says "you can't edit". */
export function LockedValue({
  id,
  value,
  describedBy,
}: {
  id: string;
  value: string;
  describedBy?: string;
}): JSX.Element {
  return (
    <div className="wx-locked-value">
      <input
        id={id}
        type="text"
        readOnly
        value={value}
        aria-readonly="true"
        aria-describedby={describedBy}
      />
      <span aria-hidden>
        <Glyph name="lock" size={15} strokeWidth={1.75} />
      </span>
    </div>
  );
}

// ---------- choices ----------

export interface TileOption {
  key: string;
  label: ReactNode;
  code: string;
  checked: boolean;
  hint?: ReactNode;
  /** Why this tile is unavailable (a mutually exclusive choice is selected); greys it out. */
  blockedReason?: string;
}

/** "Select all that apply" — CMS 0/1 items rendered as one checkbox tile group. */
export function CheckboxTiles({
  id,
  legend,
  code,
  required,
  options,
  disabled,
  onToggle,
  columns = 3,
}: {
  id?: string;
  legend: ReactNode;
  code?: string;
  required?: boolean;
  options: TileOption[];
  disabled?: boolean;
  onToggle: (key: string, checked: boolean) => void;
  columns?: number;
}): JSX.Element {
  return (
    <fieldset
      id={id}
      tabIndex={id ? -1 : undefined}
      className="wx-choice-fieldset"
      disabled={disabled}
    >
      <legend className="wx-hope-field-label">
        {legend}
        {required ? <span className="wx-required-mark"> *</span> : null}
        {code ? <CmsCode code={code} /> : null}
      </legend>
      <div className="wx-tile-grid" style={{ "--wx-tile-cols": String(columns) } as CSSProperties}>
        {options.map((o) => {
          const blocked = !o.checked && Boolean(o.blockedReason);
          return (
            <label
              key={o.key}
              className={o.checked ? "wx-tile checked" : blocked ? "wx-tile blocked" : "wx-tile"}
              title={blocked ? o.blockedReason : undefined}
            >
              <input
                type="checkbox"
                checked={o.checked}
                disabled={blocked}
                aria-describedby={blocked ? `${o.key}-blocked` : undefined}
                onChange={(e) => onToggle(o.key, e.currentTarget.checked)}
              />
              <span className="wx-tile-text">
                <span>{o.label}</span>
                {o.hint ? <small>{o.hint}</small> : null}
              </span>
              <CmsCode code={o.code} />
            </label>
          );
        })}
      </div>
      {/* Reasons live outside the labels so they describe — not rename — the greyed checkboxes. */}
      {options.map((o) =>
        !o.checked && o.blockedReason ? (
          <span key={o.key} id={`${o.key}-blocked`} className="wx-sr-only">
            {o.blockedReason}
          </span>
        ) : null,
      )}
    </fieldset>
  );
}

/** Full-width single-choice rows: [radio] [CMS value code] [label] — mockup J0200. */
export function OptionRows({
  name,
  legend,
  options,
  value,
  disabled,
  describedBy,
  onChange,
  blockedReason,
  onClear,
}: {
  name: string;
  legend: string;
  options: { valueCode: string; label: string }[];
  value: string;
  disabled?: boolean;
  describedBy?: string;
  onChange: (valueCode: string) => void;
  /** Greys out every unchecked row (a competing answer — e.g. a typed value — is in place). */
  blockedReason?: string;
  /** Clicking the selected row again clears it (for optional special values). */
  onClear?: () => void;
}): JSX.Element {
  const twoCol = options.length > 4;
  return (
    <fieldset className="wx-choice-fieldset" aria-describedby={describedBy} disabled={disabled}>
      <legend className="wx-sr-only">{legend}</legend>
      <div className={twoCol ? "wx-option-rows two-col" : "wx-option-rows"}>
        {options.map((o) => {
          const checked = value === o.valueCode;
          const blocked = !checked && Boolean(blockedReason);
          return (
            <label
              key={o.valueCode}
              className={
                checked
                  ? "wx-option-row checked"
                  : blocked
                    ? "wx-option-row blocked"
                    : "wx-option-row"
              }
              title={blocked ? blockedReason : undefined}
            >
              <input
                type="radio"
                name={name}
                value={o.valueCode}
                checked={checked}
                disabled={blocked}
                aria-label={o.label}
                onChange={() => onChange(o.valueCode)}
                onClick={() => {
                  if (checked && onClear && !disabled) onClear();
                }}
              />
              <span>{o.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---------- rail widgets ----------

/** Donut ring for section completion (mockup "Section Completion"). */
export function CompletionRing({
  percent,
  size = 96,
}: { percent: number; size?: number }): JSX.Element {
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${p}% complete`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={t.surfaceHigh}
        strokeWidth="9"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={t.primary}
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={`${(c * p) / 100} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        style={{ fontFamily: t.fontSans, fontSize: size * 0.2, fontWeight: 700, fill: t.onSurface }}
      >
        {p}%
      </text>
    </svg>
  );
}

export function LegendDot({ color, label }: { color: string; label: ReactNode }): JSX.Element {
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        fontSize: "0.8125rem",
        color: t.onSurface,
      }}
    >
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 9999, background: color }} />
      {label}
    </span>
  );
}

/** Thin progress bar ("3 of 8 complete") — decorative; the adjacent text states the numbers. */
export function ProgressBar({ value, max }: { value: number; max: number }): JSX.Element {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="wx-progress" aria-hidden>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
