// The parts of the unified review page that surround the three columns: the header actions that start,
// release and complete a review, the progress strip, and the read-only banners.
import { Glyph, StatusPill, type StatusTone, useApiClient } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import type { PlatformSupportAccess, Workspace } from "../doclens-api";
import { releaseReview, startReview } from "../doclens-api";
import { batchStatusLabel, sourceLabel } from "../doclens-model";
import type { ReviewGate } from "./review-completion-gate";

const SECTION_TOTAL = 6;
const START_UNREACHABLE = "Could not reach the server. The review may not have started; retry.";
const RELEASE_FAILED = "The review could not be released. Try again.";
const RELEASED_NOT_REFRESHED = "Review released. Refresh the workspace before continuing.";

export function ReviewHeaderActions({
  batchId,
  workspace,
  gate,
  tone,
  supportAccess,
  refreshRequired,
  returnTo,
  refresh,
  busy,
  onActionError,
  onReleased,
  onCompleteOpen,
}: {
  batchId: string;
  workspace: Workspace;
  gate: ReviewGate;
  tone: StatusTone;
  supportAccess: PlatformSupportAccess | null;
  refreshRequired: boolean;
  returnTo: string | null;
  refresh: () => Promise<Workspace | null>;
  /** True while a decision is being saved: no review is started, released or completed under it. */
  busy: boolean;
  onActionError: (message: string | null) => void;
  /** Release succeeded: the caller fails closed (owner-only actions off) before the follow-up read. */
  onReleased: () => void;
  onCompleteOpen: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [starting, setStarting] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const detailQuery = new URLSearchParams({ mode: "detailed", from: "unified" });
  if (returnTo) detailQuery.set("returnTo", returnTo);

  async function start(): Promise<void> {
    setStarting(true);
    onActionError(null);
    try {
      const result = await startReview(client, batchId);
      if (!result.ok) onActionError(result.message);
      else await refresh();
    } catch {
      onActionError(START_UNREACHABLE);
    } finally {
      setStarting(false);
    }
  }

  async function release(): Promise<void> {
    const review = workspace.review;
    if (!review) return;
    setLifecycleBusy(true);
    onActionError(null);
    try {
      const result = await releaseReview(client, review.id);
      if (!result.ok) {
        onActionError(result.message);
        return;
      }
      onReleased();
      const latest = await refresh();
      if (!latest) onActionError(RELEASED_NOT_REFRESHED);
    } catch {
      onActionError(RELEASE_FAILED);
    } finally {
      setLifecycleBusy(false);
    }
  }

  const canStart =
    !supportAccess &&
    !refreshRequired &&
    workspace.review?.status !== "in_progress" &&
    !gate.complete;
  return (
    <div className="wx-unified-head-actions">
      <StatusPill
        label={gate.complete ? "Review complete" : batchStatusLabel(workspace.batch.status)}
        tone={tone}
      />
      {supportAccess ? <StatusPill label="Read-only support session" tone="warning" /> : null}
      {canStart ? (
        <button
          type="button"
          className="wx-btn-primary"
          disabled={starting || busy}
          onClick={() => void start()}
        >
          {starting ? "Starting…" : "Start review"}
        </button>
      ) : null}
      {!supportAccess && gate.reviewMine ? (
        <>
          <button
            type="button"
            className="wx-btn-secondary"
            disabled={lifecycleBusy || busy}
            onClick={() => void release()}
          >
            Release review
          </button>
          <button
            type="button"
            className="wx-btn-primary"
            disabled={lifecycleBusy || busy || gate.blocked}
            aria-describedby={gate.blockedReason ? "unified-completion-help" : undefined}
            onClick={onCompleteOpen}
          >
            <Glyph name="file-check" size={16} /> Complete review
          </button>
          {gate.blockedReason ? (
            <span id="unified-completion-help" className="wx-unified-completion-help">
              {gate.blockedReason}
            </span>
          ) : null}
        </>
      ) : null}
      {returnTo ? (
        <Link className="wx-btn-secondary" to={returnTo}>
          Back to referral intake
        </Link>
      ) : null}
      {!supportAccess ? (
        <Link
          className="wx-btn-secondary"
          to={`/intake/${encodeURIComponent(batchId)}/review?${detailQuery.toString()}`}
        >
          <Glyph name="eye" size={16} /> Legacy detailed reviewer
        </Link>
      ) : null}
    </div>
  );
}

export function ReviewProgress({
  decidedCount,
  candidateCount,
  reviewedSectionCount,
}: {
  decidedCount: number;
  candidateCount: number;
  reviewedSectionCount: number;
}): JSX.Element {
  return (
    <section className="wx-unified-progress" aria-labelledby="unified-progress-title">
      <div>
        <strong id="unified-progress-title">Review progress</strong>
        <span>
          {decidedCount} of {candidateCount} observations decided · {reviewedSectionCount} of{" "}
          {SECTION_TOTAL} sections reviewed
        </span>
      </div>
      <progress
        aria-labelledby="unified-progress-title"
        max={Math.max(1, candidateCount)}
        value={decidedCount}
      >
        {candidateCount === 0 ? "No extracted candidates" : `${decidedCount} of ${candidateCount}`}
      </progress>
      <small>Server safeguards and completion rules remain authoritative.</small>
    </section>
  );
}

/** Static notes, not announcements: they are on the page when it loads, not changes to report. */
export function ReviewBanners({
  workspace,
  supportAccess,
}: {
  workspace: Workspace;
  supportAccess: PlatformSupportAccess | null;
}): JSX.Element {
  return (
    <>
      {workspace.review?.status === "in_progress" && !workspace.review.isMine ? (
        <div className="wx-unified-banner" role="note">
          <Glyph name="lock" size={18} />
          <div>
            <strong>Read-only while another reviewer owns this review</strong>
            <span>Source evidence remains visible when authorized; decisions stay locked.</span>
          </div>
        </div>
      ) : null}
      {supportAccess ? (
        <div className="wx-unified-banner" role="note">
          <Glyph name="shield" size={18} />
          <div>
            <strong>Tenant-consented platform support access</strong>
            <span>
              Source evidence is available for this active support session. Review ownership,
              decisions, safeguard resolution, completion, and release remain tenant-controlled.
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function ReviewTitle({ workspace }: { workspace: Workspace }): JSX.Element {
  const documentCount = workspace.documents.length;
  return (
    <div>
      <p className="wx-unified-eyebrow">WardenLens / Review workspace</p>
      <h1>Review patient information</h1>
      <p>
        {workspace.batch.patientName ?? "Unassigned intake"} · {documentCount} source document
        {documentCount === 1 ? "" : "s"} · {sourceLabel(workspace.batch.sourceChannel)}
      </p>
    </div>
  );
}

export function ReviewActionError({
  message,
  onRetryRefresh,
}: {
  message: string;
  /** Offered only when the workspace failed to refresh after a successful release. */
  onRetryRefresh: (() => void) | null;
}): JSX.Element {
  return (
    <div className="wx-unified-action-error">
      <p role="alert" className="wx-doclens-error">
        {message}
      </p>
      {onRetryRefresh ? (
        <button type="button" className="wx-btn-secondary" onClick={onRetryRefresh}>
          Retry workspace refresh
        </button>
      ) : null}
    </div>
  );
}

export function ReviewTaskEmpty(): JSX.Element {
  return (
    <section className="wx-unified-task-empty" aria-label="Review task">
      <Glyph name="info" size={28} />
      <h2>Select a review task</h2>
      <p>Choose an observation or exception to inspect its source and record a decision.</p>
    </section>
  );
}
