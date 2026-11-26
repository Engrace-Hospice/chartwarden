import {
  EmptyState,
  LoadingSpinner,
  type StatusTone,
  useApiClient,
  useRequestGuard,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { safeIntakeReturnTo } from "../../../shell/intake-return";
import type { PlatformSupportAccess, Workspace } from "../doclens-api";
import { completeReview } from "../doclens-api";
import { CompleteDialog, DocLensReviewWorkspace } from "../doclens-review-workspace";
import { ReviewClinicalColumn } from "./review-clinical-column";
import { completionWorkspace, reviewGate } from "./review-completion-gate";
import { ReviewExceptionPanel } from "./review-exception-panel";
import { openTaskIds, projectExceptionSummary } from "./review-exception-tasks";
import { exceptionCountsBySection, projectReviewExceptions } from "./review-exceptions";
import {
  ReviewActionError,
  ReviewBanners,
  ReviewHeaderActions,
  ReviewProgress,
  ReviewTaskEmpty,
  ReviewTitle,
} from "./review-page-chrome";
import { projectReviewGroups, projectUnifiedReview } from "./review-projection";
import { ReviewSafeguardPanel } from "./review-safeguard-panel";
import { ReviewSourcePanel } from "./review-source-panel";
import { loadWorkspace, useSupportRevalidation } from "./review-workspace-load";
import type { SourceZoom } from "./source-viewer";
import { useReviewSelection } from "./use-review-selection";
import "./unified-review.css";
import "./unified-review-exceptions.css";

const INCOMPLETE_SUPPORT_LINK =
  "This support-session link is incomplete. Return to platform administration.";

export function UnifiedReviewWorkspace(): JSX.Element {
  const { batchId = "" } = useParams<{ batchId: string }>();
  const [searchParams] = useSearchParams();
  const supportSessionId = searchParams.get("supportSessionId");
  const supportOrganizationId = searchParams.get("supportOrganizationId");
  if (searchParams.get("mode") === "detailed" && !supportSessionId && !supportOrganizationId)
    return <DocLensReviewWorkspace />;
  // Keyed by batch as well as by support context: a new `:batchId` on the same route must not keep the
  // previous batch's selection, source-page state or open decision under the new batch's data.
  return (
    <UnifiedReviewSummary
      key={`${batchId}:${supportOrganizationId ?? "tenant"}:${supportSessionId ?? "tenant"}`}
    />
  );
}

function UnifiedReviewSummary(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const guard = useRequestGuard();
  const { batchId = "" } = useParams<{ batchId: string }>();
  const [searchParams] = useSearchParams();
  const returnTo = safeIntakeReturnTo(searchParams.get("returnTo"));
  const supportSessionId = searchParams.get("supportSessionId");
  const supportOrganizationId = searchParams.get("supportOrganizationId");
  const supportAccess = useMemo<PlatformSupportAccess | null>(() => {
    if (!supportSessionId || !supportOrganizationId) return null;
    return { organizationId: supportOrganizationId, supportSessionId };
  }, [supportOrganizationId, supportSessionId]);
  const incompleteSupportContext = Boolean(supportSessionId) !== Boolean(supportOrganizationId);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  // True while a decision is being saved: no task opens or closes until it has ended.
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState<SourceZoom>("fit");
  const [sourceUnavailablePages, setSourceUnavailablePages] = useState<ReadonlySet<number>>(
    new Set(),
  );
  const controls = useReviewSelection({ batchId, workspace, supportAccess, busy });
  const { selection, applyLoadedSelection } = controls;

  const clearSupportWorkspace = useCallback((): void => {
    setWorkspace(null);
    setCompleteOpen(false);
    setBusy(false);
    setSourceUnavailablePages(new Set());
  }, []);

  const refresh = useCallback(async (): Promise<Workspace | null> => {
    if (!batchId) return null;
    const isCurrent = guard();
    if (incompleteSupportContext) {
      clearSupportWorkspace();
      setLoadError(INCOMPLETE_SUPPORT_LINK);
      return null;
    }
    // Support authorization is evaluated on every read. Remove previously disclosed PHI before
    // revalidation so an expired or revoked session fails closed instead of leaving stale data.
    if (supportAccess) clearSupportWorkspace();
    const result = await loadWorkspace(client, batchId, supportAccess);
    if (!isCurrent()) return null;
    if (!result.ok) {
      if (supportAccess) clearSupportWorkspace();
      setLoadError(result.message);
      return null;
    }
    setWorkspace(result.data);
    setLoadError(null);
    setRefreshRequired(false);
    applyLoadedSelection(result.data);
    return result.data;
  }, [
    applyLoadedSelection,
    batchId,
    clearSupportWorkspace,
    client,
    guard,
    incompleteSupportContext,
    supportAccess,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useSupportRevalidation(supportAccess, refresh);

  const markReleased = useCallback((): void => {
    // Release succeeded authoritatively. Fail closed immediately so a failed follow-up read cannot
    // leave stale owner-only actions enabled.
    setRefreshRequired(true);
    setWorkspace((current) => (current ? { ...current, review: null } : current));
  }, []);

  const onAvailabilityChange = useCallback((page: number, unavailable: boolean): void => {
    setSourceUnavailablePages((current) => {
      // Every image that loads reports in: an unchanged answer must not rebuild the projections.
      if (current.has(page) === unavailable) return current;
      const next = new Set(current);
      if (unavailable) next.add(page);
      else next.delete(page);
      return next;
    });
  }, []);

  const groups = useMemo(() => (workspace ? projectReviewGroups(workspace) : []), [workspace]);
  const exceptions = useMemo(
    () => (workspace ? projectReviewExceptions(workspace, groups, { sourceUnavailablePages }) : []),
    [workspace, groups, sourceUnavailablePages],
  );
  const exceptionSummary = useMemo(() => projectExceptionSummary(exceptions), [exceptions]);
  const projection = useMemo(
    () =>
      workspace
        ? projectUnifiedReview(workspace, exceptionCountsBySection(exceptions), groups)
        : null,
    [workspace, exceptions, groups],
  );
  const openTasks = useMemo(
    () =>
      openTaskIds(exceptionSummary, groups, {
        candidateId: selection.candidateId,
        safeguardTaskId: selection.safeguard?.taskId ?? null,
      }),
    [exceptionSummary, groups, selection.candidateId, selection.safeguard],
  );

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

  const selectedCandidate =
    workspace.candidates.find((candidate) => candidate.id === selection.candidateId) ?? null;
  const nextCandidate =
    workspace.candidates.find((candidate) => candidate.id === selection.nextCandidateId) ?? null;
  const gate = reviewGate(workspace, projection);
  const tone: StatusTone = gate.complete
    ? "success"
    : exceptions.some((item) => item.priority === 0)
      ? "critical"
      : "warning";
  const showSafeguards =
    selection.sectionId === "documents-safeguards" || selection.safeguard !== null;

  return (
    <div className="wx-reports wx-unified-review">
      <header className="wx-page-head wx-unified-head">
        <ReviewTitle workspace={workspace} />
        <ReviewHeaderActions
          batchId={batchId}
          workspace={workspace}
          gate={gate}
          tone={tone}
          supportAccess={supportAccess}
          refreshRequired={refreshRequired}
          returnTo={returnTo}
          refresh={refresh}
          busy={busy}
          onActionError={setActionError}
          onReleased={markReleased}
          onCompleteOpen={() => setCompleteOpen(true)}
        />
      </header>

      {actionError ? (
        <ReviewActionError
          message={actionError}
          onRetryRefresh={refreshRequired ? () => void refresh() : null}
        />
      ) : null}

      <ReviewProgress
        decidedCount={projection.decidedCount}
        candidateCount={projection.candidateCount}
        reviewedSectionCount={projection.reviewedSectionCount}
      />
      <ReviewBanners workspace={workspace} supportAccess={supportAccess} />

      <div className="wx-unified-layout">
        <ReviewClinicalColumn
          workspace={workspace}
          projection={projection}
          selectedSectionId={selection.sectionId}
          onSelectSection={controls.selectSection}
          onReview={controls.selectCandidate}
          busy={busy}
        />

        <div className="wx-unified-task-column" ref={controls.taskColumnRef} tabIndex={-1}>
          {selectedCandidate ? (
            <ReviewSourcePanel
              key={selectedCandidate.id}
              batchId={batchId}
              workspace={workspace}
              candidate={selectedCandidate}
              returnTo={returnTo}
              onClose={controls.closeTask}
              onAvailabilityChange={onAvailabilityChange}
              refresh={refresh}
              onDecisionSaved={controls.offerNextCandidate}
              nextCandidate={nextCandidate}
              onNext={() => nextCandidate && controls.selectCandidate(nextCandidate.id)}
              supportAccess={supportAccess}
              onBusyChange={setBusy}
              zoom={zoom}
              onZoomChange={setZoom}
            />
          ) : showSafeguards ? (
            <ReviewSafeguardPanel
              workspace={workspace}
              selection={selection.safeguard}
              onFocusBlock={controls.focusSafeguardBlock}
              refresh={refresh}
              supportAccess={supportAccess}
              onBusyChange={setBusy}
              zoom={zoom}
              onZoomChange={setZoom}
            />
          ) : (
            <ReviewTaskEmpty />
          )}
        </div>

        <ReviewExceptionPanel
          summary={exceptionSummary}
          selectedTaskIds={openTasks}
          revealVersion={selection.revealVersion}
          disabled={busy}
          onSelect={controls.selectException}
        />
      </div>

      {!supportAccess && completeOpen && workspace.review ? (
        <CompleteDialog
          ws={completionWorkspace(workspace)}
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
