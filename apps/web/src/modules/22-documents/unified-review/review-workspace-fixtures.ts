// Synthetic workspaces for the pure projection tests: one document per candidate page, no real identifiers.
import type { Candidate, Workspace } from "../doclens-api";

let sequence = 0;

export function candidateFixture(
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

export function workspaceFixture(
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
