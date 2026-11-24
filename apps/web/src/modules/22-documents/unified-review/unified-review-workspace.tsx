import { EmptyState, Glyph, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { safeIntakeReturnTo } from "../../../shell/intake-return";
import type { Workspace } from "../doclens-api";
import { completeReview, releaseReview, startReview } from "../doclens-api";
import { batchStatusLabel, identityNeedsAnswer, sourceLabel } from "../doclens-model";
import { CompleteDialog, DocLensReviewWorkspace } from "../doclens-review-workspace";
import { ReviewExceptionPanel } from "./review-exception-panel";
import { type ReviewExceptionTask, projectExceptionSummary } from "./review-exception-tasks";
import { exceptionCountsBySection, projectReviewExceptions } from "./review-exceptions";
import { ReviewFieldGroup } from "./review-field-group";
import {
  candidateIsOtherPatient,
  projectReviewGroups,
  projectUnifiedReview,
} from "./review-projection";
import { ReviewSafeguardPanel } from "./review-safeguard-panel";
import { ReviewSectionList } from "./review-section-list";
import { type ReviewSectionId, sectionForField } from "./review-sections";
import { ReviewSourcePanel } from "./review-source-panel";
import "./unified-review.css";

export function UnifiedReviewWorkspace(): JSX.Element {
  const [searchParams] = useSearchParams();
  if (searchParams.get("mode") === "detailed") return <DocLensReviewWorkspace />;
  return <UnifiedReviewSummary />;
}

function UnifiedReviewSummary(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { batchId = "" } = useParams<{ batchId: string }>();
  const [searchParams] = useSearchParams();
  const returnTo = safeIntakeReturnTo(searchParams.get("returnTo"));
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [selectedSectionId, setSelectedSectionId] =
    useState<ReviewSectionId>("identity-demographics");
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [selectedSafeguardPage, setSelectedSafeguardPage] = useState<number | null>(null);
  const [nextCandidateId, setNextCandidateId] = useState<string | null>(null);
  const [sourceUnavailablePages, setSourceUnavailablePages] = useState<ReadonlySet<number>>(
    new Set(),
  );
  const taskFocusRef = useRef<HTMLElement | null>(null);
  const focusTask = useCallback((): void => {
    const task = taskFocusRef.current;
    if (!task) return;
    task.scrollTop = 0;
    task.focus({ preventScroll: true });
    const scrollport = task.closest<HTMLElement>(".wx-main");
    if (!scrollport) return;
    const taskBounds = task.getBoundingClientRect();
    const scrollportBounds = scrollport.getBoundingClientRect();
    const taskIsOutsideScrollport =
      taskBounds.top < scrollportBounds.top || taskBounds.top >= scrollportBounds.bottom;
    if (!taskIsOutsideScrollport) return;
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    task.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }, []);

  const refresh = useCallback(async (): Promise<Workspace | null> => {
    if (!batchId) return null;
    const response = await client
      .GET("/api/v1/intake/uploads/{id}/workspace", { params: { path: { id: batchId } } })
      .catch(() => null);
    if (!response || response.error || !response.data) {
      setLoadError(
        response?.response?.status === 404
          ? "This intake batch is not available to you."
          : "The unified review workspace could not be loaded.",
      );
      return null;
    }
    const data = response.data;
    setWorkspace(data);
    setLoadError(null);
    setRefreshRequired(false);
    setSelectedCandidateId((current) => {
      if (
        current &&
        data.candidates.some(
          (candidate) =>
            candidate.id === current &&
            !candidate.redacted &&
            !candidateIsOtherPatient(data, candidate),
        )
      )
        return current;
      return (
        data.candidates.find(
          (candidate) =>
            candidate.decision === null &&
            !candidate.redacted &&
            !candidateIsOtherPatient(data, candidate),
        )?.id ??
        data.candidates.find(
          (candidate) => !candidate.redacted && !candidateIsOtherPatient(data, candidate),
        )?.id ??
        null
      );
    });
    return data;
  }, [batchId, client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const candidate = workspace?.candidates.find((item) => item.id === selectedCandidateId);
    if (candidate) setSelectedSectionId(sectionForField(candidate.fieldPath));
  }, [selectedCandidateId, workspace]);

  const groups = useMemo(() => (workspace ? projectReviewGroups(workspace) : []), [workspace]);
  const exceptions = useMemo(
    () => (workspace ? projectReviewExceptions(workspace, groups, { sourceUnavailablePages }) : []),
    [workspace, groups, sourceUnavailablePages],
  );
  const exceptionSummary = useMemo(() => projectExceptionSummary(exceptions), [exceptions]);
  const projection = useMemo(
    () =>
      workspace ? projectUnifiedReview(workspace, exceptionCountsBySection(exceptions)) : null,
    [workspace, exceptions],
  );
  const selectedCandidate =
    workspace?.candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null;
  const nextCandidate =
    workspace?.candidates.find((candidate) => candidate.id === nextCandidateId) ?? null;

  const onAvailabilityChange = useCallback((page: number, unavailable: boolean): void => {
    setSourceUnavailablePages((current) => {
      const next = new Set(current);
      if (unavailable) next.add(page);
      else next.delete(page);
      return next;
    });
  }, []);

  const selectCandidate = useCallback(
    (candidateId: string): void => {
      const candidate = workspace?.candidates.find((item) => item.id === candidateId);
      if (!workspace || !candidate || candidateIsOtherPatient(workspace, candidate)) return;
      const group = groups.find((item) => item.candidateIds.includes(candidateId));
      if (group) setSelectedSectionId(group.sectionId);
      setSelectedSafeguardPage(null);
      setSelectedCandidateId(candidateId);
      setNextCandidateId(null);
      focusTask();
    },
    [focusTask, groups, workspace],
  );

  const selectException = (task: ReviewExceptionTask): void => {
    setSelectedSectionId(task.sectionId);
    if (task.candidateId && !task.reasons.some((reason) => reason.kind === "identity-unresolved")) {
      selectCandidate(task.candidateId);
      return;
    }
    setSelectedCandidateId(null);
    setSelectedSafeguardPage(task.page);
    setNextCandidateId(null);
    focusTask();
  };

  const onDecisionSaved = (latest: Workspace, candidateId: string): void => {
    const eligible = latest.candidates.filter(
      (candidate) =>
        candidate.decision === null &&
        !candidate.redacted &&
        !candidateIsOtherPatient(latest, candidate),
    );
    const currentIndex = latest.candidates.findIndex((candidate) => candidate.id === candidateId);
    const next =
      eligible.find(
        (candidate) =>
          latest.candidates.findIndex((item) => item.id === candidate.id) > currentIndex,
      ) ?? eligible[0];
    setNextCandidateId(next?.id ?? null);
  };

  if (loadError && !workspace) {
    return (
      <div className="wx-reports wx-unified-review">
        <div className="wx-list-state">
          <EmptyState title="Review unavailable" description={loadError} />
          <button type="button" className="wx-btn-secondary" onClick={() => void refresh()}>
            Retry
          </button>
          {returnTo ? (
            <Link to={returnTo} className="wx-btn-secondary">
              Back to referral intake
            </Link>
          ) : null}
        </div>
      </div>
    );
  }
  if (!workspace || !projection) {
    return (
      <div className="wx-reports wx-unified-review">
        <div className="wx-list-state">
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  const selectedSection = projection.sections.find((section) => section.id === selectedSectionId);
  const complete =
    workspace.review?.status === "complete" || workspace.batch.status === "writeback_complete";
  const reviewMine = workspace.review?.status === "in_progress" && workspace.review.isMine;
  const reviewIncomplete = projection.decidedCount < projection.candidateCount;
  const identityStatus = workspace.batch.identityStatus;
  const identityNotChecked = Boolean(
    (workspace.batch.patientId || workspace.batch.referralId) &&
      (identityStatus === null || identityStatus === "no_target"),
  );
  const identityCompletionBlocked =
    identityNotChecked ||
    identityStatus === "possible" ||
    identityStatus === "mismatch" ||
    workspace.documents.some(identityNeedsAnswer);
  const completionBlocked =
    reviewIncomplete || workspace.sud.status === "detected" || identityCompletionBlocked;
  const completionBlockedReason = reviewIncomplete
    ? `${projection.candidateCount - projection.decidedCount} observation(s) still need a decision.`
    : workspace.sud.status === "detected"
      ? "Resolve the Part 2 / SUD safeguard before completing the review."
      : identityCompletionBlocked
        ? "Resolve every patient identity safeguard before completing the review."
        : null;
  const completionWorkspace: Workspace = {
    ...workspace,
    candidates: workspace.candidates.filter(
      (candidate) => !candidateIsOtherPatient(workspace, candidate),
    ),
  };
  const reviewTone = complete
    ? "success"
    : exceptions.some((item) => item.priority === 0)
      ? "critical"
      : "warning";
  const detailQuery = new URLSearchParams({ mode: "detailed", from: "unified" });
  if (returnTo) detailQuery.set("returnTo", returnTo);

  return (
    <div className="wx-reports wx-unified-review">
      <header className="wx-page-head wx-unified-head">
        <div>
          <p className="wx-unified-eyebrow">WardenLens / Review workspace</p>
          <h1>Review patient information</h1>
          <p>
            {workspace.batch.patientName ?? "Unassigned intake"} · {workspace.documents.length}{" "}
            source document{workspace.documents.length === 1 ? "" : "s"} ·{" "}
            {sourceLabel(workspace.batch.sourceChannel)}
          </p>
        </div>
        <div className="wx-unified-head-actions">
          <StatusPill
            label={complete ? "Review complete" : batchStatusLabel(workspace.batch.status)}
            tone={reviewTone}
          />
          {!refreshRequired && workspace.review?.status !== "in_progress" && !complete ? (
            <button
              type="button"
              className="wx-btn-primary"
              disabled={starting}
              onClick={() => {
                setStarting(true);
                setActionError(null);
                void startReview(client, batchId).then(async (result) => {
                  setStarting(false);
                  if (!result.ok) setActionError(result.message);
                  else await refresh();
                });
              }}
            >
              {starting ? "Starting…" : "Start review"}
            </button>
          ) : null}
          {reviewMine ? (
            <>
              <button
                type="button"
                className="wx-btn-secondary"
                disabled={lifecycleBusy}
                onClick={async () => {
                  const review = workspace.review;
                  if (!review) return;
                  setLifecycleBusy(true);
                  setActionError(null);
                  try {
                    const result = await releaseReview(client, review.id);
                    if (!result.ok) {
                      setActionError(result.message);
                      return;
                    }
                    // Release succeeded authoritatively. Fail closed immediately so a failed
                    // follow-up read cannot leave stale owner-only actions enabled.
                    setRefreshRequired(true);
                    setWorkspace((current) => (current ? { ...current, review: null } : current));
                    const latest = await refresh();
                    if (!latest)
                      setActionError("Review released. Refresh the workspace before continuing.");
                  } catch {
                    setActionError("The review could not be released. Try again.");
                  } finally {
                    setLifecycleBusy(false);
                  }
                }}
              >
                Release review
              </button>
              <button
                type="button"
                className="wx-btn-primary"
                disabled={lifecycleBusy || completionBlocked}
                aria-describedby={completionBlockedReason ? "unified-completion-help" : undefined}
                onClick={() => setCompleteOpen(true)}
              >
                <Glyph name="file-check" size={16} /> Complete review
              </button>
              {completionBlockedReason ? (
                <span id="unified-completion-help" className="wx-unified-completion-help">
                  {completionBlockedReason}
                </span>
              ) : null}
            </>
          ) : null}
          {returnTo ? (
            <Link className="wx-btn-secondary" to={returnTo}>
              Back to referral intake
            </Link>
          ) : null}
          <Link
            className="wx-btn-secondary"
            to={`/intake/${encodeURIComponent(batchId)}/review?${detailQuery.toString()}`}
          >
            <Glyph name="eye" size={16} /> Legacy detailed reviewer
          </Link>
        </div>
      </header>

      {actionError ? (
        <div className="wx-unified-action-error">
          <p role="alert" className="wx-doclens-error">
            {actionError}
          </p>
          {refreshRequired ? (
            <button type="button" className="wx-btn-secondary" onClick={() => void refresh()}>
              Retry workspace refresh
            </button>
          ) : null}
        </div>
      ) : null}

      <section className="wx-unified-progress" aria-labelledby="unified-progress-title">
        <div>
          <strong id="unified-progress-title">Review progress</strong>
          <span>
            {projection.decidedCount} of {projection.candidateCount} observations decided ·{" "}
            {projection.reviewedSectionCount} of 6 sections reviewed
          </span>
        </div>
        <progress max={Math.max(1, projection.candidateCount)} value={projection.decidedCount}>
          {projection.candidateCount === 0
            ? "No extracted candidates"
            : `${projection.decidedCount} of ${projection.candidateCount}`}
        </progress>
        <small>Server safeguards and completion rules remain authoritative.</small>
      </section>

      {workspace.review?.status === "in_progress" && !workspace.review.isMine ? (
        <output className="wx-unified-banner">
          <Glyph name="lock" size={18} />
          <div>
            <strong>Read-only while another reviewer owns this review</strong>
            <span>Source evidence remains visible when authorized; decisions stay locked.</span>
          </div>
        </output>
      ) : null}

      <div className="wx-unified-layout">
        <section className="wx-unified-clinical" aria-label="Clinical information">
          <header>
            <div>
              <h2>Clinical information</h2>
              <p>Consolidated information from {workspace.documents.length} source documents.</p>
            </div>
          </header>
          <ReviewSectionList
            sections={projection.sections}
            selectedId={selectedSectionId}
            onSelect={(sectionId) => {
              setSelectedSectionId(sectionId);
              if (sectionId === "documents-safeguards") {
                setSelectedCandidateId(null);
                setSelectedSafeguardPage(null);
              }
            }}
          />
          {selectedSection ? (
            <section
              id={`unified-section-${selectedSection.id}`}
              className="wx-unified-section-detail"
              aria-labelledby={`unified-section-title-${selectedSection.id}`}
            >
              <header>
                <div>
                  <h2 id={`unified-section-title-${selectedSection.id}`}>
                    {selectedSection.title}
                  </h2>
                  <p>{selectedSection.description}</p>
                </div>
                <span>
                  {selectedSection.decidedCount} / {selectedSection.candidateCount} decided
                </span>
              </header>
              {selectedSection.groups.length === 0 ? (
                <div className="wx-unified-empty">
                  <Glyph name="info" size={18} /> No extracted observations are mapped to this
                  section.
                </div>
              ) : (
                selectedSection.groups.map((group) => (
                  <ReviewFieldGroup
                    key={group.id}
                    group={group}
                    onSelectSource={selectCandidate}
                    onReviewDecision={selectCandidate}
                  />
                ))
              )}
            </section>
          ) : null}
        </section>

        <section
          className="wx-unified-task-column"
          ref={taskFocusRef}
          tabIndex={-1}
          aria-label="Active review task"
        >
          {selectedCandidate ? (
            <ReviewSourcePanel
              key={selectedCandidate.id}
              batchId={batchId}
              workspace={workspace}
              candidate={selectedCandidate}
              returnTo={returnTo}
              onClose={() => setSelectedCandidateId(null)}
              onAvailabilityChange={onAvailabilityChange}
              refresh={refresh}
              onDecisionSaved={onDecisionSaved}
              nextCandidate={nextCandidate}
              onNext={() => nextCandidate && selectCandidate(nextCandidate.id)}
            />
          ) : selectedSectionId === "documents-safeguards" || selectedSafeguardPage !== null ? (
            <ReviewSafeguardPanel
              workspace={workspace}
              selectedPage={selectedSafeguardPage}
              refresh={refresh}
            />
          ) : (
            <section className="wx-unified-task-empty" aria-label="Review task">
              <Glyph name="info" size={28} />
              <h2>Select a review task</h2>
              <p>Choose an observation or exception to inspect its source and record a decision.</p>
            </section>
          )}
        </section>

        <ReviewExceptionPanel summary={exceptionSummary} onSelect={selectException} />
      </div>

      {completeOpen && workspace.review ? (
        <CompleteDialog
          ws={completionWorkspace}
          onClose={() => setCompleteOpen(false)}
          onComplete={() => completeReview(client, workspace.review?.id ?? "")}
          doneLabel={
            returnTo || workspace.batch.referralId
              ? "Return to referral intake"
              : "Back to intake review"
          }
          onDone={() =>
            navigate(
              returnTo ??
                (workspace.batch.referralId
                  ? `/referrals/${workspace.batch.referralId}/intake?step=verify`
                  : "/intake"),
            )
          }
        />
      ) : null}
    </div>
  );
}
