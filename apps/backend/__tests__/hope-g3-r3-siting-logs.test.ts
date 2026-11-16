import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { HopeValidationFindingSitingError } from "../src/modules/10-hope/hope-validation-service";
import { scriptedDb } from "./_hope-g3-fake-db";

// Group g3, round 3: a draft with no provider entity / location siting cannot have its draft-mode validation findings
// stored. The answer patch and the HUV completion date carry on (the siting gap is the ordinary case for such a draft),
// but each leaves a line naming the assessment and the org instead of swallowing the error silently on every autosave.
const mocks = vi.hoisted(() => ({
  validateAssessment: vi.fn(),
  patchAnswers: vi.fn(),
  setWorkflowAnswer: vi.fn(),
}));

vi.mock("../src/modules/10-hope/hope-validation-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/10-hope/hope-validation-service")>();
  return {
    ...actual,
    createHopeValidationService: () => ({ validateAssessment: mocks.validateAssessment }),
  };
});
vi.mock("../src/modules/10-hope/hope-answer-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/10-hope/hope-answer-service")>();
  return {
    ...actual,
    createHopeAssessmentAnswerService: () => ({
      patchAnswers: mocks.patchAnswers,
      setWorkflowAnswer: mocks.setWorkflowAnswer,
    }),
  };
});

const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const ASSESSMENT = "abcdef01-2345-4678-89ab-cdef01234567";

let warn: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mocks.validateAssessment.mockReset();
  mocks.patchAnswers.mockReset();
  mocks.setWorkflowAnswer.mockReset();
});
afterEach(() => warn.mockRestore());
const warned = (): string => warn.mock.calls.map((call) => String(call[0])).join("\n");

const patched = { assessmentId: ASSESSMENT, version: 2, answers: [] };
const patchInput = { ifVersion: 1, changes: [] } as never;

describe("patchAssessmentAnswers — the draft validation that follows the write", () => {
  it("a siting gap does not fail the patch, and leaves one line with the assessment and the org", async () => {
    mocks.patchAnswers.mockResolvedValue(patched);
    mocks.validateAssessment.mockRejectedValue(new HopeValidationFindingSitingError(ASSESSMENT));
    const svc = createDbHopeBackend(scriptedDb([]).db);

    await expect(svc.patchAssessmentAnswers(ORG, MEMBERSHIP, ASSESSMENT, patchInput)).resolves.toBe(
      patched,
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()).toContain(`assessment ${ASSESSMENT} (org ${ORG})`);
    expect(warned()).toContain("siting");
  });

  it("is quiet when the findings are stored, and rethrows any other failure", async () => {
    mocks.patchAnswers.mockResolvedValue(patched);
    const svc = createDbHopeBackend(scriptedDb([]).db);

    mocks.validateAssessment.mockResolvedValue(undefined);
    await svc.patchAssessmentAnswers(ORG, MEMBERSHIP, ASSESSMENT, patchInput);
    expect(warn).not.toHaveBeenCalled();

    const defect = new Error("validation exploded");
    mocks.validateAssessment.mockRejectedValue(defect);
    await expect(svc.patchAssessmentAnswers(ORG, MEMBERSHIP, ASSESSMENT, patchInput)).rejects.toBe(
      defect,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("setHuvCompletionDate — the draft validation that follows the date change", () => {
  const huvDraft = { id: ASSESSMENT, rfaKind: "02_huv1", isc: "HUV", status: "draft", version: 3 };
  const script = [[huvDraft], [{ status: "draft", version: 3 }], [{ version: 4 }]] as const;
  const input = { ifVersion: 3, z0350: "2026-06-03" } as never;

  it("a siting gap does not fail the change, and leaves one line with the assessment and the org", async () => {
    mocks.setWorkflowAnswer.mockResolvedValue({ itemCode: "Z0350" });
    mocks.validateAssessment.mockRejectedValue(new HopeValidationFindingSitingError(ASSESSMENT));
    const svc = createDbHopeBackend(scriptedDb(script).db);

    await expect(
      svc.setHuvCompletionDate(ORG, MEMBERSHIP, ASSESSMENT, input),
    ).resolves.toMatchObject({
      assessmentId: ASSESSMENT,
      version: 4,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()).toContain(`assessment ${ASSESSMENT} (org ${ORG})`);
  });

  it("rethrows any other validation failure", async () => {
    mocks.setWorkflowAnswer.mockResolvedValue({ itemCode: "Z0350" });
    const defect = new Error("validation exploded");
    mocks.validateAssessment.mockRejectedValue(defect);
    const svc = createDbHopeBackend(scriptedDb(script).db);

    await expect(svc.setHuvCompletionDate(ORG, MEMBERSHIP, ASSESSMENT, input)).rejects.toBe(defect);
    expect(warn).not.toHaveBeenCalled();
  });
});
