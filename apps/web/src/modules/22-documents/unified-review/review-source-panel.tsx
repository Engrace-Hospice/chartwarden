import { Glyph } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { Candidate, PlatformSupportAccess, Workspace } from "../doclens-api";
import { fieldLabel } from "../doclens-model";
import { DecisionForms } from "./review-decision-forms";
import {
  DecisionStatus,
  PanelFooter,
  ReadOnlyNotice,
  TaskHeader,
  reviewComplete,
  unlockHint,
} from "./review-source-panel-parts";
import { SourceViewer } from "./source-viewer";
import type { SourceZoom } from "./source-viewer";
import { useDecisionSave } from "./use-decision-save";
import { useSourceImage } from "./use-source-image";
import "./unified-review-panels.css";

/**
 * The field-task panel: the source page with this observation highlighted, and the decision controls.
 * The workspace keys it by candidate id, so a new task starts with fresh local state.
 */
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
  onBusyChange,
  zoom,
  onZoomChange,
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
  /** True while a decision save is in flight, so the workspace does not switch task under it. */
  onBusyChange: (busy: boolean) => void;
  zoom: SourceZoom;
  onZoomChange: (zoom: SourceZoom) => void;
}): JSX.Element {
  const source = useSourceImage({
    batchId,
    page: candidate.page,
    access: supportAccess,
    withheld: candidate.redacted,
    resetKey: candidate.id,
    onAvailabilityChange,
  });
  const [sourceConfirmed, setSourceConfirmed] = useState(false);
  const [changing, setChanging] = useState(false);
  // Remounts the decision controls so nothing the reviewer typed carries into the next decision.
  const [formsEpoch, setFormsEpoch] = useState(0);
  const panelRef = useRef<HTMLElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLOutputElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const focusAfterChange = useRef(false);

  const { review } = workspace;
  const canOwnDecision = review?.status === "in_progress" && review.isMine;
  const complete = reviewComplete(workspace);
  const page = workspace.pages.find((item) => item.page === candidate.page) ?? null;
  // A saved decision stays final until the reviewer explicitly chooses to change it.
  const locked = candidate.decision !== null && !changing;
  const decisionsAvailable = Boolean(
    canOwnDecision && !complete && !candidate.redacted && !supportAccess,
  );
  const sourceReady = source.state === "ready";
  const saving = useDecisionSave({
    reviewId: review?.id ?? null,
    candidate,
    canSubmit: decisionsAvailable && !locked && sourceReady && sourceConfirmed,
    refresh,
    onRecorded: () => {
      setSourceConfirmed(false);
      setChanging(false);
      setFormsEpoch((epoch) => epoch + 1);
    },
    onSaved: (latest) => onDecisionSaved(latest, candidate.id),
    onBusyChange,
    focusFallback: () => nextRef.current ?? statusRef.current,
  });
  const canSubmit =
    decisionsAvailable && !saving.refreshPending && !locked && sourceReady && sourceConfirmed;
  const hint = unlockHint({
    locked,
    refreshPending: saving.refreshPending,
    sourceReady,
    sourceConfirmed,
  });
  const hintId = `unified-decision-hint-${candidate.id}`;

  // The comparison only counts while the page it was made against is showing.
  useEffect(() => {
    if (!sourceReady) setSourceConfirmed(false);
  }, [sourceReady]);

  // Choosing "Change decision" unmounts the focused button; hand focus to the next step instead.
  useEffect(() => {
    if (!changing || !focusAfterChange.current) return;
    focusAfterChange.current = false;
    const target = confirmationRef.current;
    (target && !target.disabled ? target : panelRef.current)?.focus();
  }, [changing]);

  const startChange = (): void => {
    focusAfterChange.current = true;
    setFormsEpoch((epoch) => epoch + 1);
    setChanging(true);
  };

  return (
    <section ref={panelRef} className="wx-unified-source" aria-label="Review task" tabIndex={-1}>
      <TaskHeader candidate={candidate} onClose={onClose} busy={saving.busy} />

      <SourceViewer
        source={source}
        alt={`Page ${candidate.page} of the source document for ${fieldLabel(candidate.fieldPath)}`}
        page={page}
        highlights={[{ key: candidate.id, bbox: candidate.bbox }]}
        zoom={zoom}
        onZoomChange={onZoomChange}
        loadedLabel="Source loaded"
        unavailableDetail="This observation cannot be source-confirmed from this preview."
      />

      <div className="wx-unified-decision">
        <DecisionStatus saving={saving} statusRef={statusRef} />
        {decisionsAvailable ? (
          <>
            <label className="wx-doclens-check">
              <input
                ref={confirmationRef}
                type="checkbox"
                checked={sourceConfirmed}
                aria-describedby={hint ? hintId : undefined}
                disabled={!sourceReady || saving.busy || locked}
                onChange={(event) => setSourceConfirmed(event.target.checked)}
              />
              I compared this with the source
            </label>
            <DecisionForms
              key={formsEpoch}
              candidate={candidate}
              canSubmit={canSubmit}
              busy={saving.busy}
              locked={locked}
              hintId={hint ? hintId : undefined}
              onSave={(kind, extra) => void saving.save(kind, extra)}
            />
            {hint ? (
              <p id={hintId} className="wx-row-sub">
                {hint}
              </p>
            ) : null}
            {locked ? (
              <button
                type="button"
                className="wx-btn-secondary wx-unified-change"
                disabled={saving.busy || saving.refreshPending}
                onClick={startChange}
              >
                Change decision
              </button>
            ) : null}
            {candidate.riskLevel === "high" ? (
              <p className="wx-row-sub">
                High-risk field: the server requires an eligible RN, NP, PA, or physician reviewer.
              </p>
            ) : null}
          </>
        ) : (
          <ReadOnlyNotice
            candidate={candidate}
            workspace={workspace}
            supportAccess={supportAccess}
          />
        )}
        {saving.status?.tone === "success" && nextCandidate ? (
          <button
            ref={nextRef}
            type="button"
            className="wx-btn-primary wx-unified-next"
            onClick={onNext}
          >
            Next issue: {fieldLabel(nextCandidate.fieldPath)} <Glyph name="arrow-right" size={16} />
          </button>
        ) : null}
      </div>

      <PanelFooter
        batchId={batchId}
        candidate={candidate}
        returnTo={returnTo}
        decisionsAvailable={decisionsAvailable}
        supportAccess={supportAccess}
      />
    </section>
  );
}
