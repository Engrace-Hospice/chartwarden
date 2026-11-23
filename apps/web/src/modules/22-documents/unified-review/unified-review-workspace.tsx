import { EmptyState, Glyph, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { safeIntakeReturnTo } from "../../../shell/intake-return";
import type { Workspace } from "../doclens-api";
import { startReview } from "../doclens-api";
import { batchStatusLabel, sourceLabel } from "../doclens-model";
import { DocLensReviewWorkspace } from "../doclens-review-workspace";
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
import type { ReviewSectionId } from "./review-sections";
import { ReviewSourcePanel } from "./review-source-panel";
import "./unified-review.css";

export function UnifiedReviewWorkspace(): JSX.Element {
  const [searchParams] = useSearchParams();
  if (searchParams.get("mode") === "detailed") return <DocLensReviewWorkspace />;
  return <UnifiedReviewSummary />;
}

function UnifiedReviewSummary(): JSX.Element {
  const client = useApiClient();
  const { batchId = "" } = useParams<{ batchId: string }>();
  const [searchParams] = useSearchParams();
  const returnTo = safeIntakeReturnTo(searchParams.get("returnTo"));
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [selectedSectionId, setSelectedSectionId] =
    useState<ReviewSectionId>("identity-demographics");
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [selectedSafeguardPage, setSelectedSafeguardPage] = useState<number | null>(null);
  const [nextCandidateId, setNextCandidateId] = useState<string | null>(null);
  const [sourceUnavailablePages, setSourceUnavailablePages] = useState<ReadonlySet<number>>(
    new Set(),
  );
  const taskFocusRef = useRef<HTMLDivElement | null>(null);

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
    if (selectedCandidateId || selectedSafeguardPage !== null) taskFocusRef.current?.focus();
  }, [selectedCandidateId, selectedSafeguardPage]);

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
      taskFocusRef.current?.focus();
    },
    [groups, workspace],
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
    taskFocusRef.current?.focus();
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
          {!workspace.review && !complete ? (
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
          {returnTo ? (
            <Link className="wx-btn-secondary" to={returnTo}>
              Back to referral intake
            </Link>
          ) : null}
          <Link
            className="wx-btn-secondary"
            to={`/intake/${encodeURIComponent(batchId)}/review?${detailQuery.toString()}`}
          >
            <Glyph name="eye" size={16} /> Detailed reviewer
          </Link>
        </div>
      </header>

      {actionError ? (
        <p role="alert" className="wx-doclens-error">
          {actionError}
        </p>
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
    </div>
  );
}
