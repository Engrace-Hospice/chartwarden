import { describe, expect, it } from "vitest";
import { createHopeApplicabilityEngine } from "../src/modules/10-hope/spec/applicability-registry";
import type { HopeValidationContext } from "../src/modules/10-hope/spec/validation";
import { createHopeValidationEngine } from "../src/modules/10-hope/spec/validation-registry";

function answerMap(values: Record<string, string>) {
  return new Map(
    Object.entries(values).map(([itemCode, value]) => [
      itemCode,
      { state: "answered" as const, value },
    ]),
  );
}

function ctx(values: Record<string, string>): HopeValidationContext {
  const answers = answerMap(values);
  const activeItems = Object.keys(values).map((itemCode) => ({
    itemCode,
    sectionLabel: itemCode.slice(0, 1),
    kind: "assessment" as const,
    cmsItemTypeCode:
      itemCode.endsWith("B") || itemCode === "A0220" || itemCode === "A0900" ? "Date" : "Code",
  }));
  return {
    mode: "final",
    assessment: {
      id: "hope-1",
      rfaKind: "01_admission",
      status: "draft",
      targetDate: "2025-10-01",
      specVersionId: "spec-1",
      specVersionCode: "1.00.1",
      isc: "HA",
      correctsAssessmentId: null,
    },
    activeItems,
    answers,
    applicability: createHopeApplicabilityEngine("1.00.1").evaluate({
      isc: "HA",
      activeItemCodes: activeItems.map((item) => item.itemCode),
      answers,
    }),
  };
}

describe("HOPE Admission readiness validation candidate", () => {
  it("evaluates fatal date-order rules against candidate Z0500B before signature persistence", () => {
    const findings = createHopeValidationEngine("1.00.1").evaluate(
      ctx({
        A0050: "1",
        A0220: "2025-10-10",
        A0250: "1",
        A0900: "1950-01-01",
        Z0500B: "2025-10-09",
      }),
    );

    expect(findings.map((finding) => finding.ruleId)).toContain("-3032");
  });

  it("allows warnings to remain nonblocking validation findings", () => {
    const findings = createHopeValidationEngine("1.00.1").evaluate(
      ctx({
        A0050: "1",
        A0220: "2025-10-10",
        A0250: "1",
        F2000A: "1",
        F2000B: "2025-10-01",
        Z0500B: "2025-10-11",
      }),
    );

    expect(findings.find((finding) => finding.ruleId === "-3063")?.severity).toBe("warning");
  });
});
