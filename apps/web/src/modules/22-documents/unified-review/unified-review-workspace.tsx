import { EmptyState, Glyph, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { safeIntakeReturnTo } from "../../../shell/intake-return";
import { recallLastReviewTask } from "../../../shell/last-review-task";
import type { PlatformSupportAccess, Workspace } from "../doclens-api";
import { completeReview, releaseReview, startReview } from "../doclens-api";
import { batchStatusLabel, identityNeedsAnswer, sourceLabel } from "../doclens-model";
import { CompleteDialog, DocLensReviewWorkspace } from "../doclens-review-workspace";
import { ReviewExceptionPanel } from "./review-exception-panel";
import {
  type ReviewExceptionTask,
  type ReviewTaskTarget,
  type SafeguardFocus,
  type SafeguardSelection,
  candidateTaskId,
  exceptionTaskTarget,
  openTaskIds,
  projectExceptionSummary,
  safeguardTaskId,
  targetTaskId,
} from "./review-exception-tasks";
import { exceptionCountsBySection, projectReviewExceptions } from "./review-exceptions";
import { ReviewFieldGroup } from "./review-field-group";
import { rememberOpenedTask, restoreTaskTarget } from "./review-last-task";
import {
  candidateIsOtherPatient,
  candidateIsSelectable,
  projectReviewGroups,
  projectUnifiedReview,
} from "./review-projection";
import { ReviewSafeguardPanel } from "./review-safeguard-panel";
import { ReviewSectionList } from "./review-section-list";
import { type ReviewSectionId, sectionForField } from "./review-sections";
import { ReviewSourcePanel } from "./review-source-panel";
import "./unified-review.css";
import "./unified-review-exceptions.css";

/** Keeps the open candidate while it is still selectable, else the first one worth opening. */
function nextSelectedCandidateId(
  data: Workspace,
  current: string | null,
  preferUndecided: boolean,
): string | null {
  const selectable = data.candidates.filter((candidate) => candidateIsSelectable(data, candidate));
  if (current && selectable.some((candidate) => candidate.id === current)) return current;
  const undecided = preferUndecided
    ? selectable.find((candidate) => candidate.decision === null)
    : undefined;
  return (undecided ?? selectable[0])?.id ?? null;
}

export function UnifiedReviewWorkspace(): JSX.Element {
  const [searchParams] = useSearchParams();
  const supportSessionId = searchParams.get("supportSessionId");
  const supportOrganizationId = searchParams.get("supportOrganizationId");
  if (searchParams.get("mode") === "detailed" && !supportSessionId && !supportOrganizationId)
    return <DocLensReviewWorkspace />;
  return (
    <UnifiedReviewSummary
      key={`${supportOrganizationId ?? "tenant"}:${supportSessionId ?? "tenant"}`}
    />
  );
}

function UnifiedReviewSummary(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { batchId = "" } = useParams<{ batchId: string }>();
  const [searchParams] = useSearchParams();
  const returnTo = safeIntakeReturnTo(searchParams.get("returnTo"));
  const supportSessionId = searchParams.get("supportSessionId");
  const supportOrganizationId = searchParams.get("supportOrganizationId");
  const supportAccess = useMemo<PlatformSupportAccess | null>(() => {
    if (!supportSessionId || !supportOrganizationId) return null;
    return {
      organizationId: supportOrganizationId,
      supportSessionId,
    };
  }, [supportOrganizationId, supportSessionId]);
  const incompleteSupportContext = Boolean(supportSessionId) !== Boolean(supportOrganizationId);
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
  const [safeguardSelection, setSafeguardSelection] = useState<SafeguardSelection | null>(null);
  // True while the open task is the one restored on load: its priorities row is made visible, once, since
  // the reviewer did not just click it. Any choice they make afterwards leaves the categories as they are.
  const [restoredSelection, setRestoredSelection] = useState(false);
  const [nextCandidateId, setNextCandidateId] = useState<string | null>(null);
  const [sourceUnavailablePages, setSourceUnavailablePages] = useState<ReadonlySet<number>>(
    new Set(),
  );
  const taskFocusRef = useRef<HTMLElement | null>(null);
  const refreshGenerationRef = useRef(0);
  const restoredBatchRef = useRef<string | null>(null);
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

  const clearSupportWorkspace = useCallback((): void => {
    setWorkspace(null);
    setCompleteOpen(false);
    setSafeguardSelection(null);
    setNextCandidateId(null);
    setSourceUnavailablePages(new Set());
  }, []);

  // The task remembered for this batch is offered once per batch per mount, on its first load; later
  // refreshes keep whatever the reviewer has open.
  const takeRestoredTarget = useCallback(
    (data: Workspace): ReviewTaskTarget | null => {
      if (restoredBatchRef.current === batchId) return null;
      restoredBatchRef.current = batchId;
      const saved = recallLastReviewTask(batchId);
      return saved ? restoreTaskTarget(saved, data) : null;
    },
    [batchId],
  );

  // A restored candidate is chosen by the candidate selector; a restored safeguard block opens the
  // safeguard panel instead and leaves no candidate selected.
  const applyLoadedSelection = useCallback(
    (data: Workspace, preferUndecided: boolean): void => {
      const restored = takeRestoredTarget(data);
      if (restored) setRestoredSelection(true);
      if (restored?.kind === "safeguard") {
        setSelectedCandidateId(null);
        setSelectedSectionId("documents-safeguards");
        // Marked, but not scrolled to or focused: nobody asked for it on this load.
        setSafeguardSelection({
          page: restored.page,
          focus: restored.focus,
          taskId: targetTaskId(restored),
          reveal: false,
        });
        return;
      }
      setSelectedCandidateId((current) =>
        restored ? restored.candidateId : nextSelectedCandidateId(data, current, preferUndecided),
      );
    },
    [takeRestoredTarget],
  );

  const refresh = useCallback(async (): Promise<Workspace | null> => {
    if (!batchId) return null;
    const generation = ++refreshGenerationRef.current;
    if (incompleteSupportContext) {
      clearSupportWorkspace();
      setLoadError("This support-session link is incomplete. Return to platform administration.");
      return null;
    }
    if (supportAccess) {
      // Support authorization is evaluated on every read. Remove previously disclosed PHI before
      // revalidation so an expired or revoked session fails closed instead of leaving stale data.
      clearSupportWorkspace();
      const response = await client
        .GET("/api/v1/platform/organizations/{organizationId}/intake/uploads/{id}/workspace", {
          params: {
            path: { organizationId: supportAccess.organizationId, id: batchId },
            query: { supportSessionId: supportAccess.supportSessionId },
          },
        })
        .catch(() => null);
      if (generation !== refreshGenerationRef.current) return null;
      if (!response || response.error || !response.data) {
        clearSupportWorkspace();
        setLoadError(
          response?.response?.status === 403
            ? "This support session does not authorize access to the requested intake batch."
            : response?.response?.status === 404
              ? "This intake batch is not available in the support-session tenant."
              : "The support-session review workspace could not be loaded.",
        );
        return null;
      }
      const data = response.data;
      setWorkspace(data);
      setLoadError(null);
      setRefreshRequired(false);
      applyLoadedSelection(data, false);
      return data;
    }
    const response = await client
      .GET("/api/v1/intake/uploads/{id}/workspace", { params: { path: { id: batchId } } })
      .catch(() => null);
    if (generation !== refreshGenerationRef.current) return null;
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
    applyLoadedSelection(data, true);
    return data;
  }, [
    applyLoadedSelection,
    batchId,
    clearSupportWorkspace,
    client,
    incompleteSupportContext,
    supportAccess,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!supportAccess) return;
    const revalidate = (): void => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [refresh, supportAccess]);

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
  const openTasks = useMemo(
    () =>
      openTaskIds(exceptionSummary, groups, {
        candidateId: selectedCandidateId,
        safeguardTaskId: safeguardSelection?.taskId ?? null,
      }),
    [exceptionSummary, groups, selectedCandidateId, safeguardSelection],
  );

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
      setSafeguardSelection(null);
      setSelectedCandidateId(candidateId);
      setNextCandidateId(null);
      setRestoredSelection(false);
      // A withheld candidate is never offered again on reload, so it must not replace a restorable task.
      rememberOpenedTask(
        batchId,
        candidateIsSelectable(workspace, candidate) ? candidateTaskId(candidateId) : null,
      );
      focusTask();
    },
    [batchId, focusTask, groups, workspace],
  );

  // The task kind decides where a task leads; a candidate id it happens to carry never does.
  const selectException = (task: ReviewExceptionTask): void => {
    setSelectedSectionId(task.sectionId);
    const target = exceptionTaskTarget(task);
    if (target.kind === "candidate") {
      selectCandidate(target.candidateId);
      return;
    }
    setSelectedCandidateId(null);
    // A fresh object even for the same block, so choosing it again scrolls and focuses it again.
    setSafeguardSelection({
      page: target.page,
      focus: target.focus,
      taskId: task.id,
      reveal: true,
    });
    setNextCandidateId(null);
    setRestoredSelection(false);
    rememberOpenedTask(batchId, targetTaskId(target));
    focusTask();
  };

  // The reviewer chose a block's source inside the safeguard panel: the one selection follows, so the
  // marked block, the marked row and the remembered task never disagree.
  const focusSafeguardBlock = (focus: SafeguardFocus, page: number): void => {
    const taskId = safeguardTaskId(focus);
    setSafeguardSelection({ page, focus, taskId, reveal: false });
    setRestoredSelection(false);
    rememberOpenedTask(batchId, taskId);
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
          {supportAccess ? <StatusPill label="Read-only support session" tone="warning" /> : null}
          {!supportAccess &&
          !refreshRequired &&
          workspace.review?.status !== "in_progress" &&
          !complete ? (
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
          {!supportAccess && reviewMine ? (
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
          {!supportAccess ? (
            <Link
              className="wx-btn-secondary"
              to={`/intake/${encodeURIComponent(batchId)}/review?${detailQuery.toString()}`}
            >
              <Glyph name="eye" size={16} /> Legacy detailed reviewer
            </Link>
          ) : null}
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
      {supportAccess ? (
        <output className="wx-unified-banner">
          <Glyph name="shield" size={18} />
          <div>
            <strong>Tenant-consented platform support access</strong>
            <span>
              Source evidence is available for this active support session. Review ownership,
              decisions, safeguard resolution, completion, and release remain tenant-controlled.
            </span>
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
                setSafeguardSelection(null);
                rememberOpenedTask(batchId, null);
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
              onClose={() => {
                setSelectedCandidateId(null);
                setSafeguardSelection(null);
                rememberOpenedTask(batchId, null);
              }}
              onAvailabilityChange={onAvailabilityChange}
              refresh={refresh}
              onDecisionSaved={onDecisionSaved}
              nextCandidate={nextCandidate}
              onNext={() => nextCandidate && selectCandidate(nextCandidate.id)}
              supportAccess={supportAccess}
            />
          ) : selectedSectionId === "documents-safeguards" || safeguardSelection !== null ? (
            <ReviewSafeguardPanel
              workspace={workspace}
              selection={safeguardSelection}
              onFocusBlock={focusSafeguardBlock}
              refresh={refresh}
              supportAccess={supportAccess}
            />
          ) : (
            <section className="wx-unified-task-empty" aria-label="Review task">
              <Glyph name="info" size={28} />
              <h2>Select a review task</h2>
              <p>Choose an observation or exception to inspect its source and record a decision.</p>
            </section>
          )}
        </section>

        <ReviewExceptionPanel
          summary={exceptionSummary}
          selectedTaskIds={openTasks}
          expandSelected={restoredSelection}
          onSelect={selectException}
        />
      </div>

      {!supportAccess && completeOpen && workspace.review ? (
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
