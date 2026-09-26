import { Glyph, type GlyphName, Panel, StatusPill, t } from "@wardenx/ui";
// apps/web/src/modules/07-care-plan — the redesigned Care Plans tab pieces (2026-09-25, mockup
// "Plan of Care"): page header with the plan-version card, KPI cards, goal cards, the intervention
// list, and the right rail (Active Diagnoses, Goals Overview donut, Quick Links). Presentational only:
// every count and label is derived from the M7 workspace payload the view already loads. Goal
// progress percentages and priorities are not modeled in M7, so the cards carry status, not a bar.
import { type JSX, type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { GoalsProgressPanel } from "../../shell/goals-progress";
import type { CarePlan, Goal, Intervention, Problem, ReviewStatus, Version } from "./care-plan-api";
import { cap, toneFor } from "./care-plan-status";

const DISCIPLINE_LABEL: Record<string, string> = {
  rn: "Nursing",
  lpn: "Nursing",
  chha: "HHA",
  msw: "Social Work",
  chaplain: "Chaplain",
  volunteer: "Volunteer",
  bereavement: "Bereavement",
  md_np: "Medical",
  pt: "PT",
  ot: "OT",
  st: "Speech",
  music_therapy: "Music Therapy",
  dietitian: "Dietitian",
};
export const disciplineLabel = (d: string): string => DISCIPLINE_LABEL[d] ?? cap(d);

const OPEN_GOAL = ["not_started", "in_progress", "revised"];

/** Date-only strings ("2026-10-21") are calendar dates — parse them locally, not as UTC midnight. */
function toDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
function usDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = toDate(value);
  if (!d) return value;
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}
function longDate(value: string | null | undefined): string {
  if (!value) return "Not set";
  const d = toDate(value);
  return d
    ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : value;
}

// A goal's icon + tint is picked from its words so the list scans like the mockup (breathing → lungs,
// nutrition → utensils, pain → bolt …); anything else gets the generic target.
const GOAL_ICONS: [RegExp, GlyphName, string][] = [
  [/breath|dyspn|respir|airway/i, "lungs", "var(--color-viz-rose)"],
  [/nutri|intake|appetite|meal|eat|hydrat/i, "utensils", "var(--color-viz-green)"],
  [/pain|comfort/i, "zap", "var(--color-viz-rose)"],
  [/sleep|rest|insomnia/i, "bed", "var(--color-viz-blue)"],
  [/fall|safety|safe/i, "shield-check", "var(--color-viz-amber)"],
  [/dignity|quality|spirit|family|cop|grief|emotion|anxi/i, "heart", "var(--color-viz-green)"],
  [/skin|wound|pressure/i, "droplet", "var(--color-viz-violet)"],
];
function goalIcon(text: string): [GlyphName, string] {
  for (const [re, icon, color] of GOAL_ICONS) if (re.test(text)) return [icon, color];
  return ["target", "var(--color-viz-blue)"];
}

// ---------- header ----------

export function PlanHeader({
  plan,
  activeVersion,
  openVersion,
  actions,
}: {
  plan: CarePlan;
  activeVersion: Version | null;
  openVersion: Version | null;
  actions?: ReactNode;
}): JSX.Element {
  const shown = activeVersion ?? openVersion;
  const isActive = Boolean(activeVersion);
  return (
    <div className="wx-page-head">
      <div style={{ minWidth: 0 }}>
        <h1>Plan of Care</h1>
        <p>Manage goals, interventions, and outcomes for this patient's hospice care plan.</p>
      </div>
      <div style={{ display: "flex", alignItems: "stretch", gap: "0.75rem", flexWrap: "wrap" }}>
        <Link to={`/care-plans/${plan.id}/versions`} className="wx-version-card">
          <span
            aria-hidden
            className="wx-version-dot"
            style={{ background: isActive ? t.success : t.warning }}
          />
          <span style={{ minWidth: 0 }}>
            <strong>
              {shown
                ? `${isActive ? "Active Plan" : cap(shown.kind)} (v${shown.sequence})`
                : "No version yet"}
            </strong>
            <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <StatusPill
                label={isActive ? "Active" : cap(shown?.status ?? plan.status)}
                tone={isActive ? "success" : toneFor(shown?.status ?? plan.status)}
              />
              {shown?.signedAt ? (
                <span className="wx-row-sub">Effective {longDate(shown.signedAt)}</span>
              ) : shown?.draftedAt ? (
                <span className="wx-row-sub">Drafted {longDate(shown.draftedAt)}</span>
              ) : null}
            </span>
          </span>
          <Glyph name="chevron-down" size={16} />
        </Link>
        {actions}
      </div>
    </div>
  );
}

// ---------- KPI cards ----------

function Kpi({
  icon,
  color,
  value,
  label,
  hint,
}: {
  icon: GlyphName;
  color: string;
  value: ReactNode;
  label: string;
  hint: string;
}): JSX.Element {
  return (
    <div className="wx-stat-card">
      <span
        aria-hidden
        className="wx-stat-icon"
        style={{ color, background: `color-mix(in srgb, ${color} 12%, ${t.surfaceLowest})` }}
      >
        <Glyph name={icon} size={24} strokeWidth={1.6} />
      </span>
      <div style={{ minWidth: 0 }}>
        <strong className="wx-stat-value wx-nums">{value}</strong>
        <div style={{ color: t.onSurface, fontSize: "0.875rem" }}>{label}</div>
        <div className="wx-stat-label">{hint}</div>
      </div>
    </div>
  );
}

export function PlanStats({
  plan,
  review,
}: {
  plan: CarePlan;
  review: ReviewStatus | null;
}): JSX.Element {
  const goals = plan.goals;
  const ivs = plan.interventions;
  const disciplines = [
    ...new Set(ivs.filter((i) => i.status === "active").map((i) => disciplineLabel(i.discipline))),
  ];
  const due = review?.nextReviewDueAt ? toDate(review.nextReviewDueAt) : null;
  const days = due ? Math.ceil((due.getTime() - Date.now()) / 86_400_000) : null;
  return (
    <div className="wx-stat-grid" aria-label="Care Plan summary">
      <Kpi
        icon="target"
        color="var(--color-viz-rose)"
        value={goals.length}
        label="Goals"
        hint={`${goals.filter((g) => OPEN_GOAL.includes(g.status)).length} active • ${goals.filter((g) => g.status === "met").length} met`}
      />
      <Kpi
        icon="clipboard-check"
        color={t.primary}
        value={ivs.length}
        label="Interventions"
        hint={`${ivs.filter((i) => i.status === "active").length} active • ${ivs.filter((i) => i.status !== "active").length} ended`}
      />
      <Kpi
        icon="users"
        color={t.primary}
        value={disciplines.length}
        label="Disciplines"
        hint={disciplines.join(", ") || "None assigned"}
      />
      <Kpi
        icon="calendar"
        color={t.primary}
        value={due ? longDate(review?.nextReviewDueAt) : "—"}
        label="Next Review"
        hint={
          review?.status === "overdue"
            ? `Overdue by ${review.overdueByDays} day${review.overdueByDays === 1 ? "" : "s"}`
            : review?.status === "review_in_progress"
              ? "Review in progress"
              : days != null
                ? `in ${days} day${days === 1 ? "" : "s"}`
                : "Not scheduled"
        }
      />
    </div>
  );
}

// ---------- goals ----------

function Owner({ label }: { label: string }): JSX.Element {
  const initials = label
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
      <span className="wx-mini-avatar" aria-hidden>
        {initials}
      </span>
      {label}
    </span>
  );
}

export function GoalsList({
  plan,
  editable,
  onEdit,
  onAdd,
}: {
  plan: CarePlan;
  editable: boolean;
  onEdit: (goal: Goal) => void;
  onAdd: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const problems = new Map(plan.problems.map((p) => [p.id, p]));
  const needle = query.trim().toLowerCase();
  const goals = plan.goals.filter(
    (g) =>
      !needle ||
      `${g.revisedText ?? g.originalText} ${g.measurableOutcome ?? ""} ${problems.get(g.problemId)?.description ?? ""}`
        .toLowerCase()
        .includes(needle),
  );
  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      <ListTools
        query={query}
        onQuery={setQuery}
        placeholder="Search goals…"
        action={
          editable ? (
            <button type="button" className="wx-btn-primary" onClick={onAdd}>
              <Glyph name="plus" size={16} /> Add Goal
            </button>
          ) : null
        }
      />
      {goals.length === 0 ? (
        <div className="wx-list-state">
          <p style={{ margin: 0, color: t.onSurfaceVariant }}>
            {needle ? "No goals match your search." : "No goals recorded on this plan yet."}
          </p>
        </div>
      ) : (
        <ul className="wx-goal-list">
          {goals.map((g) => {
            const text = g.revisedText ?? g.originalText;
            const problem = problems.get(g.problemId);
            const owners = [
              ...new Set(
                plan.interventions
                  .filter((i) => i.goalRefs.includes(g.id) && i.status === "active")
                  .map((i) => disciplineLabel(i.discipline)),
              ),
            ];
            const [icon, color] = goalIcon(`${text} ${problem?.description ?? ""}`);
            return (
              <li key={g.id} className="wx-goal-card">
                <span
                  aria-hidden
                  className="wx-goal-icon"
                  style={{
                    color,
                    background: `color-mix(in srgb, ${color} 12%, ${t.surfaceLowest})`,
                  }}
                >
                  <Glyph name={icon} size={22} strokeWidth={1.75} />
                </span>
                <div className="wx-goal-main">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <h3>{text}</h3>
                    {problem?.kind === "terminal" ? (
                      <span className="wx-danger-chip">Terminal diagnosis</span>
                    ) : null}
                  </div>
                  {g.statusNote ? <p className="wx-row-sub">{g.statusNote}</p> : null}
                  <div className="wx-goal-facts">
                    <div>
                      <span>Related problem</span>
                      <span>
                        {problem
                          ? `${problem.description}${problem.icd10Code ? ` (${problem.icd10Code})` : ""}`
                          : "—"}
                      </span>
                    </div>
                    <div>
                      <span>Measurable outcome</span>
                      <span>{g.measurableOutcome ?? "—"}</span>
                    </div>
                    <div>
                      <span>Owner</span>
                      <span>{owners.length ? <Owner label={owners.join(", ")} /> : "—"}</span>
                    </div>
                    <div>
                      <span>Target date</span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                        <Glyph name="calendar" size={14} /> {usDate(g.targetAt)}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="wx-goal-side">
                  <StatusPill label={cap(g.status)} tone={toneFor(g.status)} />
                  {editable ? (
                    <button
                      type="button"
                      className="wx-icon-link"
                      aria-label={`Edit goal: ${text}`}
                      onClick={() => onEdit(g)}
                    >
                      <Glyph name="more-horizontal" size={18} />
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------- interventions ----------

export function InterventionsList({
  plan,
  editable,
  onEdit,
  onDiscontinue,
  onAdd,
}: {
  plan: CarePlan;
  editable: boolean;
  onEdit: (iv: Intervention) => void;
  onDiscontinue: (iv: Intervention) => void;
  onAdd: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const goals = new Map(plan.goals.map((g) => [g.id, g.revisedText ?? g.originalText]));
  const needle = query.trim().toLowerCase();
  const ivs = plan.interventions.filter(
    (i) =>
      !needle || `${i.scopeText} ${i.discipline} ${i.frequencyText}`.toLowerCase().includes(needle),
  );
  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      <ListTools
        query={query}
        onQuery={setQuery}
        placeholder="Search interventions…"
        action={
          editable ? (
            <button type="button" className="wx-btn-primary" onClick={onAdd}>
              <Glyph name="plus" size={16} /> Add Intervention
            </button>
          ) : null
        }
      />
      {ivs.length === 0 ? (
        <div className="wx-list-state">
          <p style={{ margin: 0, color: t.onSurfaceVariant }}>
            {needle ? "No interventions match your search." : "No interventions recorded yet."}
          </p>
        </div>
      ) : (
        <div className="wx-list-table-wrap">
          <table className="wx-list-table wx-list-table-static">
            <caption className="wx-sr-only">Care plan interventions</caption>
            <thead>
              <tr>
                <th scope="col">Intervention</th>
                <th scope="col">Discipline</th>
                <th scope="col">Frequency</th>
                <th scope="col">Supports goal</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="wx-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {ivs.map((i) => (
                <tr key={i.id}>
                  <td>
                    <span
                      className="wx-row-bar"
                      aria-hidden
                      style={{ background: i.status === "active" ? t.primary : t.outline }}
                    />
                    <strong>{i.scopeText}</strong>
                    {i.discontinueReason ? (
                      <span className="wx-row-sub">{i.discontinueReason}</span>
                    ) : i.linkedOrderId ? (
                      <span className="wx-row-sub">Linked order on file</span>
                    ) : null}
                  </td>
                  <td>
                    <Owner label={disciplineLabel(i.discipline)} />
                  </td>
                  <td>
                    {i.frequencyText}
                    {i.frequencyValue ? (
                      <span className="wx-row-sub">{i.frequencyValue}</span>
                    ) : null}
                  </td>
                  <td>
                    {i.goalRefs
                      .map((id) => goals.get(id))
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </td>
                  <td>
                    <StatusPill label={cap(i.status)} tone={toneFor(i.status)} />
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {editable ? (
                      <>
                        <button
                          type="button"
                          className="wx-icon-link"
                          aria-label={`Edit intervention: ${i.scopeText}`}
                          onClick={() => onEdit(i)}
                        >
                          <Glyph name="pencil" size={15} />
                        </button>
                        {i.status === "active" ? (
                          <button
                            type="button"
                            className="wx-icon-link"
                            aria-label={`Discontinue intervention: ${i.scopeText}`}
                            onClick={() => onDiscontinue(i)}
                          >
                            <Glyph name="x-circle" size={15} />
                          </button>
                        ) : null}
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ListTools({
  query,
  onQuery,
  placeholder,
  action,
}: {
  query: string;
  onQuery: (q: string) => void;
  placeholder: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="wx-list-toolbar-end" style={{ flex: "none" }}>
      <label className="wx-search-field">
        <Glyph name="search" size={16} />
        <input
          type="search"
          aria-label={placeholder.replace("…", "")}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={placeholder}
        />
      </label>
      {action}
    </div>
  );
}

// ---------- rail ----------

export function CarePlanRail({
  plan,
  patientId,
  summary,
  canAddGoal,
  onAddGoal,
}: {
  plan: CarePlan;
  patientId: string;
  summary: ReactNode;
  canAddGoal: boolean;
  onAddGoal: () => void;
}): JSX.Element {
  const dx = plan.problems.filter((p: Problem) => p.status === "active");
  const g = plan.goals;

  const links: { label: string; icon: GlyphName; to?: string; onClick?: () => void }[] = [
    ...(canAddGoal ? [{ label: "Add Goal", icon: "plus" as GlyphName, onClick: onAddGoal }] : []),
    { label: "Version History", icon: "rotate-ccw", to: `/care-plans/${plan.id}/versions` },
    { label: "View IDG Notes", icon: "grid-circles", to: `/patients/${patientId}/idg-history` },
    { label: "Discipline Plans", icon: "users", to: `/patients/${patientId}/discipline-plans` },
    { label: "Print Care Plan", icon: "printer", to: `/care-plans/${plan.id}/summary` },
    {
      label: "View Assessments",
      icon: "clipboard-check",
      to: `/patients/${patientId}/assessments`,
    },
    { label: "View Medications", icon: "pill", to: `/patients/${patientId}/medications` },
  ];
  return (
    <>
      {summary}
      <Panel title={`Active Diagnoses (${dx.length})`} icon="shield-check">
        {dx.length === 0 ? (
          <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.8125rem" }}>
            None recorded.
          </p>
        ) : (
          <ul className="wx-dx-list">
            {dx.slice(0, 6).map((p) => (
              <li key={p.id} style={{ gridTemplateColumns: "4rem minmax(0, 1fr)" }}>
                <span className="wx-dx-code">{p.icd10Code ?? "—"}</span>
                <span className="wx-dx-desc">{p.description}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <GoalsProgressPanel goals={g} title="Goals Overview" />
      <Panel title="Quick Links" icon="link" flush>
        <ul className="wx-rail-links">
          {links.map((l) => {
            const inner = (
              <>
                <span style={{ color: t.primary }}>
                  <Glyph name={l.icon} size={17} strokeWidth={1.75} />
                </span>
                <span style={{ flex: 1 }}>{l.label}</span>
                <Glyph name="chevron-right" size={16} strokeWidth={1.75} />
              </>
            );
            return (
              <li key={l.label}>
                {l.to ? (
                  <Link to={l.to}>{inner}</Link>
                ) : (
                  <button type="button" className="wx-rail-link-button" onClick={l.onClick}>
                    {inner}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </Panel>
    </>
  );
}
