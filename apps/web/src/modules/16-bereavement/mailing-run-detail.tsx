// apps/web/src/modules/16-bereavement — ONE MAILING RUN (ADR-0109 D10, routes 45 and 47-51). Oversight only.
//
// The run's life, in the order staff do it: edit the wording (a draft only), Generate (a worker renders the batch; this page checks
// again while it runs), Download the batch, print and mail it, Confirm mailed, or Cancel. What it is careful about:
//
//  1. NO DEFAULT WORDING. A run with no title or no paragraph cannot be generated: the button says why and the server refuses it
//     too (422 MAILING_CONTENT_EMPTY). Nothing on this page ever supplies wording.
//  2. THE HEADER DECIDES THE VERSION. Every write carries the run version the page READ in `If-Match` and one `Idempotency-Key` per
//     attempt; a 412 reloads the run. A write in flight disables every action (a ref guards the first click, state shows it).
//  3. CONFIRM MAILED RE-CHECKS ELIGIBILITY. A family who opted out (or whose plan closed) after the batch was generated is flagged
//     "left out after printing" and is NOT logged as mailed; the dialog says so and the page keeps showing that count.
//  4. THE DOWNLOAD URL IS A CREDENTIAL to a document holding every addressee: it is opened in a new tab (noopener) in the click that
//     fetched it and is held in no state, log or cache.
//  5. A 403 renders nothing; any other failure is announced and never unmounts what is on screen.
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  type MailingRun,
  cancelMailingRun,
  confirmMailingRunMailed,
  downloadMailingRun,
  errorCode,
  errorMessage,
  generateMailingRun,
  getMailingRun,
  isStaleWrite,
} from "./bereavement-api";
import { dateTime, humanize, shortDate, toneOf } from "./bereavement-status";
import {
  Card,
  CountGrid,
  ErrorText,
  Field,
  Modal,
  Notice,
  SummaryGrid,
  columnStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  useActionStatus,
  useIdempotencyKey,
} from "./bereavement-ui";
import { useLoaded } from "./mailing-load";
import { MailingRunItems } from "./mailing-run-items";
import {
  MAILING_DISPATCH_PERMISSION,
  MAILING_MANAGE_PERMISSION,
  RUN_STATUS_TONE,
  canCancel,
  canConfirmMailed,
  canDownload,
  canEditWording,
  canGenerate,
  contentForSave,
  failureLabel,
  isWordingComplete,
  mailingLabel,
  wordingOf,
} from "./mailing-status";
import { EditWordingModal } from "./mailing-wording-modal";

/** How often a run that is `generating` is read again (a worker renders it; there is no push). */
export const GENERATING_POLL_MS = 3000;
const RUN_LOAD_FAILED = "The mailing run could not be loaded.";
const CONTENT_EMPTY_CODE = "MAILING_CONTENT_EMPTY";
const CONTENT_EMPTY_MESSAGE =
  "Write a title and at least one paragraph before generating. No default wording is sent.";
const RUN_MOVED =
  "This run changed while you were working on it. The page has been refreshed: check it and try again.";

type Ceremony = "wording" | "confirm" | "cancel" | null;
type ActionName = "generate" | "download" | "confirm" | "cancel";
type WriteResult = { run: MailingRun | null; error: unknown; status: number };

export function MailingRunDetail({
  pollMs = GENERATING_POLL_MS,
}: { pollMs?: number }): JSX.Element | null {
  const { runId } = useParams<{ runId: string }>();
  // Keyed by run: a route-param change remounts, so one run's page is never shown under another's id.
  return <RunPage key={runId ?? "none"} runId={runId ?? ""} pollMs={pollMs} />;
}

function RunPage({ runId, pollMs }: { runId: string; pollMs: number }): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const mayDispatch = session?.permissions?.includes(MAILING_DISPATCH_PERMISSION) ?? false;
  const mayManage = session?.permissions?.includes(MAILING_MANAGE_PERMISSION) ?? false;
  const fetchRun = useCallback(async () => {
    const { run, error, status } = await getMailingRun(client, runId);
    return { data: run, error, status };
  }, [client, runId]);
  const { state, reload, adopt } = useLoaded<MailingRun>(fetchRun, RUN_LOAD_FAILED);
  const [ceremony, setCeremony] = useState<Ceremony>(null);
  const [busy, setBusy] = useState<ActionName | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const { announce, region } = useActionStatus();
  const generateKey = useIdempotencyKey();
  const confirmKey = useIdempotencyKey();
  const cancelKey = useIdempotencyKey();
  const reasonId = useId();

  const status = state.kind === "ready" ? state.data.status : null;
  useEffect(() => {
    if (status !== "generating") return;
    const timer = setInterval(() => void reload(), pollMs);
    return () => clearInterval(timer);
  }, [status, reload, pollMs]);

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") return <LoadingSpinner label="Loading the mailing run" />;
  if (state.kind === "error") {
    return state.status === 404 ? (
      <EmptyState title="Not found" description="This mailing run does not exist." />
    ) : (
      <div className="wx-kit-column" style={columnStyle}>
        <ErrorText>{state.message}</ErrorText>
        <div>
          <Button size="sm" tone="secondary" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const run = state.data;
  const wording = wordingOf(run.content);
  const wordingComplete = isWordingComplete(wording);
  const hasWording = contentForSave(wording).en !== undefined;
  const confirmOpen = ceremony === "confirm" || ceremony === "cancel";
  const openCeremony = (next: Ceremony): void => {
    setActionError(null);
    setCeremony(next);
  };

  /** Run one write: one attempt at a time, the run version this page read, one idempotency key per attempt. */
  const write = async (
    name: ActionName,
    keys: ReturnType<typeof useIdempotencyKey>,
    call: (key: string) => Promise<WriteResult>,
    fallback: string,
  ): Promise<MailingRun | null> => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(name);
    setActionError(null);
    const { run: next, error, status: http } = await call(keys.keyFor(`${name}:${run.version}`));
    keys.settle(http);
    inFlight.current = false;
    setBusy(null);
    if (error || !next) {
      if (isStaleWrite(http)) void reload();
      setActionError(
        http === 412
          ? RUN_MOVED
          : errorCode(error) === CONTENT_EMPTY_CODE
            ? CONTENT_EMPTY_MESSAGE
            : errorMessage(error, fallback),
      );
      return null;
    }
    adopt(next);
    return next;
  };

  const generate = async (): Promise<void> => {
    const next = await write(
      "generate",
      generateKey,
      (key) => generateMailingRun(client, run.runId, run.version, key),
      "The batch could not be generated.",
    );
    if (next) announce("Generation started.");
  };

  const download = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("download");
    setActionError(null);
    const { download: link, error, status: http } = await downloadMailingRun(client, run.runId);
    inFlight.current = false;
    setBusy(null);
    if (error || !link) {
      if (isStaleWrite(http)) void reload();
      setActionError(errorMessage(error, "The batch could not be downloaded."));
      return;
    }
    // The URL lives only in this click: opened in a new tab with no opener, never stored, logged or cached.
    window.open(link.url, "_blank", "noopener,noreferrer");
    announce("The batch opened in a new tab. Its link stops working after a short time.");
  };

  const confirmMailed = async (): Promise<void> => {
    const next = await write(
      "confirm",
      confirmKey,
      (key) => confirmMailingRunMailed(client, run.runId, run.version, key),
      "The run could not be confirmed as mailed.",
    );
    if (!next) return;
    setCeremony(null);
    const left = next.itemCounts.excludedAfterRender;
    announce(
      left > 0
        ? `Marked as mailed. ${next.itemCounts.logged} logged. ${left} left out after printing: they are not logged as mailed.`
        : `Marked as mailed. ${next.itemCounts.logged} logged.`,
    );
  };

  const cancel = async (): Promise<void> => {
    const next = await write(
      "cancel",
      cancelKey,
      (key) => cancelMailingRun(client, run.runId, run.version, key),
      "The run could not be cancelled.",
    );
    if (!next) return;
    setCeremony(null);
    announce("The run was cancelled.");
  };

  const counts = run.itemCounts;
  const failure = state.notice;
  const noActions = !mayDispatch && !mayManage;
  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={
          <span style={pageTitleStyle}>
            {mailingLabel(run.mailingKey)} for {shortDate(run.scheduledFor)}
          </span>
        }
        actions={
          <div style={{ display: "flex", gap: t.space2, alignItems: "center", flexWrap: "wrap" }}>
            <StatusPill label={humanize(run.status)} tone={toneOf(RUN_STATUS_TONE, run.status)} />
            <Link to="/bereavement/mailings" style={ghostButtonStyle}>
              All runs
            </Link>
          </div>
        }
      />
      {region}
      {failure ? (
        <div style={{ display: "flex", gap: t.space2, alignItems: "center", flexWrap: "wrap" }}>
          <ErrorText>{failure}</ErrorText>
          <Button
            size="sm"
            tone="secondary"
            loading={state.refreshing}
            onClick={() => void reload()}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {run.status === "generating" ? (
        <Notice tone="info" live>
          The batch is being generated. This page checks again every few seconds; you can leave it
          open.
        </Notice>
      ) : null}
      {run.status === "failed" ? (
        <Notice tone="error">
          Generation failed. {failureLabel(run.failureCode)}
          {run.failureCode ? ` Code: ${run.failureCode}.` : ""}
        </Notice>
      ) : null}
      {counts.excludedAfterRender > 0 ? (
        <Notice tone="warning">
          {counts.excludedAfterRender === 1
            ? "1 family was left out after printing"
            : `${counts.excludedAfterRender} families were left out after printing`}
          : they opted out or their plan closed after the batch was generated. They are NOT logged
          as mailed. Take their letters out of the batch.
        </Notice>
      ) : null}

      <Card title="Summary">
        <SummaryGrid>
          <Field label="Mailing" value={mailingLabel(run.mailingKey)} />
          <Field label="For" value={shortDate(run.scheduledFor)} />
          <Field label="Status" value={humanize(run.status)} />
          <Field label="Recipients" value={run.recipientCount} />
          <Field label="Left out" value={run.excludedCount} />
          <Field label="Generated" value={dateTime(run.generatedAt)} />
          <Field label="Mailed" value={dateTime(run.mailedAt)} />
        </SummaryGrid>
        <CountGrid
          entries={[
            { label: "In the batch", value: counts.included },
            { label: "Left out", value: counts.excluded },
            { label: "Logged as mailed", value: counts.logged },
            { label: "Left out after printing", value: counts.excludedAfterRender },
          ]}
        />
      </Card>

      <Card title="Wording">
        {hasWording ? (
          <div style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
            <strong>{wording.title || "(no title)"}</strong>
            {wording.greeting ? <span>{wording.greeting}</span> : null}
            {wording.paragraphs.map((paragraph, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: read-only paragraphs, no stable id
              <p key={i} style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                {paragraph}
              </p>
            ))}
            {wording.signoff ? <span>{wording.signoff}</span> : null}
          </div>
        ) : (
          <span style={mutedStyle}>
            No wording has been written for this run. Nothing is filled in for you: write a title
            and at least one paragraph before generating.
          </span>
        )}
      </Card>

      <Card title="Actions">
        {noActions ? (
          <span style={mutedStyle}>Your role can view this run but not change or send it.</span>
        ) : (
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap", alignItems: "center" }}>
            {mayManage && canEditWording(run.status) ? (
              <Button
                tone="secondary"
                disabled={busy !== null}
                onClick={() => openCeremony("wording")}
              >
                Edit wording
              </Button>
            ) : null}
            {mayDispatch && canGenerate(run.status) ? (
              <Button
                loading={busy === "generate"}
                disabled={busy !== null || !wordingComplete}
                aria-describedby={wordingComplete ? undefined : reasonId}
                onClick={() => void generate()}
              >
                {run.status === "failed" ? "Retry generation" : "Generate"}
              </Button>
            ) : null}
            {mayDispatch && canDownload(run.status) ? (
              <Button
                tone="secondary"
                loading={busy === "download"}
                disabled={busy !== null}
                onClick={() => void download()}
              >
                Download
              </Button>
            ) : null}
            {mayDispatch && canConfirmMailed(run.status) ? (
              <Button disabled={busy !== null} onClick={() => openCeremony("confirm")}>
                Confirm mailed
              </Button>
            ) : null}
            {mayManage && canCancel(run.status) ? (
              <Button
                tone="secondary"
                disabled={busy !== null}
                onClick={() => openCeremony("cancel")}
              >
                Cancel run
              </Button>
            ) : null}
          </div>
        )}
        {mayDispatch && canGenerate(run.status) && !wordingComplete ? (
          <span id={reasonId} style={mutedStyle}>
            Generate is unavailable until the wording has a title and at least one paragraph.
          </span>
        ) : null}
        {actionError && !confirmOpen ? <ErrorText>{actionError}</ErrorText> : null}
      </Card>

      <MailingRunItems runId={run.runId} refreshKey={`${run.status}:${run.version}`} />

      {ceremony === "wording" ? (
        <EditWordingModal
          run={run}
          onClose={() => setCeremony(null)}
          onStale={() => void reload()}
          onSaved={(next) => {
            adopt(next);
            setCeremony(null);
            announce("The wording was saved.");
          }}
        />
      ) : null}
      {ceremony === "confirm" ? (
        <Modal
          title="Confirm the run was mailed"
          onClose={() => setCeremony(null)}
          busy={busy === "confirm"}
          footer={
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={busy !== null}
              onClick={() => void confirmMailed()}
            >
              {busy === "confirm" ? "Confirming…" : "Confirm mailed"}
            </button>
          }
        >
          <span style={mutedStyle}>
            Confirming records that the printed letters went out. Each of the {counts.included}{" "}
            {counts.included === 1 ? "family" : "families"} in the batch gets this mailing logged on
            their contact as a program activity; it does not count as a touchpoint.
          </span>
          <Notice tone="warning">
            Eligibility is checked again now. Anyone who opted out, asked for no mailings, or whose
            plan closed since the batch was generated is left out and is NOT logged as mailed. Their
            letters must come out of the batch.
          </Notice>
          {actionError ? <ErrorText>{actionError}</ErrorText> : null}
        </Modal>
      ) : null}
      {ceremony === "cancel" ? (
        <Modal
          title="Cancel this mailing run"
          onClose={() => setCeremony(null)}
          busy={busy === "cancel"}
          footer={
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={busy !== null}
              onClick={() => void cancel()}
            >
              {busy === "cancel" ? "Cancelling…" : "Yes, cancel this run"}
            </button>
          }
        >
          <span style={mutedStyle}>
            A cancelled run is not generated, printed or logged, and it cannot be reopened. Nothing
            is recorded on any family's contact.
          </span>
          {actionError ? <ErrorText>{actionError}</ErrorText> : null}
        </Modal>
      ) : null}
    </div>
  );
}
