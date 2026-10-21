// M36 WP 5.7 (ADR-0089, PROPOSED) - the approver's queue and detail for restricted message exports, for a holder of messaging.export.approve. The queue
// is flat rows on the shared kit; the detail shows who asked, the scope, the date range and the justification, and a note box with Approve and Reject
// (a rejection needs a note). It never shows message content. The buttons are hidden for the person's own request; the server stays the authority and
// refuses it as well. The justification and the note are staff free text and are only ever rendered as text.
import {
  MESSAGING_EXPORT_DECISION_NOTE_MAX,
  type MessagingExportJobDetailDto,
  type MessagingExportJobSummaryDto,
} from "@chartwarden/types";
import { Button, EmptyState, PageHeader, TextAreaField } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import { LoadGate, StatusChip, formatTime, useFailureText, useNow } from "./export-common";
import * as W from "./export-wording";
import { useOnlineStatus } from "./offline-banner";
import { useExportActions, useExportDetail, usePendingExports } from "./use-export";
import "./export.css";

const who = (job: MessagingExportJobSummaryDto): string => job.requestedByName ?? job.requestedBy;

function Facts({ job }: { readonly job: MessagingExportJobSummaryDto }): JSX.Element {
  const scopeId = job.scope.channelId ?? job.scope.patientId ?? "";
  return (
    <>
      <span className="wx-export-title">
        {W.REQUESTER_LABEL} {who(job)}
      </span>
      <span className="wx-export-detail">
        {W.scopeText(job.scope.scopeKind)} <span className="wx-export-mono">{scopeId}</span> ·{" "}
        {W.rangeText(job.scope.dateFrom, job.scope.dateTo)}
      </span>
      <span className="wx-export-detail">
        {W.REQUESTED_AT_LABEL} {formatTime(job.requestedAt)}
      </span>
    </>
  );
}

function DetailBody({
  detail,
  reload,
}: {
  readonly detail: MessagingExportJobDetailDto;
  readonly reload: () => void;
}): JSX.Element {
  const actions = useExportActions();
  const online = useOnlineStatus();
  const failureText = useFailureText();
  const me = useSession()?.userId;
  const now = useNow();
  const own = me !== undefined && me === detail.requestedBy;
  const pending = detail.status === "pending_approval";
  const statusRef = useRef<HTMLOutputElement>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const decide = async (kind: "approve" | "reject"): Promise<void> => {
    if (busy || !online || own) return;
    const trimmed = note.trim();
    if (kind === "reject" && trimmed === "") return setMessage(W.NOTE_REQUIRED);
    if (trimmed.length > MESSAGING_EXPORT_DECISION_NOTE_MAX) return setMessage(W.NOTE_TOO_LONG);
    setBusy(true);
    setMessage(null);
    const body = trimmed === "" ? {} : { note: trimmed };
    const result = await (kind === "approve"
      ? actions.approve(detail.id, body)
      : actions.reject(detail.id, body));
    setBusy(false);
    setMessage(
      result.kind === "ok"
        ? kind === "approve"
          ? W.APPROVED_DONE
          : W.REJECTED_DONE
        : failureText(result),
    );
    if (result.kind === "ok" || result.kind === "conflict") reload();
    statusRef.current?.focus();
  };

  return (
    <section className="wx-export-detail-pane" aria-label={W.DETAIL_TITLE}>
      <div className="wx-export-main">
        <Facts job={detail} />
        <StatusChip status={detail.status} expiresAt={detail.expiresAt} now={now} />
      </div>
      <h2>{W.justificationHeading}</h2>
      <p className="wx-export-text">{detail.justification}</p>
      {!pending ? (
        <p className="wx-export-detail">
          {detail.decisionNote ? `${W.DECIDED_NOTE_LABEL}: ${detail.decisionNote}` : null}
        </p>
      ) : (
        <form
          className="wx-export-form"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          {own ? (
            <p className="wx-export-detail">{W.OWN_REQUEST}</p>
          ) : (
            <>
              <TextAreaField
                label={W.DECISION_NOTE_LABEL}
                hint={W.DECISION_NOTE_HINT}
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              {!online ? (
                <p className="wx-export-error" role="alert">
                  {W.OFFLINE_TEXT}
                </p>
              ) : null}
              <div className="wx-export-actions">
                <Button
                  type="button"
                  tone="secondary"
                  size="lg"
                  disabled={busy || !online}
                  onClick={() => void decide("reject")}
                >
                  {W.REJECT_LABEL}
                </Button>
                <Button
                  type="button"
                  tone="primary"
                  size="lg"
                  disabled={busy || !online}
                  onClick={() => void decide("approve")}
                >
                  {W.APPROVE_LABEL}
                </Button>
              </div>
            </>
          )}
        </form>
      )}
      <output ref={statusRef} tabIndex={-1} className="wx-export-status" aria-live="polite">
        {message}
      </output>
    </section>
  );
}

function Detail({
  id,
  onBack,
  onChanged,
}: {
  readonly id: string;
  readonly onBack: () => void;
  readonly onChanged: () => void;
}): JSX.Element {
  const { view, reload } = useExportDetail(id);
  return (
    <>
      <Button type="button" tone="secondary" size="lg" onClick={onBack}>
        {W.BACK_LABEL}
      </Button>
      <LoadGate view={view} retry={reload} deniedText={W.APPROVALS_DENIED}>
        {(detail) => (
          <DetailBody
            detail={detail}
            reload={() => {
              reload();
              onChanged();
            }}
          />
        )}
      </LoadGate>
    </>
  );
}

export function ExportApprovals(): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const { view, reload } = usePendingExports();
  const now = useNow();
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const swapped = useRef(false);
  // Swapping the list for a detail (and back) unmounts what had focus: land on the new pane instead of <body>.
  useEffect(() => {
    if (!swapped.current) {
      swapped.current = true;
      return;
    }
    (selected ? detailRef : listRef).current?.focus();
  }, [selected]);
  return (
    <>
      <PageHeader title={W.APPROVALS_TITLE} breadcrumb={W.BREADCRUMB}>
        <p className="wx-export-detail">{W.APPROVALS_NOTICE}</p>
      </PageHeader>
      <section className="wx-export" aria-label={W.APPROVALS_TITLE}>
        {selected ? (
          <div ref={detailRef} tabIndex={-1} className="wx-export-detail-pane">
            <Detail id={selected} onBack={() => setSelected(null)} onChanged={reload} />
          </div>
        ) : (
          <div ref={listRef} tabIndex={-1} className="wx-export-panel">
            <LoadGate view={view} retry={reload} deniedText={W.APPROVALS_DENIED}>
              {(jobs) =>
                jobs.length === 0 ? (
                  <EmptyState
                    title={W.APPROVALS_EMPTY_TITLE}
                    description={W.APPROVALS_EMPTY_TEXT}
                  />
                ) : (
                  <ul className="wx-export-rows" aria-label={W.APPROVALS_LABEL}>
                    {jobs.map((job) => (
                      <li key={job.id} className="wx-export-row">
                        <div className="wx-export-main">
                          <Facts job={job} />
                        </div>
                        <div className="wx-export-meta">
                          <StatusChip status={job.status} expiresAt={job.expiresAt} now={now} />
                          <Button
                            type="button"
                            tone="secondary"
                            size="lg"
                            onClick={() => setSelected(job.id)}
                          >
                            {W.OPEN_LABEL}
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )
              }
            </LoadGate>
          </div>
        )}
      </section>
    </>
  );
}
