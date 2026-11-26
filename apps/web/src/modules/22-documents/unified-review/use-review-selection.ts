// The open task of the unified review: which candidate or safeguard block is open, the remembered task
// restored on the first load, and where focus goes when a task opens or closes. The rules themselves are
// the pure functions of `review-selection`; this hook owns the state, the storage and the focus.
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { recallLastReviewTask } from "../../../shell/last-review-task";
import type { PlatformSupportAccess, Workspace } from "../doclens-api";
import {
  type ReviewExceptionTask,
  type SafeguardFocus,
  candidateTaskId,
  exceptionTaskTarget,
  safeguardTaskId,
  targetTaskId,
} from "./review-exception-tasks";
import { candidateIsOtherPatient, candidateIsSelectable } from "./review-projection";
import type { ReviewSectionId } from "./review-sections";
import {
  INITIAL_REVIEW_SELECTION,
  type ReviewSelection,
  nextCandidateAfterSave,
  selectionAfterClosing,
  selectionAfterLoad,
  selectionAfterOpeningCandidate,
  selectionAfterOpeningSafeguard,
  selectionAfterSafeguardBlock,
  selectionAfterSection,
} from "./review-selection";
import { focusTaskColumn, focusTrigger, restoreFocusAfterClose } from "./review-task-focus";
import { rememberOpenedTask, restoreTaskTarget } from "./review-task-memory";

export interface ReviewSelectionControls {
  readonly selection: ReviewSelection;
  /** Goes on the task column; focus moves to the heading of the task just opened. */
  readonly taskColumnRef: RefObject<HTMLDivElement>;
  readonly applyLoadedSelection: (data: Workspace) => void;
  /** A stable handle; `trigger` is the button chosen, and closing the task returns focus to it. */
  readonly selectCandidate: (candidateId: string, trigger?: HTMLElement | null) => void;
  /** `trigger` is the row that was chosen; closing the task returns focus to it. */
  readonly selectException: (task: ReviewExceptionTask, trigger: HTMLElement | null) => void;
  readonly focusSafeguardBlock: (focus: SafeguardFocus, page: number) => void;
  readonly selectSection: (sectionId: ReviewSectionId) => void;
  readonly closeTask: () => void;
  readonly offerNextCandidate: (latest: Workspace, savedCandidateId: string) => void;
}

export function useReviewSelection({
  batchId,
  workspace,
  supportAccess,
  busy,
}: {
  readonly batchId: string;
  readonly workspace: Workspace | null;
  readonly supportAccess: PlatformSupportAccess | null;
  /** True while a decision is being saved: no task opens or closes until it has ended. */
  readonly busy: boolean;
}): ReviewSelectionControls {
  const [selection, setSelection] = useState<ReviewSelection>(INITIAL_REVIEW_SELECTION);
  const taskColumnRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const firstLoadDone = useRef(false);
  // A platform support session must leave nothing about the tenant's batch in the operator's browser.
  const isTenantReviewer = supportAccess === null;

  const remember = useCallback(
    (taskId: string | null): void => {
      if (isTenantReviewer) rememberOpenedTask(batchId, taskId);
    },
    [batchId, isTenantReviewer],
  );

  // After the commit, so the heading of the task just opened exists to take focus.
  useEffect(() => {
    if (selection.focusVersion > 0 && taskColumnRef.current) focusTaskColumn(taskColumnRef.current);
  }, [selection.focusVersion]);

  // Closing a task returns to the control that opened it: the row or button chosen, else whatever
  // held focus (a browser that does not focus a clicked button still names it through the event).
  const rememberTrigger = useCallback((trigger: HTMLElement | null): void => {
    triggerRef.current = trigger ?? focusTrigger(taskColumnRef.current) ?? triggerRef.current;
  }, []);

  // The remembered task is offered once per mount, on the first successful load; later refreshes keep
  // whatever the reviewer has open.
  const applyLoadedSelection = useCallback(
    (data: Workspace): void => {
      const first = !firstLoadDone.current;
      firstLoadDone.current = true;
      const saved = first && isTenantReviewer ? recallLastReviewTask(batchId) : null;
      const restored = saved ? restoreTaskTarget(saved, data) : null;
      setSelection((current) =>
        selectionAfterLoad(current, data, { first, restored, preferUndecided: isTenantReviewer }),
      );
    },
    [batchId, isTenantReviewer],
  );

  const openCandidate = useCallback(
    (candidateId: string, trigger: HTMLElement | null): void => {
      const candidate = workspace?.candidates.find((item) => item.id === candidateId);
      if (busy || !workspace || !candidate || candidateIsOtherPatient(workspace, candidate)) return;
      rememberTrigger(trigger);
      setSelection((current) => selectionAfterOpeningCandidate(current, candidate));
      // A withheld (Part 2) field is opened but never remembered, and it forgets the task it replaces.
      remember(candidateIsSelectable(workspace, candidate) ? candidateTaskId(candidateId) : null);
    },
    [busy, remember, rememberTrigger, workspace],
  );

  // A stable handle on the latest `openCandidate`: it changes with the workspace and with every save, and
  // the memoised field groups would re-render on each change if they were handed it directly.
  const latestOpenCandidate = useRef(openCandidate);
  useEffect(() => {
    latestOpenCandidate.current = openCandidate;
  });
  const selectCandidate = useCallback(
    (candidateId: string, trigger: HTMLElement | null = null): void =>
      latestOpenCandidate.current(candidateId, trigger),
    [],
  );

  // The task kind decides where a task leads; a candidate id it happens to carry never does.
  const selectException = useCallback(
    (task: ReviewExceptionTask, trigger: HTMLElement | null): void => {
      const target = exceptionTaskTarget(task);
      if (target.kind === "candidate") {
        openCandidate(target.candidateId, trigger);
        return;
      }
      if (busy) return;
      rememberTrigger(trigger);
      setSelection((current) =>
        selectionAfterOpeningSafeguard(current, task.sectionId, {
          page: target.page,
          focus: target.focus,
          taskId: task.id,
          reveal: true,
        }),
      );
      remember(targetTaskId(target));
    },
    [busy, openCandidate, remember, rememberTrigger],
  );

  // The reviewer chose a block's source inside the safeguard panel: the one selection follows, so the
  // marked block, the marked row and the remembered task never disagree.
  const focusSafeguardBlock = useCallback(
    (focus: SafeguardFocus, page: number): void => {
      if (busy) return;
      const taskId = safeguardTaskId(focus);
      setSelection((current) =>
        selectionAfterSafeguardBlock(current, { page, focus, taskId, reveal: false }),
      );
      remember(taskId);
    },
    [busy, remember],
  );

  const selectSection = useCallback(
    (sectionId: ReviewSectionId): void => {
      if (busy && sectionId === "documents-safeguards") return;
      setSelection((current) => selectionAfterSection(current, sectionId));
    },
    [busy],
  );

  const closeTask = useCallback((): void => {
    if (busy) return;
    remember(null);
    const trigger = triggerRef.current;
    triggerRef.current = null;
    setSelection(selectionAfterClosing);
    // Before the close button unmounts, so focus never falls to the page body.
    restoreFocusAfterClose(trigger, taskColumnRef.current);
  }, [busy, remember]);

  const offerNextCandidate = useCallback((latest: Workspace, savedCandidateId: string): void => {
    const nextCandidateId = nextCandidateAfterSave(latest, savedCandidateId);
    setSelection((current) => ({ ...current, nextCandidateId }));
  }, []);

  return {
    selection,
    taskColumnRef,
    applyLoadedSelection,
    selectCandidate,
    selectException,
    focusSafeguardBlock,
    selectSection,
    closeTask,
    offerNextCandidate,
  };
}
