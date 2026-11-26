import { describe, expect, it } from "vitest";
import type { Candidate, Workspace } from "../doclens-api";
import {
  type ReviewExceptionTask,
  SUD_TASK_ID,
  candidateTaskId,
  exceptionTaskTarget,
  identityTaskId,
  openTaskIds,
  projectExceptionSummary,
  safeguardTaskId,
  targetTaskId,
} from "./review-exception-tasks";
import { type ReviewExceptionRuntime, projectReviewExceptions } from "./review-exceptions";
import { projectReviewGroups } from "./review-projection";
import {
  candidateFixture as candidate,
  workspaceFixture as workspace,
} from "./review-workspace-fixtures";

function tasksOf(
  ws: Workspace,
  runtime: ReviewExceptionRuntime = {},
): readonly ReviewExceptionTask[] {
  const raw = projectReviewExceptions(ws, projectReviewGroups(ws), runtime);
  return projectExceptionSummary(raw).categories.flatMap((category) => category.tasks);
}

describe("exception task target", () => {
  it("routes an unresolved SUD task to the safeguard panel even though it carries a candidate id", () => {
    const zip = candidate("patient.address.postalCode", "97301", { sudDetected: true, page: 4 });
    const base = workspace([zip]);
    const ws: Workspace = {
      ...base,
      sud: {
        ...base.sud,
        status: "detected",
        indicators: [{ page: 4, category: "sud", ruleId: "r1", term: "term", bbox: [1, 1, 2, 2] }],
      },
    };
    const task = tasksOf(ws).find((entry) => entry.id === "safeguard:sud");

    expect(task?.candidateId).toBe(zip.id);
    expect(task && exceptionTaskTarget(task)).toEqual({
      kind: "safeguard",
      page: 4,
      focus: { kind: "sud" },
    });
  });

  it("routes an unresolved identity task to its page-specific identity block", () => {
    const first = candidate("patient.legalLastName", "Synthetic", { page: 13 });
    const base = workspace([first]);
    const ws: Workspace = {
      ...base,
      documents: base.documents.map((document) => ({
        ...document,
        identity: { status: "possible", disagreeing: ["lastName"], resolution: null },
      })),
    };
    const task = tasksOf(ws).find((entry) => entry.id === "identity:13");

    expect(task && exceptionTaskTarget(task)).toEqual({
      kind: "safeguard",
      page: 13,
      focus: { kind: "identity", page: 13 },
    });
  });

  it("opens an ordinary or withheld candidate task as that candidate", () => {
    const phone = candidate("patient.email", "synthetic@example.test", { confidence: 0.4 });
    const withheld = candidate("medications[0].name", null, { redacted: true, sudDetected: true });
    const ws = workspace([phone, withheld]);
    const tasks = tasksOf(ws);

    const ordinary = tasks.find((entry) => entry.id === candidateTaskId(phone.id));
    const part2 = tasks.find((entry) => entry.id === candidateTaskId(withheld.id));
    expect(ordinary && exceptionTaskTarget(ordinary)).toEqual({
      kind: "candidate",
      candidateId: phone.id,
    });
    expect(part2?.categoryId).toBe("part2-sud");
    expect(part2 && exceptionTaskTarget(part2)).toEqual({
      kind: "candidate",
      candidateId: withheld.id,
    });
  });

  it("opens a task with no candidate in the safeguard panel without choosing a block", () => {
    const ws = workspace([candidate("patient.email", "synthetic@example.test")], {
      review: { id: "review-1", status: "in_progress", reviewerMembershipId: "m-2", isMine: false },
    });
    const task = tasksOf(ws).find((entry) => entry.id === "review:locked");

    expect(task && exceptionTaskTarget(task)).toEqual({
      kind: "safeguard",
      page: null,
      focus: null,
    });
  });
});

describe("exception task target of a blocked task", () => {
  it("opens the safeguard panel on the page of a source that is unavailable and has no candidate", () => {
    const ws = workspace([candidate("patient.email", "synthetic@example.test", { page: 1 })]);

    const task = tasksOf(ws, { sourceUnavailablePages: new Set([9]) }).find(
      (entry) => entry.id === "source:9",
    );

    expect(task?.candidateId).toBeNull();
    expect(task && exceptionTaskTarget(task)).toEqual({ kind: "safeguard", page: 9, focus: null });
  });

  it("opens the candidate of an unavailable source page that has one", () => {
    const email = candidate("patient.email", "synthetic@example.test", { page: 4 });

    const task = tasksOf(workspace([email]), { sourceUnavailablePages: new Set([4]) }).find(
      (entry) => entry.id === "source:4",
    );

    expect(task && exceptionTaskTarget(task)).toEqual({ kind: "candidate", candidateId: email.id });
  });

  it("opens the safeguard panel for an extraction that is unavailable", () => {
    const ws = workspace([candidate("patient.email", "synthetic@example.test", { page: 1 })], {
      jobs: [
        {
          id: "job-awaiting",
          documentType: "discharge_summary",
          status: "awaiting_capability",
          pageFrom: 6,
          pageTo: 6,
          failureReason: null,
        },
      ],
    });

    const task = tasksOf(ws).find((entry) => entry.id === "job:job-awaiting");

    expect(task?.blocked).toBe(true);
    expect(task?.title).toBe("Extraction unavailable for page 6");
    expect(task && exceptionTaskTarget(task)).toEqual({ kind: "safeguard", page: 6, focus: null });
  });
});

describe("exception task subject", () => {
  function diagnoses(): Workspace {
    return workspace([
      candidate("diagnoses[2].description", "Dependence on supplemental oxygen", {
        riskLevel: "high",
        page: 18,
      }),
      candidate("diagnoses[3].description", "Chronic kidney disease stage 4", {
        riskLevel: "high",
        page: 6,
      }),
    ]);
  }

  it("distinguishes identically titled high-risk rows by field, extracted value and page", () => {
    const tasks = tasksOf(diagnoses()).filter((task) => task.categoryId === "high-risk");

    expect(tasks.map((task) => task.title)).toEqual([
      "Diagnosis needs high-risk review",
      "Diagnosis needs high-risk review",
    ]);
    expect(tasks.map((task) => task.subject)).toEqual([
      "Diagnosis 3 · description: Dependence on supplemental oxygen · p.18",
      "Diagnosis 4 · description: Chronic kidney disease stage 4 · p.6",
    ]);
  });

  it("keeps task keys candidate-based so consolidation is unchanged", () => {
    const ws = diagnoses();
    const tasks = tasksOf(ws).filter((task) => task.categoryId === "high-risk");

    expect(new Set(tasks.map((task) => task.id))).toEqual(
      new Set(ws.candidates.map((item) => candidateTaskId(item.id))),
    );
    expect(tasks.every((task) => task.reasons.length === 1)).toBe(true);
  });

  it("never prints a value for a withheld candidate", () => {
    const withheld = candidate("medications[0].name", "Morphine 5 mg", {
      redacted: true,
      riskLevel: "high",
    });
    const tasks = tasksOf(workspace([withheld]));
    const subject = tasks.map((task) => task.subject ?? "").join("|");

    expect(subject).not.toContain("Morphine");
    expect(subject).toContain("withheld");
  });

  it("leaves non-candidate exceptions without a subject", () => {
    const ws = workspace([candidate("patient.email", "synthetic@example.test")], {
      review: { id: "review-1", status: "in_progress", reviewerMembershipId: "m-2", isMine: false },
    });
    const locked = tasksOf(ws).find((task) => task.id === "review:locked");

    expect(locked?.subject).toBeUndefined();
    expect(locked?.title).toBe("Another reviewer owns this review");
  });
});

describe("exception task order", () => {
  it("lists unblocked tasks first, then by priority, title and numeric subject", () => {
    const tenth = candidate("diagnoses[9].description", "Pleural effusion", {
      riskLevel: "high",
      page: 3,
    });
    const second = candidate("diagnoses[1].description", "Heart failure", {
      riskLevel: "high",
      page: 1,
    });
    const third = candidate("diagnoses[2].description", "Atrial fibrillation", {
      riskLevel: "high",
      page: 2,
    });
    const email = candidate("patient.email", "synthetic@example.test", {
      confidence: 0.5,
      page: 4,
    });
    const ws = workspace([tenth, second, third, email], {
      jobs: [
        {
          id: "job-failed",
          documentType: "discharge_summary",
          status: "failed",
          pageFrom: 7,
          pageTo: 8,
          failureReason: null,
        },
      ],
    });

    const tasks = tasksOf(ws, { sourceUnavailablePages: new Set([4]) });

    expect(tasks.map((task) => task.id)).toEqual([
      candidateTaskId(second.id),
      candidateTaskId(third.id),
      candidateTaskId(tenth.id),
      candidateTaskId(email.id),
      "source:4",
      "job:job-failed",
    ]);
    expect(tasks.map((task) => task.blocked)).toEqual([false, false, false, false, true, true]);
    expect(tasks.map((task) => task.categoryId)).toEqual([
      "high-risk",
      "high-risk",
      "high-risk",
      "other",
      "other",
      "other",
    ]);
    expect(tasks.map((task) => task.title)).toEqual([
      "Diagnosis needs high-risk review",
      "Diagnosis needs high-risk review",
      "Diagnosis needs high-risk review",
      "Email needs a closer look",
      "Source page 4 is unavailable",
      "Extraction unavailable for pages 7–8",
    ]);
  });

  it("orders a blocked task by priority only after every unblocked one", () => {
    const email = candidate("patient.email", "synthetic@example.test", {
      confidence: 0.5,
      page: 4,
    });
    const tasks = tasksOf(workspace([email]), { sourceUnavailablePages: new Set([4]) });

    const source = tasks.find((task) => task.id === "source:4");
    const closerLook = tasks.find((task) => task.id === candidateTaskId(email.id));
    expect(source?.reasons[0]?.priority).toBe(0);
    expect(closerLook?.reasons[0]?.priority).toBe(2);
    expect(tasks.map((task) => task.id)).toEqual([candidateTaskId(email.id), "source:4"]);
  });

  it("names the category from the strongest reason of a consolidated task", () => {
    const conflictingFirst = candidate("patient.email", "first@example.test", {
      riskLevel: "high",
      page: 1,
    });
    const conflictingSecond = candidate("patient.email", "second@example.test", { page: 2 });
    const part2 = candidate("medications[0].name", null, { redacted: true, riskLevel: "high" });
    const visionAndRisk = candidate("diagnoses[0].description", "Heart failure", {
      riskLevel: "high",
      vision: { status: "disagreed", observedValue: "Heart disease" },
    });
    const visionOnly = candidate("allergies[0].substance", "Penicillin", {
      vision: { status: "disagreed", observedValue: "Penicilin" },
    });
    const categoryOf = (items: readonly Candidate[], target: Candidate): string | undefined =>
      tasksOf(workspace(items)).find((task) => task.id === candidateTaskId(target.id))?.categoryId;

    expect(categoryOf([conflictingFirst, conflictingSecond], conflictingFirst)).toBe("conflicts");
    expect(categoryOf([part2], part2)).toBe("part2-sud");
    expect(categoryOf([visionAndRisk], visionAndRisk)).toBe("high-risk");
    expect(categoryOf([visionOnly], visionOnly)).toBe("vision");
    const reasons = tasksOf(workspace([conflictingFirst, conflictingSecond])).find(
      (task) => task.id === candidateTaskId(conflictingFirst.id),
    )?.reasons;
    expect(reasons?.map((reason) => reason.kind)).toEqual(["conflict", "high-risk"]);
  });
});

describe("open task ids", () => {
  function conflictingEmails(): { ws: Workspace; first: Candidate; second: Candidate } {
    const first = candidate("patient.email", "first@example.test", { page: 1 });
    const second = candidate("patient.email", "second@example.test", { page: 2 });
    return { ws: workspace([first, second]), first, second };
  }

  it("pulls in the task of a group a candidate belongs to", () => {
    const { ws, first, second } = conflictingEmails();
    const summary = projectExceptionSummary(projectReviewExceptions(ws, projectReviewGroups(ws)));

    const open = openTaskIds(summary, projectReviewGroups(ws), {
      candidateId: second.id,
      safeguardTaskId: null,
    });

    expect(open).toEqual(new Set([candidateTaskId(second.id), candidateTaskId(first.id)]));
  });

  it("falls back to the candidate's own task when it is in no group", () => {
    const { ws, first } = conflictingEmails();
    const summary = projectExceptionSummary(projectReviewExceptions(ws, projectReviewGroups(ws)));

    const open = openTaskIds(summary, [], {
      candidateId: "no-such-candidate",
      safeguardTaskId: null,
    });
    const known = openTaskIds(summary, [], { candidateId: first.id, safeguardTaskId: null });

    expect(open).toEqual(new Set([candidateTaskId("no-such-candidate")]));
    expect(known).toEqual(new Set([candidateTaskId(first.id)]));
  });

  it("uses the open safeguard's task when no candidate is open", () => {
    const { ws } = conflictingEmails();
    const summary = projectExceptionSummary(projectReviewExceptions(ws, projectReviewGroups(ws)));

    expect(openTaskIds(summary, [], { candidateId: null, safeguardTaskId: SUD_TASK_ID })).toEqual(
      new Set([SUD_TASK_ID]),
    );
  });

  it("does not mark the SUD safeguard task open because the field it borrows is open", () => {
    const zip = candidate("patient.address.postalCode", "97301", { sudDetected: true, page: 4 });
    const base = workspace([zip]);
    const ws: Workspace = {
      ...base,
      sud: {
        ...base.sud,
        status: "detected",
        indicators: [{ page: 4, category: "sud", ruleId: "r1", term: "term", bbox: [1, 1, 2, 2] }],
      },
    };
    const groups = projectReviewGroups(ws);
    const summary = projectExceptionSummary(projectReviewExceptions(ws, groups));

    const open = openTaskIds(summary, groups, { candidateId: zip.id, safeguardTaskId: null });

    expect(
      summary.categories.flatMap((category) => category.tasks.map((task) => task.id)),
    ).toContain(SUD_TASK_ID);
    expect(open.has(SUD_TASK_ID)).toBe(false);
    expect(open.has(candidateTaskId(zip.id))).toBe(true);
  });

  it("is empty when nothing is open", () => {
    const { ws } = conflictingEmails();
    const summary = projectExceptionSummary(projectReviewExceptions(ws, projectReviewGroups(ws)));

    expect(openTaskIds(summary, [], { candidateId: null, safeguardTaskId: null }).size).toBe(0);
  });
});

describe("task ids of a target", () => {
  it("names the task of a candidate or of a safeguard block", () => {
    expect(targetTaskId({ kind: "candidate", candidateId: "c-1" })).toBe("candidate:c-1");
    expect(targetTaskId({ kind: "safeguard", page: 1, focus: { kind: "sud" } })).toBe(SUD_TASK_ID);
    expect(targetTaskId({ kind: "safeguard", page: 5, focus: { kind: "identity", page: 5 } })).toBe(
      "identity:5",
    );
  });

  it("has no task id for a safeguard target that names no block", () => {
    expect(targetTaskId({ kind: "safeguard", page: 3, focus: null })).toBeNull();
    expect(targetTaskId({ kind: "safeguard", page: null, focus: null })).toBeNull();
  });

  it("keys a safeguard block by its kind and page", () => {
    expect(safeguardTaskId({ kind: "sud" })).toBe(SUD_TASK_ID);
    expect(safeguardTaskId({ kind: "identity", page: 12 })).toBe(identityTaskId(12));
    expect(identityTaskId(12)).toBe("identity:12");
  });
});

describe("exception subject text", () => {
  const SUBJECT_VALUE_MAX = 80;

  function subjectOf(
    target: Candidate,
    items: readonly Candidate[] = [target],
  ): string | undefined {
    return tasksOf(workspace(items)).find((task) => task.id === candidateTaskId(target.id))
      ?.subject;
  }

  it("cuts a long value at 80 characters with an ellipsis and never leaves a trailing space", () => {
    const long = candidate("diagnoses[0].description", "x".repeat(SUBJECT_VALUE_MAX + 20), {
      riskLevel: "high",
      page: 1,
    });
    const spaced = candidate("diagnoses[1].description", `${"y".repeat(79)} ${"z".repeat(20)}`, {
      riskLevel: "high",
      page: 2,
    });
    const exact = candidate("diagnoses[2].description", "w".repeat(SUBJECT_VALUE_MAX), {
      riskLevel: "high",
      page: 3,
    });

    expect(subjectOf(long)).toBe(
      `Diagnosis 1 · description: ${"x".repeat(SUBJECT_VALUE_MAX)}… · p.1`,
    );
    expect(subjectOf(spaced)).toBe(`Diagnosis 2 · description: ${"y".repeat(79)}… · p.2`);
    expect(subjectOf(exact)).toBe(
      `Diagnosis 3 · description: ${"w".repeat(SUBJECT_VALUE_MAX)} · p.3`,
    );
  });

  it("says no value was extracted when the candidate has none", () => {
    const empty = candidate("diagnoses[0].description", null, { riskLevel: "high", page: 1 });

    expect(subjectOf(empty)).toBe("Diagnosis 1 · description: no value extracted · p.1");
  });

  it("carries the subject of a vision disagreement, a low-confidence value and an undecided one", () => {
    const vision = candidate("allergies[0].substance", "Penicillin", {
      page: 1,
      vision: { status: "disagreed", observedValue: "Penicilin" },
    });
    const lowConfidence = candidate("patient.email", "synthetic@example.test", {
      confidence: 0.5,
      page: 2,
    });
    const undecided = candidate("patient.phoneMobile", "(503) 555-0177", { page: 3 });
    const items = [vision, lowConfidence, undecided];

    expect(subjectOf(vision, items)).toBe("Allergy 1 · substance: Penicillin · p.1");
    expect(subjectOf(lowConfidence, items)).toBe("Email: synthetic@example.test · p.2");
    expect(subjectOf(undecided, items)).toBe("Mobile phone: (503) 555-0177 · p.3");
  });

  it("marks a withheld candidate by the word withheld and its page", () => {
    const withheld = candidate("medications[0].name", "Morphine 5 mg", {
      redacted: true,
      riskLevel: "high",
      page: 1,
    });

    expect(subjectOf(withheld)).toBe("Medication 1 · name: withheld · p.1");
  });
});
