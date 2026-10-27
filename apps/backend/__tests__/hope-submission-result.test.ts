// apps/backend/__tests__/hope-submission-result.test.ts — recording the CMS result of a manual iQIES
// upload: guards, per-item outcome, derived batch status, findings, idempotency, rejected-item resolution,
// reverse lookup. Runs the in-memory slice (the DB backend shares hope-submission-result.ts).
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  MAX_RETAINED_RESULTS,
  appendReportResults,
  classifyCmsResult,
  deriveBatchOutcome,
  isSettledItemStatus,
  manualUploadTransmittedPayload,
  resolveRejectedItem,
  terminalCorrection,
  worstOutcome,
} from "../src/modules/10-hope/hope-submission-result";
import { createInMemoryHopeBackend } from "../src/modules/10-hope/index";

const ORG = "org_a";
const PE = "pe_1";
const A1 = "90000000-0000-4000-8000-000000000001";
const A2 = "90000000-0000-4000-8000-000000000002";
const P1 = "11111111-1111-4111-8111-111111111111";
const base = (id: string) => ({
  id,
  organizationId: ORG,
  patientId: P1,
  admissionId: "adm_1",
  rfaKind: "01_admission" as const,
  status: "signed" as const,
  providerEntityId: PE,
  regulatory: { specVersionId: "sv_1", isc: "HA" as const },
});

function setup() {
  const svc = createInMemoryHopeBackend({
    now: () => "2026-06-08T12:00:00.000Z",
    assessments: [base(A1), base(A2)],
  });
  return svc;
}
const code = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof ChartWardenError ? e.code : "OTHER"),
  );

describe("pure rules", () => {
  it("classifies CMS rows and derives the batch status from the enum", () => {
    expect(classifyCmsResult({ severity: "fatal" })).toBe("rejected");
    expect(classifyCmsResult({ status: "accepted_with_warnings" })).toBe("accepted_with_warnings");
    expect(classifyCmsResult({ status: "accepted" })).toBe("accepted");
    expect(classifyCmsResult({ status: "Accepted with warnings" })).toBe("accepted_with_warnings");
    expect(deriveBatchOutcome(["accepted", "rejected"]).status).toBe("partially_accepted");
    expect(deriveBatchOutcome(["rejected"]).status).toBe("rejected");
    expect(deriveBatchOutcome(["accepted_with_warnings"]).status).toBe("accepted_with_warnings");
    expect(deriveBatchOutcome(["accepted", "pending"]).status).toBe("submitted_pending_result");
  });
  it("resolves a rejected item by its correction", () => {
    expect(resolveRejectedItem(null)).toBe("needs_correction");
    expect(resolveRejectedItem({ itemStatus: null })).toBe("correction_in_progress");
    expect(resolveRejectedItem({ itemStatus: "pending" })).toBe("resubmitted");
    expect(resolveRejectedItem({ itemStatus: "accepted" })).toBe("resolved");
  });
});

describe("importSubmissionResult", () => {
  it("refuses a batch that was packaged but never uploaded", async () => {
    const svc = setup();
    const b = await svc.assembleSubmission(ORG, PE);
    expect(
      await code(
        svc.importSubmissionResult(ORG, "u1", b.id, {
          results: [{ assessmentId: A1, status: "accepted" }],
        }),
      ),
    ).toBe("M10_SUBMISSION_RESULT_NOT_UPLOADED");
  });

  it("records per-item outcomes + findings, derives partially_accepted, and exposes them on detail", async () => {
    const svc = setup();
    const b = await svc.assembleSubmission(ORG, PE);
    await svc.markSubmissionUploaded(ORG, "u1", b.id, {});
    const out = await svc.importSubmissionResult(ORG, "u1", b.id, {
      reportReference: "FVR-1",
      results: [
        { assessmentId: A1, status: "accepted" },
        { assessmentId: A2, status: "rejected", code: "-3001", itemCode: "A0200", message: "bad" },
      ],
    });
    expect(out.status).toBe("partially_accepted");
    expect(out.acceptedCount).toBe(1);
    expect(out.rejectedCount).toBe(1);
    const d = await svc.getSubmission(ORG, b.id);
    expect(d.items.map((i) => [i.assessmentId, i.status]).sort()).toEqual([
      [A1, "accepted"],
      [A2, "rejected"],
    ]);
    const rej = d.items.find((i) => i.assessmentId === A2);
    expect(rej?.resolution).toBe("needs_correction");
    expect(rej?.patientId).toBe(P1);
    expect(d.findings).toEqual([
      expect.objectContaining({
        severity: "error",
        assessmentId: A2,
        itemCode: "A0200",
        message: "bad",
      }),
    ]);
    expect(d.needsCorrectionCount).toBe(1);
  });

  it("is idempotent for the same report and refuses a conflicting second report once resolved", async () => {
    const svc = setup();
    const b = await svc.assembleSubmission(ORG, PE);
    await svc.markSubmissionUploaded(ORG, "u1", b.id, {});
    const report = {
      results: [
        { assessmentId: A1, status: "accepted" },
        { assessmentId: A2, status: "accepted" },
      ],
    };
    await svc.importSubmissionResult(ORG, "u1", b.id, report);
    const again = await svc.importSubmissionResult(ORG, "u1", b.id, report);
    expect(again.status).toBe("accepted");
    expect(
      await code(
        svc.importSubmissionResult(ORG, "u1", b.id, {
          results: [{ assessmentId: A1, status: "rejected" }],
        }),
      ),
    ).toBe("M10_SUBMISSION_RESULT_ALREADY_RECORDED");
  });

  it("replaying an OLDER report (A, B, A) in a pending batch changes nothing", async () => {
    const svc = setup();
    const b = await svc.assembleSubmission(ORG, PE);
    await svc.markSubmissionUploaded(ORG, "u1", b.id, {});
    const A = {
      reportReference: "ra",
      results: [{ assessmentId: A1, status: "accepted", message: "from A" }],
    };
    const B = {
      reportReference: "rb",
      results: [{ assessmentId: A1, status: "accepted", message: "from B" }],
    };
    await svc.importSubmissionResult(ORG, "u1", b.id, A);
    const afterB = await svc.importSubmissionResult(ORG, "u1", b.id, B);
    const replay = await svc.importSubmissionResult(ORG, "u2", b.id, A);
    expect(afterB.findings).toHaveLength(2);
    expect(replay.findings).toHaveLength(2);
    expect(replay.resultReportReference).toBe("rb");
    expect(replay.status).toBe(afterB.status);
  });

  it("rejects a report that matches no item in the batch", async () => {
    const svc = setup();
    const b = await svc.assembleSubmission(ORG, PE);
    await svc.markSubmissionUploaded(ORG, "u1", b.id, {});
    expect(
      await code(
        svc.importSubmissionResult(ORG, "u1", b.id, {
          results: [{ assessmentId: "nope", status: "accepted" }],
        }),
      ),
    ).toBe("M10_SUBMISSION_RESULT_NO_MATCH");
  });

  it("keeps the batch pending when the report omits an item", async () => {
    const svc = setup();
    const b = await svc.assembleSubmission(ORG, PE);
    await svc.markSubmissionUploaded(ORG, "u1", b.id, {});
    const out = await svc.importSubmissionResult(ORG, "u1", b.id, {
      results: [{ assessmentId: A1, status: "accepted" }],
    });
    expect(out.status).toBe("submitted_pending_result");
  });
});

describe("reverse lookup", () => {
  it("lists the batches that hold an assessment", async () => {
    const svc = setup();
    const b = await svc.assembleSubmission(ORG, PE);
    const r = await svc.listAssessmentSubmissions(ORG, A1);
    expect(r.submissions).toEqual([
      expect.objectContaining({ submissionId: b.id, status: "packaged", itemStatus: "pending" }),
    ]);
  });
});

describe("polarity-safe CMS status classification", () => {
  it.each([
    ["Not Accepted", "rejected"],
    ["Unaccepted", "rejected"],
    ["Accepted, 0 errors", "accepted"],
    ["Passed (no errors)", "accepted"],
    ["Accepted with warnings", "accepted_with_warnings"],
    ["failed", "rejected"],
    ["mystery", "pending"],
  ])("%s -> %s", (status, expected) => {
    expect(classifyCmsResult({ status })).toBe(expected);
  });

  it("keeps the worst outcome per assessment regardless of row order", () => {
    expect(worstOutcome("rejected", "accepted_with_warnings")).toBe("rejected");
    expect(worstOutcome("accepted_with_warnings", "rejected")).toBe("rejected");
    expect(worstOutcome("accepted", "accepted_with_warnings")).toBe("accepted_with_warnings");
  });
});

describe("correction chains", () => {
  it("resolves an original by the END of its chain, not its first correction", () => {
    const childOf = new Map([
      ["A", "B"],
      ["B", "C"],
    ]);
    expect(terminalCorrection("A", childOf)).toBe("C");
    expect(terminalCorrection("B", childOf)).toBe("C");
    expect(terminalCorrection("C", childOf)).toBeNull();
  });

  it("stops on a corrupt cycle instead of looping", () => {
    const childOf = new Map([
      ["A", "B"],
      ["B", "A"],
    ]);
    expect(terminalCorrection("A", childOf)).not.toBeNull();
  });
});

describe("cross-report verdicts are final", () => {
  it("a later report cannot flip a settled item (slice), later rows still add findings", async () => {
    const svc = setup();
    const b = await svc.assembleSubmission(ORG, PE);
    await svc.markSubmissionUploaded(ORG, "u1", b.id, {});
    await svc.importSubmissionResult(ORG, "u1", b.id, {
      results: [{ assessmentId: A1, status: "rejected", code: "-9" }],
    });
    const out = await svc.importSubmissionResult(ORG, "u1", b.id, {
      results: [
        { assessmentId: A1, status: "accepted", message: "late note" },
        { assessmentId: A2, status: "accepted" },
      ],
    });
    const status = new Map(out.items.map((i) => [i.assessmentId, i.status]));
    expect(status.get(A1)).toBe("rejected");
    expect(status.get(A2)).toBe("accepted");
    expect(out.status).toBe("partially_accepted");
    expect(out.findings.map((f) => f.message)).toContain("late note");
  });

  it("classifies settled item statuses", () => {
    expect(["accepted", "accepted_with_warnings", "rejected"].every(isSettledItemStatus)).toBe(
      true,
    );
    expect(isSettledItemStatus("pending")).toBe(false);
  });

  it("appends earlier raw results and keeps the newest MAX_RETAINED_RESULTS", () => {
    expect(appendReportResults([{ a: 1 }], [{ b: 2 }])).toEqual([{ a: 1 }, { b: 2 }]);
    expect(appendReportResults(undefined, [{ b: 2 }])).toEqual([{ b: 2 }]);
    const many = Array.from({ length: MAX_RETAINED_RESULTS }, (_, i) => ({ i }));
    const out = appendReportResults(many, [{ i: -1 }]);
    expect(out).toHaveLength(MAX_RETAINED_RESULTS);
    expect(out.at(-1)).toEqual({ i: -1 });
  });
});

describe("corrections and legacy batches", () => {
  it("follows the newest correction when an original was corrected twice (slice)", async () => {
    const A3 = "90000000-0000-4000-8000-000000000003";
    const A4 = "90000000-0000-4000-8000-000000000004";
    const svc = createInMemoryHopeBackend({
      now: () => "2026-06-08T12:00:00.000Z",
      assessments: [
        base(A1),
        { ...base(A3), correctsAssessmentId: A1 },
        { ...base(A4), correctsAssessmentId: A1 },
      ],
    });
    const b = await svc.assembleSubmission(ORG, PE);
    await svc.markSubmissionUploaded(ORG, "u1", b.id, {});
    const out = await svc.importSubmissionResult(ORG, "u1", b.id, {
      results: [{ assessmentId: A1, status: "rejected" }],
    });
    expect(out.items.find((i) => i.assessmentId === A1)?.correctionAssessmentId).toBe(A4);
  });

  it("a missing package hash is a typed M10 conflict, not a plain Error", () => {
    try {
      manualUploadTransmittedPayload("sub-1", null, new Date());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ChartWardenError);
      expect((e as ChartWardenError).code).toBe("M10_SUBMISSION_PACKAGE_HASH_MISSING");
      expect((e as ChartWardenError).statusCode).toBe(409);
    }
  });
});
