// apps/backend/__tests__/m22-doclens-sud-writeback-gate.test.ts — GAP-067 follow-up: what a reviewer may SEE
// (sud-content-gate.ts) and what may reach the chart are independent. A fresh detection is readable by its
// licensed adjudicator without consent, but NO planner writes SUD-flagged content to the chart for a
// detected or confirmed batch — and none takes a reviewer-visibility or consent input, so visibility can
// never widen writeback. Only a reviewer-rejected detection (a documented false positive, not Part 2
// content) releases SUD-flagged candidates. Characterization of the existing planners (they already
// behaved this way); this pins it for the M22 base planner too, whose status matrix was untested.
import { describe, expect, it } from "vitest";
import {
  type WritebackCandidateFact,
  planDocLensWriteback,
} from "../src/modules/22-documents/extraction/writeback-plan";

const PATIENT = "p-1";

const fact = (over: Partial<WritebackCandidateFact> = {}): WritebackCandidateFact => ({
  candidateId: "c-1",
  decisionId: "d-1",
  fieldPath: "patient.phoneHome",
  riskLevel: "low",
  sudDetected: true,
  extractedValue: "(503) 555-0142",
  decision: "approve",
  editedValue: null,
  sourceDocumentId: "doc-1",
  ...over,
});

describe("GAP-067 — SUD-flagged content never reaches the chart for a pending or confirmed batch", () => {
  it.each(["detected", "confirmed"] as const)(
    "excludes a SUD-flagged candidate when the batch is %s",
    (status) => {
      const p = planDocLensWriteback({
        batchPatientId: PATIENT,
        batchSudStatus: status,
        facts: [fact()],
      });
      expect(p.committed).toEqual([]);
      expect(p.excluded.map((e) => e.reason)).toEqual(["sud_detected"]);
    },
  );

  it("fails closed when the batch status is not supplied", () => {
    const p = planDocLensWriteback({ batchPatientId: PATIENT, facts: [fact()] });
    expect(p.committed).toEqual([]);
    expect(p.excluded.map((e) => e.reason)).toEqual(["sud_detected"]);
  });

  it("releases it only after a reviewer rejected the detection (not Part 2 content)", () => {
    const p = planDocLensWriteback({
      batchPatientId: PATIENT,
      batchSudStatus: "rejected",
      facts: [fact()],
    });
    expect(p.committed).toHaveLength(1);
  });
});
