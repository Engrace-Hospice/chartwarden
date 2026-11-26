import { describe, expect, it } from "vitest";
import type { Workspace } from "../doclens-api";
import {
  INITIAL_REVIEW_SELECTION,
  type ReviewSelection,
  defaultCandidateId,
  nextCandidateAfterSave,
  selectionAfterClosing,
  selectionAfterLoad,
  selectionAfterOpeningCandidate,
  selectionAfterOpeningSafeguard,
  selectionAfterSafeguardBlock,
  selectionAfterSection,
} from "./review-selection";
import {
  candidateFixture as candidate,
  workspaceFixture as workspace,
} from "./review-workspace-fixtures";

const DECISION = {
  id: "decision-1",
  decision: "approve",
  editedValue: null,
  reason: null,
  partOfBulkApprove: false,
  decidedAt: "2026-11-22T11:00:00.000Z",
} as const;

const FIRST_LOAD = { first: true, restored: null, preferUndecided: true } as const;
const LATER_LOAD = { first: false, restored: null, preferUndecided: true } as const;

function excludeDocument(ws: Workspace, page: number): Workspace {
  return {
    ...ws,
    documents: ws.documents.map((document) =>
      document.pageFrom === page
        ? {
            ...document,
            identity: { status: "possible", disagreeing: [], resolution: "other_patient" },
          }
        : document,
    ),
  };
}

describe("the default candidate", () => {
  it("is the first undecided selectable candidate, or the first selectable one", () => {
    const decided = candidate("patient.email", "a@example.test", { decision: DECISION, page: 1 });
    const withheld = candidate("patient.phoneMobile", null, { redacted: true, page: 2 });
    const undecided = candidate("patient.legalLastName", "Synthetic", { page: 3 });
    const ws = workspace([decided, withheld, undecided]);

    expect(defaultCandidateId(ws, true)).toBe(undecided.id);
    expect(defaultCandidateId(ws, false)).toBe(decided.id);
  });

  it("skips another patient's candidates and is null when nothing can be opened", () => {
    const excluded = candidate("patient.email", "a@example.test", { page: 1 });
    const ws = excludeDocument(workspace([excluded]), 1);

    expect(defaultCandidateId(ws, true)).toBeNull();
  });
});

describe("the selection after a load", () => {
  const first = candidate("patient.email", "a@example.test", { page: 1 });
  const second = candidate("diagnoses[0].description", "Heart failure", { page: 2 });
  const ws = workspace([first, second]);

  it("opens the default candidate and its section on the first load", () => {
    const next = selectionAfterLoad(INITIAL_REVIEW_SELECTION, ws, {
      ...FIRST_LOAD,
      preferUndecided: false,
    });

    expect(next.candidateId).toBe(first.id);
    expect(next.sectionId).toBe("identity-demographics");
    expect(next.focusVersion).toBe(0);
    expect(next.revealVersion).toBe(0);
  });

  it("keeps a deliberately closed task closed on a later load", () => {
    const closed: ReviewSelection = { ...INITIAL_REVIEW_SELECTION, sectionId: "diagnoses-history" };

    expect(selectionAfterLoad(closed, ws, LATER_LOAD)).toBe(closed);
  });

  it("keeps the open candidate while it can still be opened", () => {
    const open: ReviewSelection = { ...INITIAL_REVIEW_SELECTION, candidateId: second.id };

    expect(selectionAfterLoad(open, ws, LATER_LOAD)).toBe(open);
  });

  it("keeps a withheld field the reviewer opened: the panel shows the notice, never the value", () => {
    const open: ReviewSelection = { ...INITIAL_REVIEW_SELECTION, candidateId: second.id };
    const withheld = workspace([first, { ...second, redacted: true }]);

    expect(selectionAfterLoad(open, withheld, LATER_LOAD)).toBe(open);
  });

  it("falls back to the default candidate when the open one is gone", () => {
    const open: ReviewSelection = { ...INITIAL_REVIEW_SELECTION, candidateId: second.id };

    const next = selectionAfterLoad(open, workspace([first]), LATER_LOAD);

    expect(next.candidateId).toBe(first.id);
    expect(next.sectionId).toBe("identity-demographics");
  });

  it("falls back to the default candidate when the open one now belongs to another patient", () => {
    const open: ReviewSelection = { ...INITIAL_REVIEW_SELECTION, candidateId: second.id };
    const ws = excludeDocument(workspace([first, second]), 2);

    expect(selectionAfterLoad(open, ws, LATER_LOAD).candidateId).toBe(first.id);
  });

  it("never replaces an open safeguard task, and it stops asking for a scroll", () => {
    const safeguard = {
      page: 1,
      focus: { kind: "sud" } as const,
      taskId: "safeguard:sud",
      reveal: true,
    };
    const open: ReviewSelection = {
      ...INITIAL_REVIEW_SELECTION,
      sectionId: "documents-safeguards",
      safeguard,
    };

    const next = selectionAfterLoad(open, ws, FIRST_LOAD);

    expect(next.candidateId).toBeNull();
    expect(next.safeguard).toEqual({ ...safeguard, reveal: false });
    expect(
      selectionAfterLoad({ ...open, safeguard: { ...safeguard, reveal: false } }, ws, LATER_LOAD)
        .safeguard,
    ).toEqual({ ...safeguard, reveal: false });
  });

  it("keeps the safeguards section without choosing a task", () => {
    const section: ReviewSelection = {
      ...INITIAL_REVIEW_SELECTION,
      sectionId: "documents-safeguards",
    };

    expect(selectionAfterLoad(section, ws, LATER_LOAD)).toBe(section);
  });

  it("opens a restored candidate in its own section and asks for its row to be shown", () => {
    const next = selectionAfterLoad(INITIAL_REVIEW_SELECTION, ws, {
      ...FIRST_LOAD,
      restored: { kind: "candidate", candidateId: second.id },
    });

    expect(next.candidateId).toBe(second.id);
    expect(next.sectionId).toBe("diagnoses-history");
    expect(next.revealVersion).toBe(1);
    expect(next.focusVersion).toBe(0);
  });

  it("marks a restored safeguard block without a scroll or focus request", () => {
    const next = selectionAfterLoad(INITIAL_REVIEW_SELECTION, ws, {
      ...FIRST_LOAD,
      restored: { kind: "safeguard", page: 2, focus: { kind: "identity", page: 2 } },
    });

    expect(next.candidateId).toBeNull();
    expect(next.sectionId).toBe("documents-safeguards");
    expect(next.safeguard).toEqual({
      page: 2,
      focus: { kind: "identity", page: 2 },
      taskId: "identity:2",
      reveal: false,
    });
    expect(next.focusVersion).toBe(0);
  });
});

describe("choosing and closing a task", () => {
  const email = candidate("patient.email", "a@example.test", { page: 1 });
  const diagnosis = candidate("diagnoses[0].description", "Heart failure", { page: 2 });

  it("opening a candidate follows it into its section and asks for focus and its row", () => {
    const safeguardOpen: ReviewSelection = {
      ...INITIAL_REVIEW_SELECTION,
      sectionId: "documents-safeguards",
      nextCandidateId: "c-9",
      safeguard: { page: 1, focus: null, taskId: null, reveal: true },
    };

    const next = selectionAfterOpeningCandidate(safeguardOpen, diagnosis);

    expect(next).toMatchObject({
      sectionId: "diagnoses-history",
      candidateId: diagnosis.id,
      safeguard: null,
      nextCandidateId: null,
      revealVersion: 1,
      focusVersion: 1,
    });
    expect(selectionAfterOpeningCandidate(next, email).focusVersion).toBe(2);
  });

  it("opening a safeguard clears the open candidate and asks for focus", () => {
    const open = selectionAfterOpeningCandidate(INITIAL_REVIEW_SELECTION, email);
    const safeguard = { page: 4, focus: null, taskId: "review:locked", reveal: true };

    const next = selectionAfterOpeningSafeguard(open, "documents-safeguards", safeguard);

    expect(next).toMatchObject({
      sectionId: "documents-safeguards",
      candidateId: null,
      safeguard,
      nextCandidateId: null,
      focusVersion: 2,
    });
  });

  it("choosing a block inside the panel marks its row without asking for focus", () => {
    const open = selectionAfterOpeningSafeguard(INITIAL_REVIEW_SELECTION, "documents-safeguards", {
      page: 1,
      focus: { kind: "sud" },
      taskId: "safeguard:sud",
      reveal: true,
    });
    const block = {
      page: 2,
      focus: { kind: "identity", page: 2 } as const,
      taskId: "identity:2",
      reveal: false,
    };

    const next = selectionAfterSafeguardBlock(open, block);

    expect(next.safeguard).toBe(block);
    expect(next.revealVersion).toBe(open.revealVersion + 1);
    expect(next.focusVersion).toBe(open.focusVersion);
  });

  it("choosing the safeguards section closes the open task; any other section keeps it", () => {
    const open = selectionAfterOpeningCandidate(INITIAL_REVIEW_SELECTION, email);

    expect(selectionAfterSection(open, "care-needs")).toMatchObject({
      sectionId: "care-needs",
      candidateId: email.id,
    });
    expect(selectionAfterSection(open, "documents-safeguards")).toMatchObject({
      sectionId: "documents-safeguards",
      candidateId: null,
      safeguard: null,
    });
  });

  it("closing keeps the section and clears the open task", () => {
    const open = selectionAfterOpeningCandidate(INITIAL_REVIEW_SELECTION, diagnosis);

    const next = selectionAfterClosing(open);

    expect(next).toMatchObject({
      sectionId: "diagnoses-history",
      candidateId: null,
      safeguard: null,
    });
    expect(next.focusVersion).toBe(open.focusVersion);
  });
});

describe("the next issue after a save", () => {
  const first = candidate("patient.email", "a@example.test", { page: 1 });
  const second = candidate("patient.phoneMobile", "(503) 555-0177", { page: 2 });
  const third = candidate("patient.legalLastName", "Synthetic", { page: 3 });

  it("is the next undecided candidate after the saved one", () => {
    expect(nextCandidateAfterSave(workspace([first, second, third]), first.id)).toBe(second.id);
    expect(nextCandidateAfterSave(workspace([first, second, third]), second.id)).toBe(third.id);
  });

  it("wraps around to the first undecided candidate", () => {
    const ws = workspace([first, { ...second, decision: DECISION }, third]);

    expect(nextCandidateAfterSave(ws, third.id)).toBe(first.id);
  });

  it("skips decided, withheld and another patient's candidates", () => {
    const saved = { ...first, decision: DECISION };
    const decided = { ...second, decision: DECISION };
    const withheld = { ...third, redacted: true };

    expect(nextCandidateAfterSave(workspace([saved, decided, withheld]), saved.id)).toBeNull();
    expect(
      nextCandidateAfterSave(excludeDocument(workspace([saved, second]), 2), saved.id),
    ).toBeNull();
  });

  it("starts from the first undecided candidate when the saved one is gone", () => {
    expect(nextCandidateAfterSave(workspace([first, second]), "missing")).toBe(first.id);
  });
});
