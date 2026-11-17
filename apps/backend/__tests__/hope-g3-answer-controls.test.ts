import { describe, expect, it, vi } from "vitest";
import { workflowControlAnswers } from "../src/modules/10-hope/hope-answer-service";
import { deriveHopeWorkflowControlAnswers } from "../src/modules/10-hope/hope-record-initializer";

// Group g3, round 3: `workflowControlAnswers` answers "no controls" ONLY for the one RFA kind that has none; any other
// failure reaches the caller (it used to be swallowed by a bare catch that returned null).
vi.mock("../src/modules/10-hope/hope-record-initializer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/10-hope/hope-record-initializer")>();
  return {
    ...actual,
    deriveHopeWorkflowControlAnswers: vi.fn(actual.deriveHopeWorkflowControlAnswers),
  };
});

const record = (rfaKind: string, isc: string | null = "HA") =>
  ({ rfaKind, isc, correctsAssessmentId: null }) as Parameters<typeof workflowControlAnswers>[0];

describe("workflowControlAnswers", () => {
  it("is null for an RFA-04 SFV completion, which is not an official CMS record kind", () => {
    expect(workflowControlAnswers(record("04_sfv"))).toBeNull();
  });

  it("derives A0050 and A0250 for an official kind", () => {
    expect(workflowControlAnswers(record("01_admission"))).toEqual([
      { itemCode: "A0050", value: "1" },
      { itemCode: "A0250", value: "1" },
    ]);
  });

  it("rethrows any other failure instead of reading it as 'this record carries no control answers'", () => {
    const defect = new TypeError("cannot read properties of undefined");
    vi.mocked(deriveHopeWorkflowControlAnswers).mockImplementationOnce(() => {
      throw defect;
    });

    expect(() => workflowControlAnswers(record("01_admission"))).toThrow(defect);
  });
});
