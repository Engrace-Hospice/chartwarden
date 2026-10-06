import { describe, expect, it } from "vitest";
import { areAllDimensionsComplete, isDimensionComplete } from "./mortality-form";

describe("mortality form completeness", () => {
  it("requires every required select and treats an unanswered select as incomplete", () => {
    expect(isDimensionComplete("clinical", {})).toBe(false);
    expect(
      isDimensionComplete("clinical", {
        symptomManagementAdequacy: "adequate",
        painControlAdequacy: "partial",
        endOfLifeCarePlanExecution: "exemplary",
      }),
    ).toBe(true);
  });

  it("counts a false boolean as an answer but not a missing one", () => {
    expect(
      isDimensionComplete("satisfaction", {
        caregiverConcernsFlagged: false,
        followUpPlanRecorded: false,
      }),
    ).toBe(true);
    expect(isDimensionComplete("satisfaction", { caregiverConcernsFlagged: false })).toBe(false);
  });

  it("is complete only when all three dimensions are", () => {
    const compliance = {
      faceToFaceWindowCompliance: "met",
      ctiTimeliness: "met",
      hopeSubmissionStatus: "not_met",
      emarCompletenessFinal7Days: "not_applicable",
      idgDecisionsCaptured: "met",
    };
    expect(areAllDimensionsComplete({ clinical: {}, satisfaction: {}, compliance })).toBe(false);
  });
});
