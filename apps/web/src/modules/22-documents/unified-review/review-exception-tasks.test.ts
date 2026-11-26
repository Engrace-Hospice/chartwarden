import { describe, expect, it } from "vitest";
import type { Candidate, Workspace } from "../doclens-api";
import {
  type ReviewExceptionTask,
  candidateTaskId,
  exceptionTaskTarget,
  projectExceptionSummary,
} from "./review-exception-tasks";
import { projectReviewExceptions } from "./review-exceptions";
import { projectReviewGroups } from "./review-projection";

let sequence = 0;

function candidate(
  fieldPath: string,
  value: string | null,
  overrides: Partial<Candidate> = {},
): Candidate {
  sequence += 1;
  return {
    id: `candidate-${sequence}`,
    jobId: `job-${sequence}`,
    documentType: "discharge_summary",
    fieldPath,
    description: null,
    riskLevel: "low",
    confidence: 0.95,
    value,
    page: sequence,
    bbox: [10, 10, 20, 20],
    vision: { status: "not_required", observedValue: null },
    sudDetected: false,
    codingFlags: [],
    writebackTarget: false,
    redacted: false,
    decision: null,
    ...overrides,
  };
}

function workspace(
  candidates: readonly Candidate[],
  overrides: Partial<Workspace> = {},
): Workspace {
  return {
    batch: {
      id: "batch-1",
      status: "in_review",
      sourceChannel: "fax",
      uploadedAt: "2026-11-22T10:00:00.000Z",
      documentId: "document-1",
      patientId: "patient-1",
      patientName: "Synthetic Patient",
      referralId: "referral-1",
      identityStatus: "match",
      recordsRequestConflict: null,
    },
    sud: {
      status: "not_detected",
      detectorRef: null,
      resolvedAt: null,
      resolvedByMembershipId: null,
      contentRedacted: false,
      indicators: [],
    },
    pages: candidates.map((item) => ({
      page: item.page,
      width: 612,
      height: 792,
      documentType: item.documentType,
      confidence: 0.98,
      needsHumanClassification: false,
    })),
    documents: candidates.map((item) => ({
      pageFrom: item.page,
      pageTo: item.page,
      documentType: item.documentType,
      title: `Source ${item.page}`,
      date: null,
      duplicateOfPage: null,
      boundary: null,
      identity: { status: "match", disagreeing: [], resolution: null },
    })),
    jobs: [],
    review: { id: "review-1", status: "in_progress", reviewerMembershipId: "m-1", isMine: true },
    candidates: [...candidates],
    ...overrides,
  };
}

function tasksOf(ws: Workspace): readonly ReviewExceptionTask[] {
  const raw = projectReviewExceptions(ws, projectReviewGroups(ws));
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
    expect(tasks.map((task) => task.subject).sort()).toEqual([
      "Diagnosis 3 · description: Dependence on supplemental oxygen · p.18",
      "Diagnosis 4 · description: Chronic kidney disease stage 4 · p.6",
    ]);
  });

  it("keeps task keys candidate-based so consolidation is unchanged", () => {
    const ws = diagnoses();
    const tasks = tasksOf(ws).filter((task) => task.categoryId === "high-risk");

    expect(tasks.map((task) => task.id).sort()).toEqual(
      ws.candidates.map((item) => candidateTaskId(item.id)).sort(),
    );
    expect(tasks.every((task) => task.reasons.length === 1)).toBe(true);
  });

  it("never prints a value for a withheld candidate", () => {
    const withheld = candidate("medications[0].name", "Morphine 5 mg", {
      redacted: true,
      riskLevel: "high",
    });
    const tasks = tasksOf(workspace([withheld]));

    expect(tasks.map((task) => task.subject ?? "").join("|")).not.toContain("Morphine");
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
