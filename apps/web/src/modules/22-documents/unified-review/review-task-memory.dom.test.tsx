import { beforeEach, describe, expect, it } from "vitest";
import { recallLastReviewTask, rememberLastReviewTask } from "../../../shell/last-review-task";
import type { Candidate, Workspace } from "../doclens-api";
import { rememberOpenedTask, restoreTaskTarget } from "./review-task-memory";

const BATCH = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

beforeEach(() => window.sessionStorage.clear());

const CANDIDATE: Candidate = {
  id: "cccccccc-3333-4333-8333-cccccccccccc",
  jobId: "job-1",
  documentType: "discharge_summary",
  fieldPath: "patient.email",
  description: null,
  riskLevel: "low",
  confidence: 0.95,
  value: "synthetic@example.test",
  page: 1,
  bbox: [10, 10, 20, 20],
  vision: { status: "not_required", observedValue: null },
  sudDetected: false,
  codingFlags: [],
  writebackTarget: false,
  redacted: false,
  decision: null,
};

function workspaceWith(patch: Partial<Workspace> = {}): Workspace {
  return {
    batch: {
      id: BATCH,
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
    pages: [],
    documents: [
      {
        pageFrom: 1,
        pageTo: 1,
        documentType: "discharge_summary",
        title: "Discharge summary",
        date: null,
        duplicateOfPage: null,
        boundary: null,
        identity: { status: "match", disagreeing: [], resolution: null },
      },
    ],
    jobs: [],
    review: null,
    candidates: [CANDIDATE],
    ...patch,
  };
}

describe("remembering the opened task", () => {
  it("remembers a field task and an identity block", () => {
    rememberOpenedTask(BATCH, `candidate:${CANDIDATE.id}`);
    expect(recallLastReviewTask(BATCH)).toBe(`candidate:${CANDIDATE.id}`);

    rememberOpenedTask(BATCH, "identity:2");
    expect(recallLastReviewTask(BATCH)).toBe("identity:2");
  });

  it("never stores the Part 2 safeguard id and forgets the task it replaces", () => {
    rememberLastReviewTask(BATCH, "identity:2");

    rememberOpenedTask(BATCH, "safeguard:sud");

    expect(Object.keys(window.sessionStorage)).toEqual([]);
    expect(recallLastReviewTask(BATCH)).toBeNull();
  });

  it("forgets the task when the opened one is not worth returning to", () => {
    rememberLastReviewTask(BATCH, "identity:2");

    rememberOpenedTask(BATCH, null);

    expect(recallLastReviewTask(BATCH)).toBeNull();
  });
});

describe("restoring a remembered task", () => {
  it("reopens a candidate that is still selectable", () => {
    expect(restoreTaskTarget(`candidate:${CANDIDATE.id}`, workspaceWith())).toEqual({
      kind: "candidate",
      candidateId: CANDIDATE.id,
    });
  });

  it("drops a candidate that is gone, withheld or another patient's", () => {
    expect(restoreTaskTarget("candidate:missing", workspaceWith())).toBeNull();
    const withheld = workspaceWith({ candidates: [{ ...CANDIDATE, redacted: true }] });
    expect(restoreTaskTarget(`candidate:${CANDIDATE.id}`, withheld)).toBeNull();
    const [document] = workspaceWith().documents;
    if (!document) throw new Error("Expected a document");
    const excluded = workspaceWith({
      documents: [
        {
          ...document,
          identity: { status: "possible", disagreeing: [], resolution: "other_patient" },
        },
      ],
    });
    expect(restoreTaskTarget(`candidate:${CANDIDATE.id}`, excluded)).toBeNull();
  });

  it("never reopens the Part 2 safeguard, even when it is still unresolved", () => {
    const detected = workspaceWith({
      sud: {
        status: "detected",
        detectorRef: null,
        resolvedAt: null,
        resolvedByMembershipId: null,
        contentRedacted: false,
        indicators: [{ page: 4, category: "sud", ruleId: "r1", term: "t", bbox: [1, 1, 2, 2] }],
      },
    });

    expect(restoreTaskTarget("safeguard:sud", detected)).toBeNull();
  });

  it("reopens an identity block only while that document still needs an answer", () => {
    const [document] = workspaceWith().documents;
    if (!document) throw new Error("Expected a document");
    const unresolved = workspaceWith({
      documents: [
        { ...document, identity: { status: "possible", disagreeing: [], resolution: null } },
      ],
    });

    expect(restoreTaskTarget("identity:1", unresolved)).toEqual({
      kind: "safeguard",
      page: 1,
      focus: { kind: "identity", page: 1 },
    });
    expect(restoreTaskTarget("identity:1", workspaceWith())).toBeNull();
    expect(restoreTaskTarget("identity:9", unresolved)).toBeNull();
  });
});
