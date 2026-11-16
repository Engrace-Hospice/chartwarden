import {
  Button,
  DetailPageLayout,
  EmptyState,
  PageHeader,
  StatusPill,
  type StatusTone,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/10-hope — HOPE submission detail (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_HOPE_ENGINE.md — "Use Documentation Workspace."
// Per-batch outcomes: status, item/accepted/rejected counts, transmit/accept timestamps. The §4.10 iQIES
// submission lifecycle is read-only here; the inline Correct/Retry write actions fill in as their write
// surfaces harden. Reads GET /api/v1/hope/submissions/:id via the typed client; the server enforces every
// scope incl. PE scope (ADR-0030 — no authz on the frontend). Leaves only (@chartwarden/ui).
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { NameLabel, patientNameOf } from "../../shell/name-display";
import { usePatientNames } from "../../shell/patient-names";
import { useSession } from "../../shell/session";
import { HopeActionModal } from "./hope-action-modal";
import {
  failedWriteMessage,
  isClientRefusal,
  isStaleVersionRefusal,
  readSucceeded,
  refusalWordsOf,
  withRequestTimeout,
  writeSucceeded,
} from "./hope-api";
import { LoadingRegion, useRetryFocus } from "./hope-retry-focus";
import { CANCEL_REASON_LABEL, SUBMISSION_TONE, rfaLabel, stateLabel } from "./hope-status";
import { RecordCmsResultModal } from "./record-cms-result-modal";
import { useFocusOnNewError } from "./use-focus-on-new-error";

const MANAGE_PERMISSION = "hope.submission.manage";
/** The request to mark a package uploaded got no usable answer: the server may or may not have applied it. */
const MARK_UPLOADED_UNCONFIRMED =
  "Could not confirm that the package was marked uploaded. Reload this page to check its status before trying again.";
/** The package WAS marked uploaded (the write was answered), but the page's re-read after it was not: say so, it cannot be undone. */
const MARK_UPLOADED_REFRESH_FAILED =
  "Could not refresh the HOPE submission. The package was marked uploaded: reload this page to see its status.";
const REFRESH_FAILED = "Could not refresh the HOPE submission.";
/** The write was answered as done (the page's own re-read after it is told apart above). */
const MARK_UPLOADED_DONE = "The package was marked uploaded to CMS.";
const CANCELLED_DONE = "Package cancelled. Its records can be packaged again.";
const RESULT_RECORDED_DONE = "CMS result recorded.";
const LOAD_FAILED = "Could not load the HOPE submission.";
/** hope.scope answers a submission outside the caller's scope with 404 (deny-as-not-found): Try again cannot make it appear. */
const NOT_AVAILABLE = "This HOPE submission was not found, or not available to you.";
const isNotAvailable = (status: number | undefined): boolean => status === 403 || status === 404;
/** What the package download came back with: the ZIP, or a refusal (its status and parsed body, when it had one). */
type PackageAnswer = { blob: Blob } | { refused: { status: number; body: unknown } };
const DOWNLOAD_FAILED = "Could not download the package.";
/** Batches never marked uploaded to CMS: the only ones that can still be marked uploaded or cancelled (the server enforces the same set). */
const NEVER_UPLOADED = new Set(["packaged", "exported"]);
/** Statuses where the CMS result may still be recorded (the server enforces the same set). */
const RESULT_RECORDABLE = new Set(["exported", "in_flight", "submitted_pending_result"]);
/** A CMS verdict on an item is final (the server ignores later rows for it), so the dialog never asks for one. */
const SETTLED_ITEM_STATUS = new Set(["accepted", "accepted_with_warnings", "rejected"]);

const ITEM_TONE: Record<string, StatusTone> = {
  accepted: "success",
  accepted_with_warnings: "warning",
  rejected: "error",
  pending: "progress",
  blocked: "error",
  unmatched: "warning",
  cancelled: "neutral",
};
const RESOLUTION_TONE: Record<string, StatusTone> = {
  needs_correction: "error",
  correction_in_progress: "progress",
  resubmitted: "progress",
  resolved: "success",
};

interface ItemRow {
  id: string;
  assessmentId: string;
  patientId: string | null;
  rfaKind: string | null;
  assessmentStatus: string | null;
  status: string;
  iqiesRecordId: string | null;
  processedAt: string | null;
  resolution: string | null;
  correctionAssessmentId: string | null;
}
interface FindingRow {
  id: string;
  assessmentId: string | null;
  severity: "error" | "warning";
  code: string | null;
  itemCode: string | null;
  message: string | null;
}

interface SubmissionDetail {
  id: string;
  providerEntityId: string;
  submissionPeriod: string;
  status: string;
  transportMode?: string;
  validationProfile?: string | null;
  packageFilename?: string | null;
  packageSha256?: string | null;
  packageSizeBytes?: number | null;
  itemCount: number;
  acceptedCount: number;
  rejectedCount: number;
  transmittedAt: string | null;
  exportedAt?: string | null;
  submittedAt?: string | null;
  acceptedAt: string | null;
  iqiesSubmissionReference?: string | null;
  cancelledAt?: string | null;
  cancelReasonCode?: string | null;
  resultImportedAt?: string | null;
  resultReportReference?: string | null;
  items?: ItemRow[];
  findings?: FindingRow[];
}

export function SubmissionDetail(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<SubmissionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by "Try again": the load below runs again, and focus keeps its place (the error leaves the page while it loads).
  const [loadAttempt, setLoadAttempt] = useState(0);
  const retry = useRetryFocus(loading, error);
  // False once the read is refused (403) or not found for this user (404): Try again could not change either.
  const [retryable, setRetryable] = useState(true);
  const [busy, setBusy] = useState(false);
  // Action failures (download / mark uploaded / refresh) are shown inline: they must not replace the loaded page.
  const [actionError, setActionError] = useState<string | null>(null);
  // The refusal takes focus: the button that was pressed is disabled while the write is out, and a browser that drops focus from
  // a disabled control (Firefox, Safari) would leave the keyboard user on the page's top.
  const actionErrorRef = useFocusOnNewError<HTMLParagraphElement>(actionError);
  // What the last successful action did, kept on the page (a transient toast would not hold focus): the control that was used
  // often disappears with the status it changed, and focus must not fall to the document with nothing said.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLOutputElement>(null);
  const [recording, setRecording] = useState(false);
  // R-08: cancelling a never-uploaded package asks for a reason in a dialog before anything is written.
  const [cancelling, setCancelling] = useState(false);
  // Marking uploaded is irreversible: the first click only asks, the second one writes.
  const [confirmingUpload, setConfirmingUpload] = useState(false);
  const confirmUploadRef = useRef<HTMLSpanElement>(null);
  const markUploadedRef = useRef<HTMLButtonElement>(null);
  const hadUploadConfirm = useRef(false);
  // Focus follows the step: Confirm on entry, "Mark uploaded" when the step is cancelled or dismissed.
  useEffect(() => {
    if (confirmingUpload) confirmUploadRef.current?.querySelector("button")?.focus();
    else if (hadUploadConfirm.current) markUploadedRef.current?.focus();
    hadUploadConfirm.current = confirmingUpload;
  }, [confirmingUpload]);
  // After a mark-uploaded write ends without an error (so the alert has no focus to take), the button is where the clinician was.
  const refocusAfterWrite = useRef(false);
  useEffect(() => {
    if (busy || !refocusAfterWrite.current) return;
    refocusAfterWrite.current = false;
    if (!actionError) markUploadedRef.current?.focus();
  }, [busy, actionError]);
  const canManage = useSession()?.permissions?.includes(MANAGE_PERMISSION) ?? false;
  // The control that was used can leave with the status it changed: when that leaves focus on the document, the note takes it.
  useEffect(() => {
    if (notice === null || row === null) return;
    const active = document.activeElement;
    if (active === null || active === document.body) noticeRef.current?.focus();
  }, [notice, row]);
  const items = row?.items ?? [];
  const isCancelled = row?.status === "cancelled";
  const findings = useMemo(
    () =>
      [...(row?.findings ?? [])].sort(
        (a, b) => Number(b.severity === "error") - Number(a.severity === "error"),
      ),
    [row?.findings],
  );
  const patientNames = usePatientNames(
    items.map((i) => i.patientId).filter((p): p is string => !!p),
  );
  const itemByAssessment = new Map(items.map((i) => [i.assessmentId, i]));
  const itemLabel = (i: ItemRow): string =>
    `${i.patientId ? (patientNames[i.patientId]?.name ?? "Patient") : "Patient"} — ${
      i.rfaKind ? rfaLabel(i.rfaKind) : "Assessment"
    }`;
  // Labels repeat (same patient + RFA): the 1-based row number keeps link names unique.
  const rowNumber = new Map(items.map((i, idx) => [i.assessmentId, idx + 1]));
  const itemAria = (i: ItemRow): string => `${itemLabel(i)}, row ${rowNumber.get(i.assessmentId)}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `loadAttempt` is not read here; bumping it is what re-runs the load (Try again)
  useEffect(() => {
    let active = true;
    (async () => {
      if (!id) return;
      setLoading(true);
      setError(null);
      setRetryable(true);
      setRow(null);
      try {
        // Bounded: a stalled connection must end in the error state below, not in a spinner that never stops.
        const reply = await withRequestTimeout((signal) =>
          client.GET("/api/v1/hope/submissions/{id}", { params: { path: { id } }, signal }),
        );
        if (!active) return;
        // An empty reply from a gateway fault has no error body: it is not a submission, and must not blank the page.
        if (readSucceeded(reply)) setRow(reply.data as SubmissionDetail);
        else if (isNotAvailable(reply.response?.status)) {
          setRetryable(false);
          setError(NOT_AVAILABLE);
        } else setError(LOAD_FAILED);
      } catch {
        if (active) setError(LOAD_FAILED);
      }
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, id, loadAttempt]);

  /** Re-reads the submission; false when that failed (`onFailure` is then shown, null to say nothing). */
  const reload = async (onFailure: string | null = REFRESH_FAILED): Promise<boolean> => {
    if (!id) return true;
    try {
      // Bounded like every request this page waits on: `busy` is still set while an action's re-read is out.
      const reply = await withRequestTimeout((signal) =>
        client.GET("/api/v1/hope/submissions/{id}", { params: { path: { id } }, signal }),
      );
      // A failed re-read keeps the submission already on screen (with its actions) and says so.
      if (readSucceeded(reply)) {
        setRow(reply.data as SubmissionDetail);
        return true;
      }
    } catch {
      // Handled below, like an unreadable reply.
    }
    if (onFailure !== null) setActionError(onFailure);
    return false;
  };

  const downloadPackage = async (): Promise<void> => {
    if (!id || busy) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      // fetch (not a navigation) so a 403/404/409 stays on this page instead of replacing the SPA with raw JSON.
      // Bounded, body included: a stalled download must free Download, Mark uploaded, Cancel package and Record CMS result.
      // (A package that takes longer than REQUEST_TIMEOUT_MS to arrive reads as a failed download; it is a read, so trying again is safe.)
      const answer = await withRequestTimeout(async (signal): Promise<PackageAnswer> => {
        const res = await fetch(`/api/v1/hope/submissions/${encodeURIComponent(id)}/package`, {
          credentials: "include",
          signal,
        });
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => null);
          return { refused: { status: res.status, body } };
        }
        return { blob: await res.blob() };
      });
      if ("refused" in answer) {
        // The server's own reason for a refusal it explained (a package cancelled since this page loaded says so); a 409 means this
        // page is out of date, so it is re-read, unless it only says the record was busy (the step was not applied: nothing to
        // re-read, and `busy` must not be held for the read).
        const { status, body } = answer.refused;
        setActionError((isClientRefusal(status) ? refusalWordsOf(body) : null) ?? DOWNLOAD_FAILED);
        if (isStaleVersionRefusal({ error: body, response: { status } })) await reload(null);
        return;
      }
      const url = URL.createObjectURL(answer.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = row?.packageFilename ?? `${id}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      await reload(); // the download advances a packaged batch to exported
    } catch {
      setActionError(DOWNLOAD_FAILED);
    } finally {
      setBusy(false);
    }
  };

  const markUploaded = async (): Promise<void> => {
    if (!id || busy) return;
    setConfirmingUpload(false);
    refocusAfterWrite.current = true;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const api = client as unknown as {
        POST: (
          path: string,
          init: unknown,
        ) => Promise<{
          data?: unknown;
          error?: unknown;
          response?: { ok?: boolean; status?: number };
        }>;
      };
      // Bounded: a stalled connection must not hold `busy` (and every action beside it) for good. An abort is a rejection,
      // told apart from a refusal in the catch below.
      const reply = await withRequestTimeout((signal) =>
        api.POST("/api/v1/hope/submissions/{id}/mark-uploaded", {
          params: { path: { id } },
          // No client clock: the server stamps `submittedAt` itself (now) when it is omitted, so a retry after a lost reply is the same
          // request and replays under the client's per-intent Idempotency-Key.
          body: {},
          signal,
        }),
      );
      // An empty 5xx has no error body, and is not a success: the package may or may not have been marked, so it says so.
      if (writeSucceeded(reply)) {
        // Marked, which cannot be undone: a re-read that fails after it says that, not just "could not refresh".
        if (await reload(MARK_UPLOADED_REFRESH_FAILED)) setNotice(MARK_UPLOADED_DONE);
      } else {
        setActionError(
          failedWriteMessage(
            reply,
            MARK_UPLOADED_UNCONFIRMED,
            "Could not mark this package uploaded.",
          ),
        );
        // A 409 says the page's picture of the package is out of date (cancelled or marked elsewhere): re-read it, keeping the
        // reason. A busy record (a lock wait timed out) is a 409 too, but the step was not applied and the page is not stale.
        if (isStaleVersionRefusal(reply)) await reload(null);
      }
    } catch {
      // No answer at all (offline, a reset, a timeout): the package may well have been marked, and that cannot be undone.
      setActionError(MARK_UPLOADED_UNCONFIRMED);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="HOPE Submission"
          actions={
            row ? (
              <div style={actions}>
                <StatusPill
                  label={stateLabel(row.status)}
                  tone={SUBMISSION_TONE[row.status] ?? "neutral"}
                />
                {canManage && row.packageFilename && row.status !== "cancelled" ? (
                  <button
                    type="button"
                    style={button}
                    onClick={() => void downloadPackage()}
                    disabled={busy}
                  >
                    Download ZIP
                  </button>
                ) : null}
                {canManage && RESULT_RECORDABLE.has(row.status) ? (
                  <button
                    type="button"
                    style={button}
                    onClick={() => setRecording(true)}
                    disabled={busy}
                  >
                    Record CMS result
                  </button>
                ) : null}
                {canManage && NEVER_UPLOADED.has(row.status) ? (
                  confirmingUpload ? (
                    <span
                      ref={confirmUploadRef}
                      style={{ display: "contents" }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" && !busy) setConfirmingUpload(false);
                      }}
                    >
                      <Button tone="primary" onClick={() => void markUploaded()} disabled={busy}>
                        Confirm: mark uploaded to CMS
                      </Button>
                      <Button
                        tone="tertiary"
                        onClick={() => setConfirmingUpload(false)}
                        disabled={busy}
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <button
                      ref={markUploadedRef}
                      type="button"
                      style={button}
                      onClick={() => setConfirmingUpload(true)}
                      disabled={busy}
                    >
                      Mark uploaded
                    </button>
                  )
                ) : null}
                {canManage && NEVER_UPLOADED.has(row.status) ? (
                  <button
                    type="button"
                    style={button}
                    onClick={() => setCancelling(true)}
                    disabled={busy}
                  >
                    Cancel package
                  </button>
                ) : null}
              </div>
            ) : undefined
          }
        />
      }
    >
      {notice ? (
        <output
          ref={noticeRef}
          tabIndex={-1}
          style={{
            display: "block",
            margin: "0 0 0.75rem",
            color: "var(--color-success-pill-fg)",
            fontWeight: 600,
          }}
        >
          {notice}
        </output>
      ) : null}
      {actionError ? (
        <p
          ref={actionErrorRef}
          tabIndex={-1}
          role="alert"
          style={{ margin: "0 0 0.75rem", color: "var(--color-error)" }}
        >
          {actionError}
        </p>
      ) : null}
      {error ? (
        <div ref={retry.errorRef} tabIndex={-1}>
          <EmptyState
            title="Unavailable"
            description={error}
            action={
              retryable ? (
                <Button
                  tone="secondary"
                  onClick={() => {
                    retry.retried();
                    setLoadAttempt((attempt) => attempt + 1);
                  }}
                >
                  Try again
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : loading || !row ? (
        <LoadingRegion label="Loading HOPE submission" regionRef={retry.loadingRef} />
      ) : (
        <>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "10rem 1fr",
              gap: "0.4rem 1rem",
              fontSize: "0.85rem",
            }}
          >
            <dt style={dt}>Provider entity</dt>
            <dd style={dd} className="wx-data-md">
              {row.providerEntityId}
            </dd>
            <dt style={dt}>Period</dt>
            <dd style={dd}>{row.submissionPeriod}</dd>
            <dt style={dt}>Status</dt>
            <dd style={dd}>
              <StatusPill
                label={stateLabel(row.status)}
                tone={SUBMISSION_TONE[row.status] ?? "neutral"}
              />
            </dd>
            <dt style={dt}>Items</dt>
            <dd style={dd} className="tabular-nums">
              {row.itemCount}
            </dd>
            <dt style={dt}>Accepted</dt>
            <dd style={dd} className="tabular-nums">
              {row.acceptedCount}
            </dd>
            <dt style={dt}>Rejected</dt>
            <dd
              style={{ ...dd, color: row.rejectedCount > 0 ? "var(--color-error)" : undefined }}
              className="tabular-nums"
            >
              {row.rejectedCount}
            </dd>
            <dt style={dt}>Transmitted</dt>
            <dd style={dd} className="tabular-nums">
              {row.transmittedAt ? row.transmittedAt.slice(0, 16).replace("T", " ") : "—"}
            </dd>
            <dt style={dt}>Transport</dt>
            <dd style={dd}>{row.transportMode ?? "manual_iqies_upload"}</dd>
            <dt style={dt}>Validation profile</dt>
            <dd style={dd}>{row.validationProfile ?? "Not recorded"}</dd>
            <dt style={dt}>Package</dt>
            <dd style={dd}>{row.packageFilename ?? "Not packaged"}</dd>
            <dt style={dt}>Package hash</dt>
            <dd style={dd} className="wx-data-md">
              {row.packageSha256 ?? "Not recorded"}
            </dd>
            <dt style={dt}>Manual upload</dt>
            <dd style={dd}>
              {row.submittedAt
                ? row.submittedAt.slice(0, 16).replace("T", " ")
                : isCancelled
                  ? "Never uploaded"
                  : "Awaiting iQIES upload"}
            </dd>
            <dt style={dt}>Accepted at</dt>
            <dd style={dd} className="tabular-nums">
              {row.acceptedAt ? row.acceptedAt.slice(0, 16).replace("T", " ") : "—"}
            </dd>
            <dt style={dt}>CMS result recorded</dt>
            <dd style={dd} className="tabular-nums">
              {row.resultImportedAt
                ? row.resultImportedAt.slice(0, 16).replace("T", " ")
                : isCancelled
                  ? "Not applicable"
                  : "Awaiting CMS result"}
            </dd>
            <dt style={dt}>Report reference</dt>
            <dd style={dd}>{row.resultReportReference ?? "—"}</dd>
            {isCancelled ? (
              <>
                <dt style={dt}>Cancelled</dt>
                <dd style={dd}>
                  {row.cancelledAt ? `${row.cancelledAt.slice(0, 16).replace("T", " ")} — ` : ""}
                  {CANCEL_REASON_LABEL[row.cancelReasonCode as keyof typeof CANCEL_REASON_LABEL] ??
                    "Reason not recorded"}
                </dd>
              </>
            ) : null}
          </dl>
          {isCancelled ? (
            <p style={meta}>
              This package was cancelled and must not be uploaded to CMS. Its records were released:
              generate a new package from the submissions list.
            </p>
          ) : null}
          <h2 style={h2}>Records in this batch</h2>
          {items.length === 0 ? (
            <p style={meta}>No records in this batch.</p>
          ) : (
            <div className="wx-list-table-wrap">
              <table className="wx-list-table">
                <thead>
                  <tr>
                    <th scope="col">Patient</th>
                    <th scope="col">Timepoint</th>
                    <th scope="col">Assessment</th>
                    <th scope="col">CMS outcome</th>
                    <th scope="col">Resolution</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        {i.patientId ? (
                          <Link to={`/patients/${i.patientId}/hope`}>
                            <NameLabel value={patientNameOf(patientNames, i.patientId)} />
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>{i.rfaKind ? rfaLabel(i.rfaKind) : "—"}</td>
                      <td>
                        <Link
                          to={`/hope/assessments/${i.assessmentId}`}
                          aria-label={`View assessment, ${itemAria(i)}`}
                        >
                          View assessment
                        </Link>
                      </td>
                      <td>
                        <StatusPill
                          label={stateLabel(i.status)}
                          tone={ITEM_TONE[i.status] ?? "neutral"}
                        />
                      </td>
                      <td>
                        {i.resolution ? (
                          <StatusPill
                            label={stateLabel(i.resolution)}
                            tone={RESOLUTION_TONE[i.resolution] ?? "neutral"}
                          />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {i.correctionAssessmentId ? (
                          <Link
                            to={`/hope/assessments/${i.correctionAssessmentId}`}
                            aria-label={`Open correction, ${itemAria(i)}`}
                          >
                            Open correction
                          </Link>
                        ) : i.resolution === "needs_correction" ? (
                          <Link
                            to={`/hope/assessments/${i.assessmentId}`}
                            aria-label={`Correct this assessment, ${itemAria(i)}`}
                          >
                            Correct this assessment
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h2 style={h2}>Findings</h2>
          {findings.length === 0 ? (
            <p style={meta}>
              {row.resultImportedAt
                ? "No findings recorded."
                : isCancelled
                  ? "No CMS result: this package was never uploaded."
                  : "Awaiting CMS result."}
            </p>
          ) : (
            <div className="wx-list-table-wrap">
              <table className="wx-list-table">
                <thead>
                  <tr>
                    <th scope="col">Severity</th>
                    <th scope="col">Record</th>
                    <th scope="col">Code</th>
                    <th scope="col">Item</th>
                    <th scope="col">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {findings.map((f) => {
                    const item = f.assessmentId ? itemByAssessment.get(f.assessmentId) : undefined;
                    return (
                      <tr key={f.id}>
                        <td>
                          <StatusPill
                            label={stateLabel(f.severity)}
                            tone={f.severity === "error" ? "error" : "warning"}
                          />
                        </td>
                        <td>
                          {f.assessmentId ? (
                            <Link
                              to={`/hope/assessments/${f.assessmentId}`}
                              aria-label={
                                item
                                  ? `View assessment, ${itemAria(item)}`
                                  : `View assessment ${f.assessmentId.slice(0, 8)}`
                              }
                            >
                              {item ? itemLabel(item) : "View assessment"}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{f.code ?? "—"}</td>
                        <td>{f.itemCode ?? "—"}</td>
                        <td>{f.message ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {row ? (
        <HopeActionModal
          open={cancelling}
          action="cancel-package"
          targetId={row.id}
          onClose={() => setCancelling(false)}
          onConflict={() => void reload()}
          onDone={() => {
            setNotice(CANCELLED_DONE);
            void reload();
          }}
        />
      ) : null}
      {row ? (
        <RecordCmsResultModal
          open={recording}
          submissionId={row.id}
          items={items
            .filter((i) => !SETTLED_ITEM_STATUS.has(i.status))
            .map((i) => ({ assessmentId: i.assessmentId, label: itemLabel(i) }))}
          onClose={() => setRecording(false)}
          onConflict={() => void reload()}
          onDone={() => {
            setNotice(RESULT_RECORDED_DONE);
            void reload();
          }}
        />
      ) : null}
    </DetailPageLayout>
  );
}

const meta = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
} as const;
const actions = { display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" } as const;
const button = {
  border: "1px solid var(--color-outline)",
  borderRadius: 8,
  padding: "0.45rem 0.7rem",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  fontWeight: 650,
  cursor: "pointer",
} as const;
const h2 = { fontSize: "1rem", fontWeight: 600, margin: "1.5rem 0 0.5rem" } as const;
const dt = { fontWeight: 600, color: "var(--color-on-surface)" } as const;
const dd = { margin: 0 } as const;
