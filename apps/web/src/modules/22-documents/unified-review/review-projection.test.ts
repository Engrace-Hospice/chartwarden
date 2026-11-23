import { describe, expect, it } from "vitest";
import type { Candidate, Workspace } from "../doclens-api";
import { projectReviewExceptions } from "./review-exceptions";
import { projectReviewGroups, projectUnifiedReview } from "./review-projection";

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
    riskLevel: fieldPath.startsWith("patient.phone") ? "low" : "high",
    confidence: 0.95,
    value,
    page: sequence,
    bbox: [10, 10, 20, 20],
    vision: { status: "not_required", observedValue: null },
    sudDetected: false,
    codingFlags: [],
    writebackTarget: fieldPath.startsWith("patient.phone"),
    redacted: false,
    decision: null,
    ...overrides,
  };
}

function workspace(candidates: readonly Candidate[]): Workspace {
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
    review: {
      id: "review-1",
      status: "in_progress",
      reviewerMembershipId: "membership-1",
      isMine: true,
    },
    candidates: [...candidates],
  };
}

const decided = {
  id: "decision-1",
  decision: "approve",
  editedValue: null,
  reason: null,
  partOfBulkApprove: false,
  decidedAt: "2026-11-22T11:00:00.000Z",
} as const;

describe("unified review projection", () => {
  it("groups identical phone observations while retaining every candidate and provenance", () => {
    const items = [
      candidate("patient.phoneMobile", "(503) 555-0177", { page: 1 }),
      candidate("patient.phoneMobile", "503-555-0177", { page: 2 }),
      candidate("patient.phoneMobile", "+1 503 555 0177", { page: 3 }),
    ];
    const projection = projectUnifiedReview(workspace(items));
    const group = projection.groups[0];

    expect(projection.candidateIds).toEqual(items.map((item) => item.id).sort());
    expect(group?.candidateIds).toHaveLength(3);
    expect(group?.distinctValueCount).toBe(1);
    expect(group?.conflict).toBe(false);
    expect(group?.observations.map((item) => item.candidate.page)).toEqual([1, 2, 3]);
  });

  it("projects conflicting phone values as one reconciliation task", () => {
    const groups = projectReviewGroups(
      workspace([
        candidate("patient.phoneMobile", "503-555-0177"),
        candidate("patient.phoneMobile", "503-555-0188"),
        candidate("patient.phoneMobile", "503-555-0142"),
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.conflict).toBe(true);
    expect(groups[0]?.distinctValueCount).toBe(3);
  });

  it("does not collapse medication strength or frequency differences", () => {
    const groups = projectReviewGroups(
      workspace([
        candidate("medications[0].name", "Morphine 5 mg PO every 4 hours"),
        candidate("medications[1].name", "Morphine 10 mg PO every 4 hours"),
        candidate("medications[2].name", "Morphine 5 mg PO every 6 hours"),
      ]),
    );
    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.highestRisk === "high")).toBe(true);
  });

  it("groups an equivalent diagnosis from separate source pages without losing provenance", () => {
    const groups = projectReviewGroups(
      workspace([
        candidate("diagnoses[0].description", "Congestive heart failure", { page: 2 }),
        candidate("diagnoses[3].description", "  CONGESTIVE  HEART FAILURE ", { page: 8 }),
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.observations.map((item) => item.candidate.page)).toEqual([2, 8]);
  });

  it("keeps decisions candidate-specific within a mixed group", () => {
    const first = candidate("patient.phoneHome", "503-555-0100", { decision: decided });
    const second = candidate("patient.phoneHome", "(503) 555-0100");
    const group = projectReviewGroups(workspace([first, second]))[0];

    expect(group?.state).toBe("partially-reviewed");
    expect(group?.decidedCount).toBe(1);
    expect(group?.observations[0]?.candidate.decision).toBe(decided);
    expect(group?.observations[1]?.candidate.decision).toBeNull();
  });

  it("retains unknown paths in the Other / unmapped documents section", () => {
    const unknown = candidate("experimental[4].unsupportedMeaning", "visible evidence");
    const projection = projectUnifiedReview(workspace([unknown]));
    const group = projection.groups[0];

    expect(group?.sectionId).toBe("documents-safeguards");
    expect(group?.category).toBe("Other / unmapped");
    expect(group?.candidateIds).toEqual([unknown.id]);
  });

  it("reconciles refreshed decision state from the server response", () => {
    const item = candidate("patient.phoneMobile", "503-555-0177");
    const before = projectUnifiedReview(workspace([item]));
    const after = projectUnifiedReview(workspace([{ ...item, decision: decided }]));

    expect(before.decidedCount).toBe(0);
    expect(after.decidedCount).toBe(1);
    expect(before.candidateIds).toEqual(after.candidateIds);
  });
});

describe("unified review exceptions", () => {
  it("projects wrong-patient exclusion, unresolved SUD, vision, redaction, and source failure", () => {
    const vision = candidate("diagnoses[0].description", "Heart failure", {
      vision: { status: "disagreed", observedValue: "Renal failure" },
      page: 1,
    });
    const redacted = candidate("medications[0].name", null, {
      redacted: true,
      sudDetected: true,
      page: 2,
    });
    const base = workspace([vision, redacted]);
    const ws: Workspace = {
      ...base,
      sud: {
        ...base.sud,
        status: "detected",
        contentRedacted: true,
        indicators: [
          { page: 2, category: "sud", ruleId: "r1", term: "withheld", bbox: [1, 1, 2, 2] },
        ],
      },
      documents: base.documents.map((document, index) =>
        index === 0
          ? { ...document, identity: { ...document.identity, resolution: "other_patient" } }
          : document,
      ),
    };
    const exceptions = projectReviewExceptions(ws, projectReviewGroups(ws), {
      sourceUnavailablePages: new Set([1]),
    });

    expect(exceptions.map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        "source-unavailable",
        "wrong-patient",
        "sud-unresolved",
        "vision-disagreement",
        "redacted",
      ]),
    );
  });

  it("projects unresolved identity and review ownership changes", () => {
    const item = candidate("patient.legalLastName", "Synthetic");
    const base = workspace([item]);
    const ws: Workspace = {
      ...base,
      review: base.review ? { ...base.review, isMine: false } : null,
      documents: base.documents.map((document) => ({
        ...document,
        identity: { status: "possible", disagreeing: ["lastName"], resolution: null },
      })),
    };
    const exceptions = projectReviewExceptions(ws, projectReviewGroups(ws));
    expect(exceptions.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["identity-unresolved", "review-locked"]),
    );
  });

  it("projects a low-confidence undecided observation", () => {
    const item = candidate("patient.email", "patient@example.test", {
      confidence: 0.61,
      riskLevel: "low",
    });
    const ws = workspace([item]);
    const exceptions = projectReviewExceptions(ws, projectReviewGroups(ws));
    expect(exceptions.find((entry) => entry.kind === "low-confidence")?.candidateId).toBe(item.id);
  });

  it("does not let a conflict mask independent vision and high-risk exceptions", () => {
    const first = candidate("patient.phoneMobile", "503-555-0177", {
      riskLevel: "high",
      vision: { status: "disagreed", observedValue: "503-555-0188" },
    });
    const second = candidate("patient.phoneMobile", "503-555-0188");
    const ws = workspace([first, second]);

    const exceptions = projectReviewExceptions(ws, projectReviewGroups(ws));

    expect(exceptions.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["conflict", "vision-disagreement", "high-risk"]),
    );
  });
});
