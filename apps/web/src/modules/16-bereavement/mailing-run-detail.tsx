// apps/web/src/modules/16-bereavement — ONE MAILING RUN (ADR-0109 D10, routes 45 and 47-51). Oversight only.
//
// The run's life, in the order staff do it: edit the wording (a draft only), Generate (a worker renders the batch; this page checks
// again while it runs), Download the batch, print and mail it, Confirm mailed, or Cancel. What it is careful about:
//
//  1. NO DEFAULT WORDING. A run with no title or no paragraph cannot be generated: the button says why and the server refuses it
//     too (422 MAILING_CONTENT_EMPTY). Nothing on this page ever supplies wording.
//  2. THE HEADER DECIDES THE VERSION. Every write carries the run version the page READ in `If-Match` and one `Idempotency-Key` per
//     attempt; a 412/409 reloads the run, closes any open dialog and says why on the page. A write in flight disables every action.
//  3. A STALE BATCH IS NOT HANDED OUT. The server re-checks eligibility before rendering and again at download: when someone in a ready
//     batch has since opted out (or their plan closed), the download is refused (409 MAILING_RUN_STALE) and the page offers
//     "Regenerate batch", which selects and renders the run again. Download needs a fresh step-up; a refusal goes to /step-up and back.
//     Regenerating a ready batch the reader did NOT just see refused asks first (an alertdialog): an earlier download and its Ref numbers
//     are superseded. A mailed batch is never downloaded again (409 MAILING_RUN_ALREADY_MAILED): it went out; there is no reprint.
//  4. CONFIRM MAILED IS BOOKKEEPING. It re-checks once more and does not log anyone who became ineligible since the download ("left out
//     after printing"); the printed letters cannot be recalled, so the page names them and each letter carries a "Ref N" (the item's
//     order) to pull it by if it has not gone out.
//  5. THE DOWNLOAD URL IS A CREDENTIAL to a document holding every addressee. It must be https; it is held only in this page's memory as
//     an "Open batch" link the user clicks (a pop-up opened after an await is often blocked; focus moves to it), and is dropped on the
//     click or at expiry.
//     Never logged, stored or cached.
//  6. A 403 renders nothing; any other failure is announced and never unmounts what is on screen. The generating poll is chained (no
//     overlapping reads), pauses while the tab is hidden and stops on a terminal status or a 404.
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
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useSession } from "../../shell/session";
import { stepUpRedirectFor } from "../../shell/step-up-redirect";
import {
  type MailingDownload,
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
  dangerButtonStyle,
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
  canRegenerate,
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
const STALE_BATCH_CODE = "MAILING_RUN_STALE";
const NOT_FOUND = 404;
/** The longest delay `setTimeout` honours (a larger one fires at once). */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** How long until a batch link expires, clamped to what a timer can wait (an unparseable expiry is already expired). */
export function linkLifetimeMs(expiresAt: string, now: number): number {
  const left = Date.parse(expiresAt) - now;
  return Number.isFinite(left) ? Math.min(Math.max(0, left), MAX_TIMEOUT_MS) : 0;
}

/** A batch link is only ever https (loopback http is the local dev object store). */
export function isSafeBatchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    return (
      parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

type Ceremony = "wording" | "regenerate" | "confirm" | "cancel" | null;
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
  const navigate = useNavigate();
  const location = useLocation();
  const lastReadStatus = useRef(0);
  const fetchRun = useCallback(async () => {
    const { run, error, status } = await getMailingRun(client, runId);
    lastReadStatus.current = status;
    return { data: run, error, status };
  }, [client, runId]);
  const { state, reload, adopt } = useLoaded<MailingRun>(fetchRun, RUN_LOAD_FAILED);
  const [ceremony, setCeremony] = useState<Ceremony>(null);
  const [busy, setBusy] = useState<ActionName | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** A download was refused as stale (409 MAILING_RUN_STALE): the page says so and offers "Regenerate batch". */
  const [staleBatch, setStaleBatch] = useState(false);
  /** The minted batch link, in memory only until it is clicked or expires. */
  const [batchLink, setBatchLink] = useState<MailingDownload | null>(null);
  const batchLinkRef = useRef<HTMLAnchorElement>(null);
  /** Bumped by a manual "Try again" that read the run: a poll a 404 had stopped starts again if the run is still generating. */
  const [pollEpoch, setPollEpoch] = useState(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { announce, region } = useActionStatus();
  const generateKey = useIdempotencyKey();
  const confirmKey = useIdempotencyKey();
  const cancelKey = useIdempotencyKey();
  const reasonId = useId();
  const cancelDescId = useId();
  const regenerateDescId = useId();
  const confirmDescId = useId();

  const status = state.kind === "ready" ? state.data.status : null;
  const version = state.kind === "ready" ? state.data.version : null;
  // Chained, never overlapping: the next read is scheduled only after the previous one answered. Paused while the tab is hidden;
  // stops when the run leaves `generating` (this effect re-runs) or the run is gone (404).
  // biome-ignore lint/correctness/useExhaustiveDependencies: pollEpoch is the trigger that restarts a poll a 404 stopped
  useEffect(() => {
    if (status !== "generating") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reading = false;
    let stopped = false;
    const schedule = (): void => {
      if (stopped || reading || timer !== null || document.hidden) return;
      timer = setTimeout(() => void tick(), pollMs);
    };
    const tick = async (): Promise<void> => {
      timer = null;
      reading = true;
      await reload();
      reading = false;
      if (lastReadStatus.current === NOT_FOUND) stopped = true;
      schedule();
    };
    const onVisibility = (): void => {
      if (!document.hidden) {
        schedule();
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [status, reload, pollMs, pollEpoch]);

  // Say the outcome of a render the page was waiting on (the status pill alone is not announced).
  const previousStatus = useRef(status);
  useEffect(() => {
    const before = previousStatus.current;
    previousStatus.current = status;
    if (before !== "generating") return;
    // a poll noticed it, not the reader: say it, but leave focus where they are
    if (status === "failed") {
      announce("Generation failed. See the reason on the page.", { focus: false });
    }
    if (status === "ready") announce("The batch is ready to download.", { focus: false });
  }, [status, announce]);

  // A link minted for an earlier batch is never offered for a newer one, and a stale-batch refusal is about the batch it refused; an
  // expired link is dropped.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the run moving (status / version) is the trigger
  useEffect(() => {
    setBatchLink(null);
    setStaleBatch(false);
  }, [status, version]);
  useEffect(() => {
    if (batchLink === null) return;
    batchLinkRef.current?.focus();
    const timer = setTimeout(
      () => setBatchLink(null),
      linkLifetimeMs(batchLink.expiresAt, Date.now()),
    );
    return () => clearTimeout(timer);
  }, [batchLink]);

  const retryRead = async (): Promise<void> => {
    if (await reload()) setPollEpoch((n) => n + 1);
  };

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") return <LoadingSpinner label="Loading the mailing run" />;
  if (state.kind === "error") {
    return state.status === 404 ? (
      <EmptyState title="Not found" description="This mailing run does not exist." />
    ) : (
      <div className="wx-kit-column" style={columnStyle}>
        <ErrorText>{state.message}</ErrorText>
        <div>
          <Button size="sm" tone="secondary" onClick={() => void retryRead()}>
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
  const confirmOpen = ceremony === "confirm" || ceremony === "cancel" || ceremony === "regenerate";
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
      const message =
        http === 412
          ? RUN_MOVED
          : errorCode(error) === CONTENT_EMPTY_CODE
            ? CONTENT_EMPTY_MESSAGE
            : errorMessage(error, fallback);
      if (isStaleWrite(http)) {
        void reload();
        if (ceremony !== null) {
          // What the dialog was confirming no longer holds: close it, and say so where focus lands (its trigger may be gone).
          setCeremony(null);
          announce(message);
          return null;
        }
      }
      setActionError(message);
      return null;
    }
    adopt(next);
    return next;
  };

  const generate = async (): Promise<void> => {
    const regenerating = run.status === "ready";
    const next = await write(
      "generate",
      generateKey,
      (key) => generateMailingRun(client, run.runId, run.version, key),
      "The batch could not be generated.",
    );
    if (!next) return;
    setCeremony(null);
    setStaleBatch(false);
    announce(
      regenerating
        ? "Regenerating the batch. Download the new batch when it is ready; do not mail the earlier one."
        : "Generation started.",
    );
  };

  const download = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("download");
    setActionError(null);
    const { download: link, error, status: http } = await downloadMailingRun(client, run.runId);
    inFlight.current = false;
    // The reader left while it was minted: never navigate them (to /step-up) from a page they are no longer on.
    if (!mounted.current) return;
    setBusy(null);
    if (error || !link) {
      const stepUp = stepUpRedirectFor(error, `${location.pathname}${location.search}`);
      if (stepUp) {
        navigate(stepUp);
        return;
      }
      if (errorCode(error) === STALE_BATCH_CODE) {
        setStaleBatch(true);
        void reload();
        return;
      }
      if (isStaleWrite(http)) void reload();
      setActionError(errorMessage(error, "The batch could not be downloaded."));
      return;
    }
    if (!isSafeBatchUrl(link.url)) {
      setActionError("The batch link was refused: it is not a secure (https) link.");
      return;
    }
    setStaleBatch(false);
    setBatchLink(link); // focus moves to the link (the effect above)
    announce("The batch link is ready. Use Open batch to open it.", { focus: false });
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
            onClick={() => void retryRead()}
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
      {staleBatch && run.status === "ready" ? (
        <div style={{ display: "flex", gap: t.space2, alignItems: "center", flexWrap: "wrap" }}>
          <ErrorText>
            The batch was not downloaded: someone in it opted out or their plan closed since it was
            generated.{" "}
            {mayDispatch
              ? "Regenerate the batch to leave them out, then download the new one."
              : "Someone who can send mailings must regenerate it before it can be downloaded."}
          </ErrorText>
          {mayDispatch ? (
            <Button
              size="sm"
              loading={busy === "generate"}
              disabled={busy !== null}
              onClick={() => void generate()}
            >
              Regenerate batch
            </Button>
          ) : null}
        </div>
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
          : they opted out or their plan closed after the batch was downloaded. They are NOT logged
          as mailed. If their letters have not gone out, pull them by the Ref number printed on each
          letter (the Order column below).
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
            {mayDispatch && canRegenerate(run.status) && !staleBatch ? (
              <Button
                tone="secondary"
                loading={busy === "generate"}
                disabled={busy !== null || !wordingComplete}
                onClick={() => openCeremony("regenerate")}
              >
                Regenerate batch
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
        {batchLink ? (
          <span>
            <a
              ref={batchLinkRef}
              href={batchLink.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setBatchLink(null)}
            >
              Open batch
            </a>{" "}
            <span style={mutedStyle}>
              (opens in a new tab and is removed from this page once used; it expires at{" "}
              {dateTime(batchLink.expiresAt)})
            </span>
          </span>
        ) : null}
        {actionError && !confirmOpen ? <ErrorText>{actionError}</ErrorText> : null}
      </Card>

      <MailingRunItems runId={run.runId} refreshKey={`${run.status}:${run.version}`} />

      {ceremony === "wording" ? (
        <EditWordingModal
          run={run}
          onClose={() => setCeremony(null)}
          onStale={reload}
          onRefused={(message) => {
            setCeremony(null);
            announce(message);
            void reload();
          }}
          onSaved={(next) => {
            adopt(next);
            setCeremony(null);
            announce("The wording was saved.");
          }}
        />
      ) : null}
      {ceremony === "regenerate" ? (
        <Modal
          title="Regenerate this batch"
          onClose={() => setCeremony(null)}
          busy={busy === "generate"}
          role="alertdialog"
          describedBy={regenerateDescId}
          cancelLabel="Keep this batch"
          footer={
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={busy !== null || !canRegenerate(run.status)}
              onClick={() => void generate()}
            >
              {busy === "generate" ? "Regenerating…" : "Regenerate batch"}
            </button>
          }
        >
          <span id={regenerateDescId}>
            The recipients are selected and the batch is rendered again. Any copy of this batch
            already downloaded, and its Ref numbers, are superseded: do not mail it. Download the
            new batch when it is ready.
          </span>
          {actionError ? <ErrorText>{actionError}</ErrorText> : null}
        </Modal>
      ) : null}
      {ceremony === "confirm" ? (
        <Modal
          title="Confirm the run was mailed"
          onClose={() => setCeremony(null)}
          busy={busy === "confirm"}
          role="alertdialog"
          describedBy={confirmDescId}
          footer={
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={busy !== null || !canConfirmMailed(run.status)}
              onClick={() => void confirmMailed()}
            >
              {busy === "confirm" ? "Confirming…" : "Confirm mailed"}
            </button>
          }
        >
          <span id={confirmDescId} style={mutedStyle}>
            Confirming records that the printed letters went out. Each of the {counts.included}{" "}
            {counts.included === 1 ? "family" : "families"} in the batch gets this mailing logged on
            their contact as a program activity; it does not count as a touchpoint.
          </span>
          <Notice tone="warning">
            This records the mailing; it cannot recall printed letters. Anyone who became ineligible
            since the batch was downloaded (an opt-out, a request for no mailings, a closed plan) is
            flagged and not logged as mailed. If their letter has not gone out, pull it by its Ref
            number.
          </Notice>
          {actionError ? <ErrorText>{actionError}</ErrorText> : null}
        </Modal>
      ) : null}
      {ceremony === "cancel" ? (
        <Modal
          title="Cancel this mailing run"
          onClose={() => setCeremony(null)}
          busy={busy === "cancel"}
          role="alertdialog"
          describedBy={cancelDescId}
          cancelLabel="Keep run"
          footer={
            <button
              type="button"
              style={dangerButtonStyle}
              disabled={busy !== null}
              onClick={() => void cancel()}
            >
              {busy === "cancel" ? "Cancelling…" : "Yes, cancel this run"}
            </button>
          }
        >
          <span id={cancelDescId} style={mutedStyle}>
            A cancelled run is not generated, printed or logged, and it cannot be reopened. Nothing
            is recorded on any family's contact.
          </span>
          {actionError ? <ErrorText>{actionError}</ErrorText> : null}
        </Modal>
      ) : null}
    </div>
  );
}
