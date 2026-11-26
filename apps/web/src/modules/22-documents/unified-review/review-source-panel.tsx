import { Glyph, StatusPill, useApiClient } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { Link } from "react-router-dom";
import type { Candidate, PlatformSupportAccess, Workspace } from "../doclens-api";
import { decide, pageImageUrl } from "../doclens-api";
import {
  MIN_REASON,
  PART2_WITHHELD_MESSAGE,
  bboxPercent,
  decisionLabel,
  docTypeLabel,
  fieldLabel,
  pct,
} from "../doclens-model";

type ImageState = "loading" | "ready" | "unavailable" | "forbidden";
type DecisionMode = "edit" | "reject" | null;

function detailPath(batchId: string, candidateId: string, returnTo: string | null): string {
  const query = new URLSearchParams({ mode: "detailed", from: "unified", candidate: candidateId });
  if (returnTo) query.set("returnTo", returnTo);
  return `/intake/${encodeURIComponent(batchId)}/review?${query.toString()}`;
}

export function ReviewSourcePanel({
  batchId,
  workspace,
  candidate,
  returnTo,
  onClose,
  onAvailabilityChange,
  refresh,
  onDecisionSaved,
  nextCandidate,
  onNext,
  supportAccess,
}: {
  batchId: string;
  workspace: Workspace;
  candidate: Candidate;
  returnTo: string | null;
  onClose: () => void;
  onAvailabilityChange: (page: number, unavailable: boolean) => void;
  refresh: () => Promise<Workspace | null>;
  onDecisionSaved: (workspace: Workspace, candidateId: string) => void;
  nextCandidate: Candidate | null;
  onNext: () => void;
  supportAccess?: PlatformSupportAccess | null;
}): JSX.Element {
  const client = useApiClient();
  const [attempt, setAttempt] = useState(0);
  const [imageState, setImageState] = useState<ImageState>(() =>
    candidate.redacted ? "forbidden" : "loading",
  );
  const [sourceConfirmed, setSourceConfirmed] = useState(false);
  const [mode, setMode] = useState<DecisionMode>(null);
  const [editValue, setEditValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceGeneration = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: an explicit retry must reset source state.
  useEffect(() => {
    sourceGeneration.current += 1;
    setImageState(candidate.redacted ? "forbidden" : "loading");
    setSourceConfirmed(false);
    setMode(null);
    setEditValue(candidate.decision?.editedValue ?? candidate.value ?? "");
    setReason("");
    setMessage(null);
    setRefreshPending(false);
    setError(null);
  }, [candidate.id, candidate.redacted, attempt]);

  const review = workspace.review;
  const canOwnDecision = review?.status === "in_progress" && review.isMine;
  const complete = review?.status === "complete" || workspace.batch.status === "writeback_complete";
  const page = workspace.pages.find((item) => item.page === candidate.page) ?? null;
  const canSubmit = Boolean(
    canOwnDecision &&
      !complete &&
      !candidate.redacted &&
      !refreshPending &&
      imageState === "ready" &&
      sourceConfirmed,
  );
  const visionReasonRequired = candidate.vision.status === "disagreed";

  const unavailable = (state: "unavailable" | "forbidden"): void => {
    setImageState(state);
    setSourceConfirmed(false);
    onAvailabilityChange(candidate.page, true);
  };
  const onImageError = (): void => {
    const generation = sourceGeneration.current;
    fetch(pageImageUrl(batchId, candidate.page, supportAccess))
      .then((response) => {
        if (sourceGeneration.current !== generation) return;
        unavailable(response.status === 403 ? "forbidden" : "unavailable");
      })
      .catch(() => {
        if (sourceGeneration.current !== generation) return;
        unavailable("unavailable");
      });
  };

  async function save(
    decision: "approve" | "approve_with_edit" | "reject",
    extra: { editedValue?: string; reason?: string } = {},
  ): Promise<void> {
    if (!review || !canSubmit || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await decide(client, review.id, {
      candidateId: candidate.id,
      decision,
      sourceViewConfirmed: true,
      ...(extra.editedValue !== undefined ? { editedValue: extra.editedValue } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
    });
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
      return;
    }
    const latest = await refresh();
    setBusy(false);
    setMode(null);
    if (!latest) {
      setRefreshPending(true);
      setMessage(
        "Decision saved, but the workspace could not be refreshed. Retry before continuing.",
      );
      return;
    }
    setMessage(
      decision === "approve"
        ? `Decision saved: accepted ${candidate.value ?? "extracted value"}`
        : decision === "approve_with_edit"
          ? `Decision saved: corrected to ${extra.editedValue ?? "edited value"}`
          : "Decision saved: rejected extracted value",
    );
    onDecisionSaved(latest, candidate.id);
  }

  async function retryRefresh(): Promise<void> {
    setBusy(true);
    const latest = await refresh();
    setBusy(false);
    if (!latest) return;
    setRefreshPending(false);
    setMessage("Decision saved and workspace refreshed.");
    onDecisionSaved(latest, candidate.id);
  }

  const submitEdit = (event: FormEvent): void => {
    event.preventDefault();
    const value = editValue.trim();
    if (value) void save("approve_with_edit", { editedValue: value });
  };
  const submitReject = (event: FormEvent): void => {
    event.preventDefault();
    const value = reason.trim();
    if (value.length === 0 || value.length >= MIN_REASON)
      void save("reject", value ? { reason: value } : {});
  };

  return (
    <section className="wx-unified-source" aria-label="Review task" tabIndex={-1}>
      <header>
        <div>
          <span className="wx-unified-category">Review task · Page {candidate.page}</span>
          <h2>{fieldLabel(candidate.fieldPath)}</h2>
          <p>
            {candidate.redacted
              ? "Protected value withheld"
              : (candidate.value ?? "No value extracted")}{" "}
            · {docTypeLabel(candidate.documentType)} · {pct(candidate.confidence)} confidence
          </p>
        </div>
        <button type="button" className="wx-btn-secondary wx-btn-sm" onClick={onClose}>
          <Glyph name="close" size={15} /> Close task
        </button>
      </header>

      <div className="wx-unified-source-stage">
        {candidate.redacted || imageState === "forbidden" ? (
          <div role="alert" className="wx-unified-source-failure">
            <Glyph name="shield" size={24} />
            <strong>Source access is restricted</strong>
            <p>{PART2_WITHHELD_MESSAGE}</p>
          </div>
        ) : imageState === "unavailable" ? (
          <div role="alert" className="wx-unified-source-failure">
            <Glyph name="alert" size={24} />
            <strong>Source page could not be loaded</strong>
            <p>This observation cannot be source-confirmed from this preview.</p>
            <button
              type="button"
              className="wx-btn-secondary"
              onClick={() => setAttempt((current) => current + 1)}
            >
              <Glyph name="rotate-ccw" size={16} /> Retry source
            </button>
          </div>
        ) : (
          <>
            <StatusPill
              label={imageState === "loading" ? "Loading source" : "Source loaded"}
              tone={imageState === "loading" ? "progress" : "success"}
            />
            <div className="wx-unified-source-page">
              <img
                key={`${candidate.id}:${attempt}`}
                src={pageImageUrl(batchId, candidate.page, supportAccess)}
                alt={`Page ${candidate.page} of the source document for ${fieldLabel(candidate.fieldPath)}`}
                onLoad={() => {
                  setImageState("ready");
                  onAvailabilityChange(candidate.page, false);
                }}
                onError={onImageError}
              />
              {imageState === "ready" && page ? (
                <span
                  className="wx-unified-source-box"
                  style={bboxPercent(candidate.bbox, page)}
                  aria-hidden="true"
                />
              ) : null}
            </div>
          </>
        )}
      </div>

      <div className="wx-unified-decision">
        {message ? <output className="wx-unified-decision-success">{message}</output> : null}
        {refreshPending ? (
          <button
            type="button"
            className="wx-btn-secondary"
            disabled={busy}
            onClick={() => void retryRefresh()}
          >
            <Glyph name="rotate-ccw" size={16} /> {busy ? "Refreshing…" : "Retry workspace refresh"}
          </button>
        ) : null}
        {error ? (
          <p role="alert" className="wx-doclens-error">
            {error}
          </p>
        ) : null}
        {supportAccess ? (
          <p className="wx-row-sub">
            Support-session access is read-only. Candidate decisions remain with an authorized
            tenant reviewer.
          </p>
        ) : candidate.redacted ? (
          <p>{PART2_WITHHELD_MESSAGE} No candidate decision is available from this view.</p>
        ) : !canOwnDecision || complete ? (
          <p className="wx-row-sub">
            {complete
              ? "Review complete — decisions are read-only."
              : review?.status === "in_progress"
                ? "Another reviewer owns this review."
                : "Start the review before recording candidate decisions."}
          </p>
        ) : (
          <>
            <label className="wx-doclens-check">
              <input
                type="checkbox"
                checked={sourceConfirmed}
                disabled={imageState !== "ready" || busy}
                onChange={(event) => setSourceConfirmed(event.target.checked)}
              />
              I compared this with the source
            </label>
            {visionReasonRequired && mode === null ? (
              <label className="wx-doclens-input">
                <span>
                  The vision check read “{candidate.vision.observedValue ?? "—"}”. Give a reason to
                  accept the extracted value unchanged, or edit it to the supported value.
                </span>
                <input
                  aria-label="Reason for accepting despite the page reading"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
            ) : null}
            {mode === "edit" ? (
              <form className="wx-doclens-input" onSubmit={submitEdit}>
                <label htmlFor={`unified-edit-${candidate.id}`}>Corrected value</label>
                <input
                  id={`unified-edit-${candidate.id}`}
                  value={editValue}
                  onChange={(event) => setEditValue(event.target.value)}
                />
                <div className="wx-doclens-buttons">
                  <button type="button" className="wx-btn-secondary" onClick={() => setMode(null)}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="wx-btn-primary"
                    disabled={!canSubmit || busy || editValue.trim().length === 0}
                  >
                    {busy ? "Saving…" : "Save corrected value"}
                  </button>
                </div>
              </form>
            ) : mode === "reject" ? (
              <form className="wx-doclens-input" onSubmit={submitReject}>
                <label htmlFor={`unified-reject-${candidate.id}`}>
                  Rejection reason (optional; at least {MIN_REASON} characters if entered)
                </label>
                <input
                  id={`unified-reject-${candidate.id}`}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <div className="wx-doclens-buttons">
                  <button type="button" className="wx-btn-secondary" onClick={() => setMode(null)}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="wx-btn-primary"
                    disabled={
                      !canSubmit ||
                      busy ||
                      (reason.trim().length > 0 && reason.trim().length < MIN_REASON)
                    }
                  >
                    {busy ? "Saving…" : "Reject extracted value"}
                  </button>
                </div>
              </form>
            ) : (
              <div className="wx-unified-decision-actions">
                <button
                  type="button"
                  className="wx-btn-primary"
                  aria-label="Accept extracted value"
                  disabled={
                    !canSubmit ||
                    busy ||
                    (visionReasonRequired && reason.trim().length < MIN_REASON)
                  }
                  onClick={() =>
                    void save("approve", visionReasonRequired ? { reason: reason.trim() } : {})
                  }
                >
                  <Glyph name="check" size={16} /> Accept
                </button>
                <button
                  type="button"
                  className="wx-btn-secondary"
                  aria-label="Edit value"
                  disabled={!canSubmit || busy}
                  onClick={() => setMode("edit")}
                >
                  <Glyph name="pencil" size={16} /> Edit
                </button>
                <button
                  type="button"
                  className="wx-btn-secondary"
                  aria-label="Reject extracted value"
                  disabled={!canSubmit || busy}
                  onClick={() => setMode("reject")}
                >
                  <Glyph name="x-circle" size={16} /> Reject
                </button>
              </div>
            )}
            {candidate.riskLevel === "high" ? (
              <p className="wx-row-sub">
                High-risk field: the server requires an eligible RN, NP, PA, or physician reviewer.
              </p>
            ) : null}
          </>
        )}
        {message && !refreshPending && nextCandidate ? (
          <button type="button" className="wx-btn-primary wx-unified-next" onClick={onNext}>
            Next issue: {fieldLabel(nextCandidate.fieldPath)} <Glyph name="arrow-right" size={16} />
          </button>
        ) : null}
      </div>

      <footer>
        <p>
          Opening this preview does not confirm the source. A decision is sent only after the source
          is visible and the comparison checkbox is selected.
        </p>
        {!supportAccess ? (
          <details className="wx-unified-advanced-tools">
            <summary>Advanced tools</summary>
            <Link className="wx-btn-secondary" to={detailPath(batchId, candidate.id, returnTo)}>
              Leave unified workspace for legacy reviewer <Glyph name="arrow-right" size={16} />
            </Link>
          </details>
        ) : null}
        {candidate.decision ? (
          <StatusPill label={decisionLabel(candidate.decision.decision)} tone="success" />
        ) : null}
      </footer>
    </section>
  );
}
