// apps/web/src/modules/07-care-plan/change-proposals — the right-hand drawer of one proposal on the plan's review list: what it says as
// label/value rows, and (for someone who may decide) Accept, or Dismiss with a coded reason. The drawer only collects the choice; the
// owner runs the write and hands back `busy` / `error`.
import { Button, Drawer, InlineAlert, SelectField, StatusPill } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { proposalFacts, proposalHeading } from "./proposal-facts";
import {
  DISMISSAL_REASON_LABEL,
  KIND_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  optionsOf,
} from "./proposal-labels";
import type { ChangeProposal, DismissalReason } from "./proposal-types";

const NO_REASON = { value: "", label: "No reason given" } as const;
const REASON_OPTIONS = [NO_REASON, ...optionsOf(DISMISSAL_REASON_LABEL)];

export interface ProposalDrawerProps {
  readonly proposal: ChangeProposal;
  readonly canDecide: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  /** A link to the visit note this came from, or null when the viewer cannot open it. */
  readonly visitPath: string | null;
  /** The problem proposal this goal or intervention hangs off is still waiting: it must be accepted first. */
  readonly waitsOnParent: boolean;
  readonly onAccept: () => void;
  readonly onDismiss: (reason: DismissalReason | undefined) => void;
  readonly onClose: () => void;
}

function reasonFrom(value: string): DismissalReason | undefined {
  return value in DISMISSAL_REASON_LABEL ? (value as DismissalReason) : undefined;
}

export function ProposalDrawer({
  proposal,
  canDecide,
  busy,
  error,
  visitPath,
  waitsOnParent,
  onAccept,
  onDismiss,
  onClose,
}: ProposalDrawerProps): JSX.Element {
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const decidable = canDecide && proposal.status === "pending";
  const close = (): void => {
    if (!busy) onClose();
  };

  const footer = !decidable ? null : dismissing ? (
    <>
      <Button tone="secondary" disabled={busy} onClick={() => setDismissing(false)}>
        Back
      </Button>
      <Button tone="danger" loading={busy} onClick={() => onDismiss(reasonFrom(reason))}>
        Dismiss proposal
      </Button>
    </>
  ) : (
    <>
      <Button tone="secondary" disabled={busy} onClick={() => setDismissing(true)}>
        Dismiss
      </Button>
      <Button loading={busy} onClick={onAccept}>
        Accept
      </Button>
    </>
  );

  return (
    <Drawer
      title={KIND_LABEL[proposal.kind]}
      label={`Proposed change: ${proposalHeading(proposal)}`}
      subtitle={
        <StatusPill label={STATUS_LABEL[proposal.status]} tone={STATUS_TONE[proposal.status]} />
      }
      onClose={close}
      closeDisabled={busy}
      footer={footer}
    >
      <dl className="wx-kv">
        {proposalFacts(proposal).map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {visitPath ? <Link to={visitPath}>Open the visit note</Link> : null}
      {proposal.status === "pending" && waitsOnParent ? (
        <InlineAlert tone="info">
          This belongs to a new problem proposed in the same visit. Accept the problem first.
        </InlineAlert>
      ) : null}
      {decidable && !dismissing ? (
        <p className="wx-action-hint">Accepting applies this change to the plan.</p>
      ) : null}
      {proposal.status === "pending" && !canDecide ? (
        <p className="wx-action-hint">
          Only a case manager or a supervisor can accept or dismiss a proposed change.
        </p>
      ) : null}
      {decidable && dismissing ? (
        <SelectField
          label="Reason for dismissing"
          hint="Optional. Recorded with the decision."
          options={REASON_OPTIONS}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      ) : null}
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
    </Drawer>
  );
}
