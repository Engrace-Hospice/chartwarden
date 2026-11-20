// apps/web/src/modules/07-care-plan/change-proposals — the review list on the Care Plans tab: the plan changes clinicians proposed from
// their visit notes (WF09). A visit never writes into the signed plan; each change waits here, grouped by the visit it came from,
// until the case manager or a supervisor accepts or dismisses it. Accepted and dismissed history is one switch away.
//
// A row opens the right-hand drawer (proposal-drawer.tsx). `canDecide` only decides which controls to show: the server is the only
// enforcement (accept needs `care_plan.author` and runs under the accepter's discipline scope). Proposal text is clinical free text:
// it is rendered, never put in a URL or a log line.
import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  SelectField,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../../../shell/session";
import {
  type ProposalResult,
  acceptProposal,
  dismissProposal,
  listPlanProposals,
} from "./change-proposals-api";
import { ProposalDrawer } from "./proposal-drawer";
import { dateOf, nameOf, proposalSummary, targetLabelOf } from "./proposal-facts";
import {
  DISMISSAL_REASON_LABEL,
  KIND_LABEL,
  REDACTED_COPY,
  STALE_LIST_CODES,
  STATUS_LABEL,
  STATUS_TONE,
  errorCodeOf,
} from "./proposal-labels";
import type { ChangeProposal, DismissalReason, ReviewStatus } from "./proposal-types";

export interface PendingChangeProposalsProps {
  readonly planId: string;
  readonly patientId: string;
  /** Show Accept and Dismiss (the viewer holds `care_plan.author`). The server enforces it either way. */
  readonly canDecide: boolean;
  /** Called after a proposal was decided: `accepted` means the plan itself changed, so the caller should re-read it. */
  readonly onDecided?: (outcome: "accepted" | "dismissed") => void;
}

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly proposals: readonly ChangeProposal[];
      readonly redacted: boolean;
      /** The last quiet re-read failed: what is shown may be out of date. */
      readonly staleMessage: string | null;
    };

const STATUS_OPTIONS = [
  { value: "pending", label: "Waiting for review" },
  { value: "accepted", label: "Accepted" },
  { value: "dismissed", label: "Dismissed" },
] as const;

const EMPTY_COPY: Readonly<Record<ReviewStatus, { title: string; description: string }>> = {
  pending: {
    title: "Nothing to review",
    description:
      "Changes proposed in visit notes appear here once the visit is finalized. Nothing changes on the plan until someone accepts it.",
  },
  accepted: {
    title: "No accepted changes yet",
    description: "Proposed changes that were accepted into the plan are listed here.",
  },
  dismissed: {
    title: "No dismissed changes",
    description: "Proposed changes that were dismissed are listed here.",
  },
};

const ACCEPTED_NOTICE = "Change accepted. The plan now includes it.";
const DISMISSED_NOTICE = "Proposed change dismissed. The plan was not changed.";

interface VisitGroup {
  readonly encounterId: string;
  readonly proposals: readonly ChangeProposal[];
  readonly recordedAt: string;
  readonly proposers: string;
}

/** One group per source visit; inside a group the oldest first, so a new problem precedes the goals and interventions that hang off it. */
function groupByVisit(proposals: readonly ChangeProposal[], oldestFirst: boolean): VisitGroup[] {
  const byVisit = new Map<string, ChangeProposal[]>();
  for (const p of proposals)
    byVisit.set(p.sourceEncounterId, [...(byVisit.get(p.sourceEncounterId) ?? []), p]);
  const groups = [...byVisit].map(([encounterId, rows]) => {
    const sorted = [...rows].sort((a, b) => a.proposedAt.localeCompare(b.proposedAt));
    const proposers = [...new Set(sorted.map((p) => nameOf(p.proposedBy)))].join(", ");
    return { encounterId, proposals: sorted, recordedAt: sorted[0]?.proposedAt ?? "", proposers };
  });
  return groups.sort((a, b) =>
    oldestFirst
      ? a.recordedAt.localeCompare(b.recordedAt)
      : b.recordedAt.localeCompare(a.recordedAt),
  );
}

const visitPathOf = (patientId: string, encounterId: string): string =>
  `/patients/${patientId}/encounters/${encounterId}`;

export function PendingChangeProposals({
  planId,
  patientId,
  canDecide,
  onDecided,
}: PendingChangeProposalsProps): JSX.Element {
  const client = useApiClient();
  const canOpenVisit = useSession()?.permissions?.includes("encounter.read") ?? false;
  const [status, setStatus] = useState<ReviewStatus>("pending");
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-reads the list after a decision or "Try again".
  useEffect(() => {
    let active = true;
    void listPlanProposals(client, planId, status).then((res) => {
      if (!active) return;
      if (res.ok) {
        setLoad({
          kind: "ready",
          proposals: res.value.proposals,
          redacted: res.value.redacted,
          staleMessage: null,
        });
      } else {
        // A failed quiet re-read keeps the rows already shown and says they may be out of date.
        setLoad((prev) =>
          prev.kind === "ready"
            ? { ...prev, staleMessage: res.message }
            : { kind: "error", message: res.message },
        );
      }
    });
    return () => {
      active = false;
    };
  }, [client, planId, status, reloadKey]);

  function chooseStatus(next: string): void {
    const chosen = STATUS_OPTIONS.find((option) => option.value === next);
    if (!chosen || chosen.value === status) return;
    setStatus(chosen.value);
    setLoad({ kind: "loading" });
    setSelectedId(null);
    setDecisionError(null);
    setNotice(null);
  }

  const proposals = load.kind === "ready" ? load.proposals : [];
  const selected = proposals.find((p) => p.id === selectedId) ?? null;

  async function decide(
    send: () => Promise<ProposalResult<unknown>>,
    outcome: "accepted" | "dismissed",
  ): Promise<void> {
    setBusy(true);
    setDecisionError(null);
    const res = await send();
    setBusy(false);
    if (res.ok) {
      setSelectedId(null);
      setNotice(outcome === "accepted" ? ACCEPTED_NOTICE : DISMISSED_NOTICE);
      setReloadKey((key) => key + 1);
      onDecided?.(outcome);
      return;
    }
    setDecisionError(res.message);
    const code = errorCodeOf(res.body);
    // Someone else decided it, or it is no longer ours to see: the list is stale.
    if (res.status === 404 || (code !== null && STALE_LIST_CODES.has(code))) {
      setReloadKey((key) => key + 1);
    }
  }

  const accept = (proposal: ChangeProposal): Promise<void> =>
    decide(() => acceptProposal(client, planId, proposal.id), "accepted");
  const dismiss = (proposal: ChangeProposal, reason: DismissalReason | undefined): Promise<void> =>
    decide(() => dismissProposal(client, planId, proposal.id, reason), "dismissed");

  const history = status !== "pending";
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
    { id: "summary", header: "Proposed", cell: (p) => proposalSummary(p) },
    {
      id: "by",
      header: "Proposed by",
      priority: "secondary",
      cell: (p) => (
        <>
          {nameOf(p.proposedBy)}
          <span className="wx-row-sub">{dateOf(p.proposedAt)}</span>
        </>
      ),
    },
    ...(history
      ? [
          {
            id: "decided",
            header: "Decided by",
            priority: "secondary" as const,
            cell: (p: ChangeProposal) => (
              <>
                {p.decidedBy ? nameOf(p.decidedBy) : "—"}
                <span className="wx-row-sub">
                  {[
                    dateOf(p.decidedAt),
                    p.dismissalReason && DISMISSAL_REASON_LABEL[p.dismissalReason],
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </>
            ),
          },
          {
            id: "status",
            header: "Status",
            cell: (p: ChangeProposal) => (
              <StatusPill label={STATUS_LABEL[p.status]} tone={STATUS_TONE[p.status]} />
            ),
          },
        ]
      : []),
  ];

  return (
    <div className={`wx-list-drawer is-embedded${selected ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <h2 className="wx-section-title">Proposed changes from visits</h2>
        <p className="wx-action-hint">
          Clinicians record these in a visit note. Nothing changes on the plan until it is accepted
          here.
        </p>
        <SelectField
          label="Show"
          options={STATUS_OPTIONS}
          value={status}
          onChange={(event) => chooseStatus(event.target.value)}
        />
        {notice ? <InlineAlert tone="success">{notice}</InlineAlert> : null}
        {decisionError && !selected ? (
          <InlineAlert tone="error">{decisionError}</InlineAlert>
        ) : null}

        {load.kind === "loading" ? <LoadingSpinner label="Loading proposed changes" /> : null}
        {load.kind === "error" ? (
          <div className="wx-action-row is-middle">
            <InlineAlert tone="error">{load.message}</InlineAlert>
            <Button
              tone="secondary"
              size="sm"
              onClick={() => {
                setLoad({ kind: "loading" });
                setReloadKey((key) => key + 1);
              }}
            >
              Try again
            </Button>
          </div>
        ) : null}
        {load.kind === "ready" && load.staleMessage ? (
          <div className="wx-action-row is-middle">
            <InlineAlert tone="warning">
              {load.staleMessage} What is shown may be out of date.
            </InlineAlert>
            <Button tone="secondary" size="sm" onClick={() => setReloadKey((key) => key + 1)}>
              Try again
            </Button>
          </div>
        ) : null}
        {load.kind === "ready" && load.redacted ? (
          <InlineAlert tone="info">{REDACTED_COPY}</InlineAlert>
        ) : null}

        {load.kind === "ready" && proposals.length === 0 ? (
          <EmptyState
            title={EMPTY_COPY[status].title}
            description={EMPTY_COPY[status].description}
          />
        ) : null}

        {groupByVisit(proposals, status === "pending").map((group) => (
          <section
            key={group.encounterId}
            aria-label={`Visit recorded ${dateOf(group.recordedAt)}`}
          >
            <div className="wx-drawer-title-row">
              <h3 className="wx-section-title">Visit recorded {dateOf(group.recordedAt)}</h3>
              <span className="wx-row-sub">Proposed by {group.proposers}</span>
              {canOpenVisit ? (
                <Link to={visitPathOf(patientId, group.encounterId)}>Open the visit note</Link>
              ) : null}
            </div>
            <DataTable
              ariaLabel={`Proposed changes from the visit recorded ${dateOf(group.recordedAt)}`}
              rows={group.proposals}
              columns={columns}
              getRowId={(p) => p.id}
              selectedRowId={selectedId}
              onRowSelect={(p) => {
                setSelectedId(p.id);
                setDecisionError(null);
                setNotice(null);
              }}
            />
          </section>
        ))}
      </div>

      {selected ? (
        <ProposalDrawer
          key={selected.id}
          proposal={selected}
          canDecide={canDecide}
          busy={busy}
          error={decisionError}
          visitPath={canOpenVisit ? visitPathOf(patientId, selected.sourceEncounterId) : null}
          waitsOnParent={proposals.some(
            (p) => p.id === selected.parentProposalId && p.status === "pending",
          )}
          onAccept={() => void accept(selected)}
          onDismiss={(reason) => void dismiss(selected, reason)}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}
