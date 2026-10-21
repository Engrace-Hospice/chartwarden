import { Panel, t } from "@chartwarden/ui";
// apps/web/src/shell — the plan-of-care goals donut shared by the Care Plans and IDG chart tabs
// (2026-09-25 redesign, mockup "Goals Overview" / "Goals Progress"). Counts come from the M7 goal
// statuses only; there is no per-goal progress percentage in WardenX, so none is drawn.
import type { JSX, ReactNode } from "react";

export interface GoalStatusLike {
  status: string;
}

export function goalParts(
  goals: GoalStatusLike[],
): { label: string; value: number; color: string }[] {
  return [
    {
      label: "In progress",
      value: goals.filter((x) => x.status === "in_progress" || x.status === "revised").length,
      color: t.primary,
    },
    { label: "Met", value: goals.filter((x) => x.status === "met").length, color: t.success },
    {
      label: "Not met",
      value: goals.filter((x) => x.status === "not_met").length,
      color: "var(--color-viz-amber)",
    },
    {
      label: "Not started",
      value: goals.filter((x) => x.status === "not_started").length,
      color: t.outline,
    },
  ];
}

export function GoalsProgressPanel({
  goals,
  title = "Goals Progress",
  action,
}: {
  goals: GoalStatusLike[];
  title?: string;
  action?: ReactNode;
}): JSX.Element {
  const parts = goalParts(goals);
  return (
    <Panel title={title} icon="heart" action={action}>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
        <Donut parts={parts} total={goals.length} />
        <ul className="wx-legend">
          {parts.map((p) => (
            <li key={p.label}>
              <span aria-hidden style={{ background: p.color }} />
              <strong className="wx-nums">{p.value}</strong> {p.label}
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

export function Donut({
  parts,
  total,
}: { parts: { value: number; color: string }[]; total: number }): JSX.Element {
  const size = 104;
  const r = size / 2 - 9;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${total} goals`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={t.surfaceHigh}
        strokeWidth="11"
      />
      {total > 0
        ? parts
            .filter((p) => p.value > 0)
            .map((p) => {
              const len = (p.value / total) * c;
              const el = (
                <circle
                  key={p.color}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={p.color}
                  strokeWidth="11"
                  strokeDasharray={`${len} ${c - len}`}
                  strokeDashoffset={-offset}
                  transform={`rotate(-90 ${size / 2} ${size / 2})`}
                />
              );
              offset += len;
              return el;
            })
        : null}
      <text
        x="50%"
        y="46%"
        textAnchor="middle"
        dominantBaseline="central"
        style={{ fontFamily: t.fontSans, fontSize: 22, fontWeight: 700, fill: t.onSurface }}
      >
        {total}
      </text>
      <text
        x="50%"
        y="66%"
        textAnchor="middle"
        dominantBaseline="central"
        style={{ fontFamily: t.fontSans, fontSize: 11, fill: t.onSurfaceVariant }}
      >
        Goals
      </text>
    </svg>
  );
}
