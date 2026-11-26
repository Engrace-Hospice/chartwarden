// Which task of the unified review is open, as one immutable value, and every way it changes. The hook
// `useReviewSelection` holds the value; these functions are pure so the rules are testable on their own.
import type { Candidate, Workspace } from "../doclens-api";
import {
  type ReviewTaskTarget,
  type SafeguardSelection,
  targetTaskId,
} from "./review-exception-tasks";
import { candidateIsOtherPatient, candidateIsSelectable } from "./review-projection";
import { type ReviewSectionId, sectionForField } from "./review-sections";

export interface ReviewSelection {
  readonly sectionId: ReviewSectionId;
  /** The field task open in the task column, or null (a safeguard task, the safeguards section, or none). */
  readonly candidateId: string | null;
  /** The safeguard task open in the task column; its block and its priorities row are marked. */
  readonly safeguard: SafeguardSelection | null;
  /** The candidate "Next issue" leads to after a saved decision. */
  readonly nextCandidateId: string | null;
  /** Counts the times a task was chosen or restored: the priorities list shows the row of the open task. */
  readonly revealVersion: number;
  /** Counts the times a person chose a task: focus moves to it. A restore or a default never does. */
  readonly focusVersion: number;
}

export const INITIAL_REVIEW_SELECTION: ReviewSelection = {
  sectionId: "identity-demographics",
  candidateId: null,
  safeguard: null,
  nextCandidateId: null,
  revealVersion: 0,
  focusVersion: 0,
};

export interface LoadedSelectionInput {
  /** True for the first successful load of this batch in this mount; only then is a default task chosen. */
  readonly first: boolean;
  /** The task remembered for this batch, resolved against the workspace, on the first load only. */
  readonly restored: ReviewTaskTarget | null;
  /** A reviewer starts at the first undecided candidate; a read-only support session at the first one. */
  readonly preferUndecided: boolean;
}

/** The first candidate worth opening: the first undecided one when asked, else the first selectable. */
export function defaultCandidateId(data: Workspace, preferUndecided: boolean): string | null {
  const selectable = data.candidates.filter((candidate) => candidateIsSelectable(data, candidate));
  const undecided = preferUndecided
    ? selectable.find((candidate) => candidate.decision === null)
    : undefined;
  return (undecided ?? selectable[0])?.id ?? null;
}

function withDefaultCandidate(
  current: ReviewSelection,
  data: Workspace,
  preferUndecided: boolean,
): ReviewSelection {
  const candidateId = defaultCandidateId(data, preferUndecided);
  const candidate = data.candidates.find((item) => item.id === candidateId);
  return {
    ...current,
    candidateId,
    sectionId: candidate ? sectionForField(candidate.fieldPath) : current.sectionId,
  };
}

function withRestoredTarget(
  current: ReviewSelection,
  data: Workspace,
  restored: ReviewTaskTarget,
): ReviewSelection {
  const revealVersion = current.revealVersion + 1;
  if (restored.kind === "safeguard")
    return {
      ...current,
      sectionId: "documents-safeguards",
      candidateId: null,
      // Marked, but not scrolled to or focused: nobody asked for it on this load.
      safeguard: {
        page: restored.page,
        focus: restored.focus,
        taskId: targetTaskId(restored),
        reveal: false,
      },
      revealVersion,
    };
  const candidate = data.candidates.find((item) => item.id === restored.candidateId);
  return {
    ...current,
    sectionId: candidate ? sectionForField(candidate.fieldPath) : current.sectionId,
    candidateId: restored.candidateId,
    safeguard: null,
    revealVersion,
  };
}

/**
 * The open candidate survives a load while it is in the workspace and is not another patient's. A withheld
 * (Part 2) field the reviewer opened on purpose stays open too: its panel shows the notice, never the value.
 */
function openCandidateStillOpen(current: ReviewSelection, data: Workspace): boolean {
  const open = data.candidates.find((candidate) => candidate.id === current.candidateId);
  return open !== undefined && !candidateIsOtherPatient(data, open);
}

/**
 * What a (re)load of the workspace does to the selection. A refresh must never replace what the reviewer
 * chose: an open safeguard task, the safeguards section and a deliberately closed task all survive it. A
 * default candidate is opened only on the first load of the batch, or when the open one can no longer be
 * opened (another patient's, or gone).
 */
export function selectionAfterLoad(
  current: ReviewSelection,
  data: Workspace,
  load: LoadedSelectionInput,
): ReviewSelection {
  if (load.restored) return withRestoredTarget(current, data, load.restored);
  if (current.safeguard)
    return current.safeguard.reveal
      ? { ...current, safeguard: { ...current.safeguard, reveal: false } }
      : current;
  if (current.candidateId === null) {
    const choosingNothing = !load.first || current.sectionId === "documents-safeguards";
    return choosingNothing ? current : withDefaultCandidate(current, data, load.preferUndecided);
  }
  return openCandidateStillOpen(current, data)
    ? current
    : withDefaultCandidate(current, data, load.preferUndecided);
}

export function selectionAfterOpeningCandidate(
  current: ReviewSelection,
  candidate: Candidate,
): ReviewSelection {
  return {
    ...current,
    sectionId: sectionForField(candidate.fieldPath),
    candidateId: candidate.id,
    safeguard: null,
    nextCandidateId: null,
    revealVersion: current.revealVersion + 1,
    focusVersion: current.focusVersion + 1,
  };
}

export function selectionAfterOpeningSafeguard(
  current: ReviewSelection,
  sectionId: ReviewSectionId,
  safeguard: SafeguardSelection,
): ReviewSelection {
  return {
    ...current,
    sectionId,
    candidateId: null,
    // A fresh object even for the same block, so choosing it again scrolls and focuses it again.
    safeguard: { ...safeguard },
    nextCandidateId: null,
    revealVersion: current.revealVersion + 1,
    focusVersion: current.focusVersion + 1,
  };
}

/** The reviewer chose a block's source inside the safeguard panel: mark it, but do not move focus. */
export function selectionAfterSafeguardBlock(
  current: ReviewSelection,
  safeguard: SafeguardSelection,
): ReviewSelection {
  return { ...current, safeguard, revealVersion: current.revealVersion + 1 };
}

/** Choosing the safeguards section shows its panel, which replaces whatever task was open. */
export function selectionAfterSection(
  current: ReviewSelection,
  sectionId: ReviewSectionId,
): ReviewSelection {
  if (sectionId !== "documents-safeguards") return { ...current, sectionId };
  return { ...current, sectionId, candidateId: null, safeguard: null };
}

export function selectionAfterClosing(current: ReviewSelection): ReviewSelection {
  return { ...current, candidateId: null, safeguard: null };
}

/** The undecided candidate after the saved one, wrapping to the first; withheld and excluded ones never. */
export function nextCandidateAfterSave(latest: Workspace, savedCandidateId: string): string | null {
  const indexById = new Map(latest.candidates.map((candidate, index) => [candidate.id, index]));
  const savedIndex = indexById.get(savedCandidateId) ?? -1;
  const eligible = latest.candidates.filter(
    (candidate) => candidate.decision === null && candidateIsSelectable(latest, candidate),
  );
  const after = eligible.find((candidate) => (indexById.get(candidate.id) ?? -1) > savedIndex);
  return (after ?? eligible[0])?.id ?? null;
}
