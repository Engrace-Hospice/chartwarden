// apps/web/src/modules/07-care-plan/change-proposals — the changes THIS visit proposed, as the note's author sees them: drafts can be
// edited or withdrawn until the visit is finalized, after which they wait on the review list (and later show their outcome here).
import { Button, DataTable, type DataTableColumn, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import { proposalSummary, targetLabelOf } from "./proposal-facts";
import { KIND_LABEL, STATUS_LABEL, STATUS_TONE } from "./proposal-labels";
import type { ChangeProposal } from "./proposal-types";

export interface VisitDraftsListProps {
  readonly proposals: readonly ChangeProposal[];
  /** Drafts can be edited and withdrawn (the note is editable). */
  readonly canEdit: boolean;
  /** Edit waits: a proposal form is open with input that would be lost. */
  readonly editDisabled?: boolean;
  /** The proposals being written (a withdraw in flight). */
  readonly busyIds: ReadonlySet<string>;
  readonly onEdit: (proposal: ChangeProposal) => void;
  readonly onWithdraw: (proposal: ChangeProposal) => void;
}

/** What names a proposal to a screen reader: its kind and its own text (the target alone repeats across a problem's goals). */
const nameOf = (p: ChangeProposal): string =>
  `${KIND_LABEL[p.kind]}: ${proposalSummary(p) || targetLabelOf(p)}`;

/** How many other drafts hang off `proposal` and are withdrawn with it. */
export const dependentDraftCount = (
  proposals: readonly ChangeProposal[],
  proposal: ChangeProposal,
): number =>
  proposals.filter((other) => other.parentProposalId === proposal.id && other.status === "draft")
    .length;

export function VisitDraftsList({
  proposals,
  canEdit,
  editDisabled = false,
  busyIds,
  onEdit,
  onWithdraw,
}: VisitDraftsListProps): JSX.Element {
  const dependents = (p: ChangeProposal): number => dependentDraftCount(proposals, p);
  const columns: DataTableColumn<ChangeProposal>[] = [
    {
      id: "change",
      header: "Change",
      cell: (p) => (
        <>
          <strong>{KIND_LABEL[p.kind]}</strong>
          {targetLabelOf(p) ? <span className="wx-row-sub">{targetLabelOf(p)}</span> : null}
        </>
      ),
    },
    {
      id: "summary",
      header: "Proposed",
      cell: (p) => (
        <>
          {proposalSummary(p)}
          {canEdit && p.status === "draft" && dependents(p) > 0 ? (
            <span className="wx-row-sub">
              Withdrawing this also withdraws its goals and interventions.
            </span>
          ) : null}
        </>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (p) => <StatusPill label={STATUS_LABEL[p.status]} tone={STATUS_TONE[p.status]} />,
    },
    ...(canEdit
      ? [
          {
            id: "actions",
            header: <span className="wx-sr-only">Actions</span>,
            cell: (p: ChangeProposal) =>
              p.status === "draft" ? (
                <div className="wx-action-row">
                  <Button
                    tone="secondary"
                    size="sm"
                    disabled={editDisabled || busyIds.has(p.id)}
                    aria-label={`Edit proposal: ${nameOf(p)}`}
                    onClick={() => onEdit(p)}
                  >
                    Edit
                  </Button>
                  <Button
                    tone="secondary"
                    size="sm"
                    loading={busyIds.has(p.id)}
                    aria-label={`Withdraw proposal: ${nameOf(p)}`}
                    onClick={() => onWithdraw(p)}
                  >
                    Withdraw
                  </Button>
                </div>
              ) : null,
          },
        ]
      : []),
  ];
  return (
    <DataTable
      ariaLabel="Changes proposed in this visit"
      rows={proposals}
      columns={columns}
      getRowId={(p) => p.id}
    />
  );
}
