// M36 WP 5.7 (ADR-0089, PROPOSED) - "Message exports": the caller's own export jobs as flat rows on the shared kit. State is a word, never colour alone.
// Cancel while the request is pending; Download only while the file is ready AND its link has not run out. The tenant flag gates requesting only, so
// the list, cancel and download keep working with the flag off. Every write is disabled while offline and is never queued.
import type { MessagingExportJobSummaryDto } from "@chartwarden/types";
import { Button, EmptyState, PageHeader } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import {
  Countdown,
  LoadGate,
  StatusChip,
  canDownload,
  formatTime,
  useFailureText,
  useNow,
} from "./export-common";
import { ExportRequest } from "./export-request";
import * as W from "./export-wording";
import { useOnlineStatus } from "./offline-banner";
import {
  type ExportActions,
  type ExportResult,
  useExportActions,
  useMyExports,
} from "./use-export";
import "./export.css";

function Row({
  job,
  now,
  actions,
  busyId,
  run,
}: {
  readonly job: MessagingExportJobSummaryDto;
  readonly now: number;
  readonly actions: ExportActions;
  readonly busyId: string | null;
  readonly run: (id: string, work: () => Promise<ExportResult<unknown>>, ok: string | null) => void;
}): JSX.Element {
  const online = useOnlineStatus();
  const busy = busyId !== null;
  const scopeId = job.scope.channelId ?? job.scope.patientId ?? "";
  return (
    <li className="wx-export-row">
      <div className="wx-export-main">
        <span className="wx-export-title">
          {W.scopeText(job.scope.scopeKind)} <span className="wx-export-mono">{scopeId}</span>
        </span>
        <span className="wx-export-detail">
          {W.rangeText(job.scope.dateFrom, job.scope.dateTo)} · {W.REQUESTED_AT_LABEL}{" "}
          {formatTime(job.requestedAt)}
        </span>
        {job.messageCount !== null ? (
          <span className="wx-export-detail">
            {W.countsText(job.messageCount, job.heldExcluded, job.part2Excluded)}
          </span>
        ) : null}
        {job.status === "failed" ? <span className="wx-export-detail">{W.FAILED_TEXT}</span> : null}
      </div>
      <div className="wx-export-meta">
        <StatusChip status={job.status} expiresAt={job.expiresAt} now={now} />
        {job.status === "ready" ? <Countdown expiresAt={job.expiresAt} now={now} /> : null}
        {job.status === "pending_approval" ? (
          <Button
            type="button"
            tone="secondary"
            size="lg"
            disabled={busy || !online}
            onClick={() => run(job.id, () => actions.cancel(job.id), null)}
          >
            {busyId === job.id ? W.CANCELLING : W.CANCEL_LABEL}
          </Button>
        ) : null}
        {canDownload(job.status, job.expiresAt, now) ? (
          <Button
            type="button"
            tone="primary"
            size="lg"
            disabled={busy || !online}
            onClick={() => run(job.id, () => actions.download(job.id), W.DOWNLOAD_STARTED)}
          >
            {busyId === job.id ? W.DOWNLOADING : W.DOWNLOAD_LABEL}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export function ExportMine(): JSX.Element {
  const { view, reload } = useMyExports();
  const actions = useExportActions();
  const failureText = useFailureText();
  const now = useNow();
  const statusRef = useRef<HTMLOutputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const run: React.ComponentProps<typeof Row>["run"] = (id, work, ok) => {
    if (busyId !== null) return;
    setBusyId(id);
    setMessage(null);
    void work().then((result) => {
      setBusyId(null);
      setMessage(result.kind === "ok" ? ok : failureText(result));
      // A refused or stale answer (already decided, expired) is re-read so the row shows the truth.
      if (result.kind === "ok" || result.kind === "conflict") reload();
      statusRef.current?.focus();
    });
  };

  return (
    <>
      <PageHeader title={W.MINE_TITLE} breadcrumb={W.BREADCRUMB}>
        <p className="wx-export-detail">{W.MINE_NOTICE}</p>
        <ExportRequest
          onRequested={() => {
            setMessage(W.REQUESTED);
            reload();
            statusRef.current?.focus();
          }}
        />
      </PageHeader>
      <section className="wx-export" aria-label={W.MINE_TITLE}>
        <output ref={statusRef} tabIndex={-1} className="wx-export-status" aria-live="polite">
          {message}
        </output>
        <LoadGate view={view} retry={reload} deniedText={W.DENIED}>
          {(jobs) =>
            jobs.length === 0 ? (
              <EmptyState title={W.EMPTY_TITLE} description={W.EMPTY_TEXT} />
            ) : (
              <ul className="wx-export-rows" aria-label={W.LIST_LABEL}>
                {jobs.map((job) => (
                  <Row
                    key={job.id}
                    job={job}
                    now={now}
                    actions={actions}
                    busyId={busyId}
                    run={run}
                  />
                ))}
              </ul>
            )
          }
        </LoadGate>
      </section>
    </>
  );
}
