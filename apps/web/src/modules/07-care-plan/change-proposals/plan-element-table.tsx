// apps/web/src/modules/07-care-plan/change-proposals — the plan's live problems, goals and interventions as one flat table for the
// visit's note: a toggle that says "addressed on this visit" (the visit <-> element link) and the actions that propose a change.
import { Button, DataTable, type DataTableColumn, StatusPill } from "@chartwarden/ui";
import { type JSX, memo } from "react";
import type { CarePlan } from "../care-plan-api";
import { cap, isGoalEditable, isInterventionEditable } from "../care-plan-status";
import type { ChangeProposal, ProposalKind, VisitLink, VisitLinkTarget } from "./proposal-types";

export type ElementType = "problem" | "goal" | "intervention";

export interface PlanElementRow {
  readonly type: ElementType;
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

const TYPE_LABEL: Readonly<Record<ElementType, string>> = {
  problem: "Problem",
  goal: "Goal",
  intervention: "Intervention",
};
const PROBLEM_ORDER: Readonly<Record<string, number>> = { terminal: 0, related: 1, unrelated: 2 };
const LIVE_PROPOSAL = new Set(["draft", "pending"]);
/** The kinds whose target is the element itself (a new goal or intervention only names the problem it hangs off). */
const TOUCHES_ELEMENT = new Set<ProposalKind>([
  "problem_resolve",
  "goal_update",
  "intervention_discontinue",
]);

/** The live elements in reading order: each active problem, then its open goals, then its active interventions. */
export function planRows(plan: CarePlan): PlanElementRow[] {
  const problems = plan.problems
    .filter((p) => p.status === "active")
    .sort((a, b) => (PROBLEM_ORDER[a.kind] ?? 3) - (PROBLEM_ORDER[b.kind] ?? 3));
  return problems.flatMap((problem) => [
    {
      type: "problem" as const,
      id: problem.id,
      label: problem.description,
      detail: cap(problem.kind),
    },
    ...plan.goals
      .filter((g) => g.problemId === problem.id && isGoalEditable(g.status))
      .map((g) => ({
        type: "goal" as const,
        id: g.id,
        label: g.revisedText ?? g.originalText,
        detail: cap(g.status),
      })),
    ...plan.interventions
      .filter((i) => i.problemId === problem.id && isInterventionEditable(i.status))
      .map((i) => ({
        type: "intervention" as const,
        id: i.id,
        label: i.scopeText,
        detail: i.frequencyText,
      })),
  ]);
}

/** The live link that names this element (a visit link carries the id of the element it addresses). */
export function linkFor(links: readonly VisitLink[], row: PlanElementRow): VisitLink | undefined {
  return links.find((link) =>
    row.type === "problem"
      ? link.problemId === row.id
      : row.type === "goal"
        ? link.goalId === row.id
        : link.interventionId === row.id,
  );
}

/** The body that links a visit to this one element. */
export const linkTargetOf = (row: PlanElementRow): VisitLinkTarget =>
  row.type === "problem"
    ? { problemId: row.id }
    : row.type === "goal"
      ? { goalId: row.id }
      : { interventionId: row.id };

export interface PlanElementTableProps {
  readonly rows: readonly PlanElementRow[];
  readonly links: readonly VisitLink[];
  readonly drafts: readonly ChangeProposal[];
  /** The note is open for edits: the toggles work. */
  readonly canLink: boolean;
  /** The plan is open and the note is editable: the proposal actions show. */
  readonly canPropose: boolean;
  /** The proposal actions show but wait: another proposal is open with input that would be lost. */
  readonly actionsDisabled?: boolean;
  /** The elements whose link is being written (`type:id`, see {@link busyKeyOf}). */
  readonly busyKeys: ReadonlySet<string>;
  readonly onToggleLink: (row: PlanElementRow, linked: VisitLink | undefined) => void;
  readonly onPropose: (kind: ProposalKind, row: PlanElementRow) => void;
}

export const busyKeyOf = (row: PlanElementRow): string => `${row.type}:${row.id}`;

function PlanElementTableView({
  rows,
  links,
  drafts,
  canLink,
  canPropose,
  actionsDisabled = false,
  busyKeys,
  onToggleLink,
  onPropose,
}: PlanElementTableProps): JSX.Element {
  // An element a live proposal of this visit already resolves, updates or discontinues.
  const touched = new Set(
    drafts
      .filter((d) => LIVE_PROPOSAL.has(d.status) && TOUCHES_ELEMENT.has(d.kind))
      .map((d) => d.target?.id),
  );

  const action = (
    kind: ProposalKind,
    row: PlanElementRow,
    text: string,
    name: string,
  ): JSX.Element => (
    <Button
      tone="secondary"
      size="sm"
      aria-label={`${name}: ${row.label}`}
      disabled={actionsDisabled}
      onClick={() => onPropose(kind, row)}
    >
      {text}
    </Button>
  );

  const columns: DataTableColumn<PlanElementRow>[] = [
    {
      id: "linked",
      header: "Addressed on this visit",
      cell: (row) => (
        <label className="wx-action-check">
          <input
            type="checkbox"
            aria-label={`Addressed on this visit: ${row.label}`}
            checked={linkFor(links, row) !== undefined}
            disabled={!canLink || busyKeys.has(busyKeyOf(row))}
            onChange={() => onToggleLink(row, linkFor(links, row))}
          />
        </label>
      ),
    },
    {
      id: "element",
      header: "Plan item",
      cell: (row) => (
        <>
          <span className="wx-row-sub">{TYPE_LABEL[row.type]}</span>
          <strong>{row.label}</strong>
          {row.detail ? <span className="wx-row-sub">{row.detail}</span> : null}
          {touched.has(row.id) ? <StatusPill label="Change proposed" tone="progress" /> : null}
        </>
      ),
    },
    ...(canPropose
      ? [
          {
            id: "actions",
            header: "Propose a change",
            cell: (row: PlanElementRow) => (
              <div className="wx-action-row">
                {row.type === "problem" ? (
                  <>
                    {action("problem_resolve", row, "Resolve", "Resolve problem")}
                    {action("goal_add", row, "Add goal", "Add a goal to problem")}
                    {action(
                      "intervention_add",
                      row,
                      "Add intervention",
                      "Add an intervention to problem",
                    )}
                  </>
                ) : null}
                {row.type === "goal" ? action("goal_update", row, "Update", "Update goal") : null}
                {row.type === "intervention"
                  ? action(
                      "intervention_discontinue",
                      row,
                      "Discontinue",
                      "Discontinue intervention",
                    )
                  : null}
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <DataTable
      ariaLabel="Plan items for this visit"
      rows={rows}
      columns={columns}
      getRowId={busyKeyOf}
    />
  );
}

/** Memoised: the step holds stable handlers, so typing in a proposal form does not rebuild the table. */
export const PlanElementTable = memo(PlanElementTableView);
