import { EmptyState, Glyph, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { Workspace } from "../doclens-api";
import { batchStatusLabel, sourceLabel } from "../doclens-model";
import { DocLensReviewWorkspace } from "../doclens-review-workspace";
import { ReviewExceptionPanel } from "./review-exception-panel";
import {
  type ReviewExceptionProjection,
  exceptionCountsBySection,
  projectReviewExceptions,
} from "./review-exceptions";
import { ReviewFieldGroup } from "./review-field-group";
import { projectReviewGroups, projectUnifiedReview } from "./review-projection";
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
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedSectionId, setSelectedSectionId] =
    useState<ReviewSectionId>("identity-demographics");
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [sourceUnavailablePages, setSourceUnavailablePages] = useState<ReadonlySet<number>>(
    new Set(),
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!batchId) return;
    const response = await client
      .GET("/api/v1/intake/uploads/{id}/workspace", { params: { path: { id: batchId } } })
      .catch(() => null);
    if (!response || response.error || !response.data) {
      setLoadError(
        response?.response?.status === 404
          ? "This intake batch is not available to you."
          : "The unified review workspace could not be loaded.",
      );
      return;
    }
    setWorkspace(response.data);
    setLoadError(null);
  }, [batchId, client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const groups = useMemo(() => (workspace ? projectReviewGroups(workspace) : []), [workspace]);
  const exceptions = useMemo(
    () => (workspace ? projectReviewExceptions(workspace, groups, { sourceUnavailablePages }) : []),
    [workspace, groups, sourceUnavailablePages],
  );
  const projection = useMemo(
    () =>
      workspace ? projectUnifiedReview(workspace, exceptionCountsBySection(exceptions)) : null,
    [workspace, exceptions],
  );
  const selectedCandidate =
    workspace?.candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null;

  const onAvailabilityChange = useCallback((page: number, unavailable: boolean): void => {
    setSourceUnavailablePages((current) => {
      const next = new Set(current);
      if (unavailable) next.add(page);
      else next.delete(page);
      return next;
    });
  }, []);

  const selectException = (exception: ReviewExceptionProjection): void => {
    setSelectedSectionId(exception.sectionId);
    if (exception.candidateId) setSelectedCandidateId(exception.candidateId);
  };

  if (loadError && !workspace) {
    return (
      <div className="wx-reports wx-unified-review">
        <div className="wx-list-state">
          <EmptyState title="Review unavailable" description={loadError} />
          <button type="button" className="wx-btn-secondary" onClick={() => void refresh()}>
            Retry
          </button>
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

  return (
    <div className="wx-reports wx-unified-review">
      <header className="wx-page-head wx-unified-head">
        <div>
          <p className="wx-unified-eyebrow">WardenLens / Unified review</p>
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
          <Link
            className="wx-btn-secondary"
            to={`/intake/${encodeURIComponent(batchId)}/review?${detailQuery.toString()}`}
          >
            <Glyph name="eye" size={16} /> Detailed reviewer
          </Link>
        </div>
      </header>

      <section className="wx-unified-progress" aria-labelledby="unified-progress-title">
        <div>
          <strong id="unified-progress-title">Candidate decision progress</strong>
          <span>
            {projection.decidedCount} of {projection.candidateCount} observations decided ·{" "}
            {projection.reviewedSectionCount} of 6 sections have no projected exceptions
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
            <span>The unified summary remains available; candidate decisions stay locked.</span>
          </div>
        </output>
      ) : null}

      <div className="wx-unified-layout">
        <div className="wx-unified-main">
          <ReviewSectionList
            sections={projection.sections}
            selectedId={selectedSectionId}
            onSelect={setSelectedSectionId}
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
                  {selectedSection.decidedCount} / {selectedSection.candidateCount} observations
                  decided
                </span>
              </header>
              {selectedSection.groups.length === 0 ? (
                <div className="wx-unified-empty">
                  <Glyph name="info" size={18} />
                  No extracted observations are mapped to this section. Review source documents and
                  safeguards before completion.
                </div>
              ) : (
                selectedSection.groups.map((group) => (
                  <ReviewFieldGroup
                    key={group.id}
                    batchId={batchId}
                    group={group}
                    onSelectSource={setSelectedCandidateId}
                  />
                ))
              )}
            </section>
          ) : null}
          {selectedCandidate ? (
            <ReviewSourcePanel
              batchId={batchId}
              candidate={selectedCandidate}
              onClose={() => setSelectedCandidateId(null)}
              onAvailabilityChange={onAvailabilityChange}
            />
          ) : null}
        </div>
        <ReviewExceptionPanel exceptions={exceptions} onSelect={selectException} />
      </div>
    </div>
  );
}
