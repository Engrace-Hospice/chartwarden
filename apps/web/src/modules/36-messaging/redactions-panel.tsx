// M36 WP 5.6 (ADR-0055 item 7, ADR-0086, PROPOSED) - the Redactions tab of the retention governance screen: the newest redaction requests with their
// state as a word, who asked and who decided, the countersign deadline of a sole officer's provisional self-approval, and the actions the viewer can
// take (a person never decides their own request, except the provisional sole-officer path, which is only offered when the server says it is
// available). Message ids, names and instants only: never a message body or a reason. Step-up is handled like the hold dialogs.
import type { MessageRedactionDto } from "@chartwarden/types";
import { Button, EmptyState, StatusPill } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import { useStepUpOwner } from "../../shell/use-step-up-return";
import { DecisionDialog, RequestRedactionDialog } from "./redaction-dialogs";
import { type RedactionResume, decisionDraftKey } from "./redaction-drafts";
import * as R from "./redaction-wording";
import { LoadGate, formatTime } from "./retention-load-gate";
import { type DecisionKind, useRedactionActions, useRedactions } from "./use-redactions";

const person = (name: string | null, id: string | null, me: string | undefined): string => {
  if (id === null) return "";
  if (id === me) return R.YOU;
  return name ?? R.shortId(id);
};

/** The actions this viewer is offered on a row. The server is still the authority: a refused action reads as such. */
function offeredActions(
  row: MessageRedactionDto,
  me: string | undefined,
  fallbackAvailable: boolean,
): readonly DecisionKind[] {
  const mine = row.requested_by === me;
  switch (row.status) {
    case "requested":
      return mine ? (fallbackAvailable ? ["self_approve"] : []) : ["approve"];
    case "awaiting_countersign":
      return mine ? [] : ["countersign", "approve"];
    case "lapsed":
      return mine ? [] : ["approve"];
    default:
      return [];
  }
}

const VERB: Readonly<Record<DecisionKind, string>> = {
  approve: R.APPROVE_LABEL,
  countersign: R.COUNTERSIGN_LABEL,
  self_approve: R.SELF_APPROVE_LABEL,
};

function RedactionRow({
  row,
  me,
  fallbackAvailable,
  onDecide,
}: {
  readonly row: MessageRedactionDto;
  readonly me: string | undefined;
  readonly fallbackAvailable: boolean;
  readonly onDecide: (kind: DecisionKind) => void;
}): JSX.Element {
  const status = R.STATUS[row.status];
  const actions = offeredActions(row, me, fallbackAvailable);
  return (
    <li className="wx-retention-row">
      <div className="wx-retention-main">
        <span className="wx-retention-title">{R.messageText(row.message_id)}</span>
        <span className="wx-retention-detail">
          {R.requestedText(
            person(row.requested_by_name, row.requested_by, me),
            formatTime(row.requested_at),
          )}
        </span>
        {row.self_approved ? (
          <span className="wx-retention-detail">{R.SELF_APPROVED_TEXT}</span>
        ) : null}
        {row.countersign_deadline_at && row.status === "awaiting_countersign" ? (
          <span className="wx-retention-detail">
            {R.deadlineText(formatTime(row.countersign_deadline_at))}
          </span>
        ) : null}
        {row.countersigned_by ? (
          <span className="wx-retention-detail">
            {R.countersignedText(person(row.countersigned_by_name, row.countersigned_by, me))}
          </span>
        ) : null}
        {row.approved_at && !row.self_approved && row.approved_by ? (
          <span className="wx-retention-detail">
            {R.approvedText(
              person(row.approved_by_name, row.approved_by, me),
              formatTime(row.approved_at),
            )}
          </span>
        ) : null}
      </div>
      <div className="wx-retention-meta">
        <StatusPill tone={status.tone} glyph={status.glyph} label={status.label} />
        <span className="wx-retention-detail">{R.STATUS_NOTE[row.status]}</span>
        {row.under_legal_hold ? <span className="wx-retention-detail">{R.UNDER_HOLD}</span> : null}
        {actions.map((kind) => (
          <Button
            key={kind}
            type="button"
            tone={kind === "self_approve" ? "danger" : "secondary"}
            size="sm"
            aria-label={R.actionLabel(VERB[kind], row.message_id)}
            onClick={() => onDecide(kind)}
          >
            {VERB[kind]}
          </Button>
        ))}
      </div>
    </li>
  );
}

export function RedactionsPanel({
  resume,
  onResumeConsumed,
}: {
  readonly resume: RedactionResume | null;
  readonly onResumeConsumed: () => void;
}): JSX.Element {
  const me = useSession()?.userId;
  const owner = useStepUpOwner();
  const { view, reload, refreshFailed } = useRedactions();
  const actions = useRedactionActions();
  const [requesting, setRequesting] = useState(false);
  const [deciding, setDeciding] = useState<RedactionResume | null>(null);
  const [resumeDecision, setResumeDecision] = useState(resume);
  const [announcement, setAnnouncement] = useState("");
  const [announceSeq, setAnnounceSeq] = useState(0);
  const statusRef = useRef<HTMLOutputElement>(null);
  const resumed = useRef(false);

  // Back from the step-up page: reopen that decision once the list shows it is still open (once).
  useEffect(() => {
    if (!resumeDecision || resumed.current || view.status !== "ready") return;
    resumed.current = true;
    const row = view.data.redactions.find((r) => r.id === resumeDecision.redactionId);
    if (
      row &&
      offeredActions(row, me, view.data.single_officer_fallback_available).includes(
        resumeDecision.kind,
      )
    ) {
      setDeciding(resumeDecision);
    }
    setResumeDecision(null);
    onResumeConsumed(); // the parent must not hand it to a later mount (tab switch back)
  }, [resumeDecision, view, me, onResumeConsumed]);

  // The trigger may be gone after an action (the row changed, the dialog closed): keep focus on the result.
  useEffect(() => {
    if (announceSeq > 0) statusRef.current?.focus();
  }, [announceSeq]);
  const announce = (text: string): void => {
    setAnnouncement(text);
    setAnnounceSeq((n) => n + 1);
  };

  const target =
    view.status === "ready" && deciding
      ? view.data.redactions.find((r) => r.id === deciding.redactionId)
      : undefined;
  return (
    <>
      <p className="wx-retention-detail">{R.REDACTIONS_INTRO}</p>
      <div className="wx-retention-actions">
        <Button type="button" tone="primary" onClick={() => setRequesting(true)}>
          {R.REQUEST_LABEL}
        </Button>
      </div>
      <output ref={statusRef} tabIndex={-1} className="wx-retention-status" aria-live="polite">
        {announcement}
      </output>
      <LoadGate view={view} retry={reload} refreshFailed={refreshFailed}>
        {(data) =>
          data.redactions.length === 0 ? (
            <EmptyState title={R.REDACTIONS_EMPTY_TITLE} description={R.REDACTIONS_EMPTY_TEXT} />
          ) : (
            <ul className="wx-retention-rows" aria-label={R.REDACTIONS_LIST_LABEL}>
              {data.redactions.map((row) => (
                <RedactionRow
                  key={row.id}
                  row={row}
                  me={me}
                  fallbackAvailable={data.single_officer_fallback_available}
                  onDecide={(kind) => setDeciding({ kind, redactionId: row.id })}
                />
              ))}
            </ul>
          )
        }
      </LoadGate>
      {requesting ? (
        <RequestRedactionDialog
          actions={actions}
          onClose={() => setRequesting(false)}
          onRequested={() => {
            setRequesting(false);
            announce(R.REQUEST_ANNOUNCEMENT);
            reload();
          }}
        />
      ) : null}
      {target && deciding ? (
        <DecisionDialog
          key={`${deciding.kind}:${target.id}`}
          kind={deciding.kind}
          redaction={target}
          actions={actions}
          draftKey={decisionDraftKey(owner, deciding.kind, target.id)}
          onClose={() => {
            setDeciding(null);
            reload(); // a refused decision means the row moved on: show its real state
          }}
          onDone={(text) => {
            setDeciding(null);
            announce(text);
            reload();
          }}
        />
      ) : null}
    </>
  );
}
