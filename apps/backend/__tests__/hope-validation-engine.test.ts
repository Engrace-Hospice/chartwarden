import { describe, expect, it } from "vitest";
import { createHopeApplicabilityEngine } from "../src/modules/10-hope/spec/applicability-registry";
import type { HopeValidationContext } from "../src/modules/10-hope/spec/validation";
import { createHopeValidationEngine } from "../src/modules/10-hope/spec/validation-registry";

const applicabilityEngine = createHopeApplicabilityEngine("1.00.1");
const validationEngine = createHopeValidationEngine("1.00.1");
const active = [
  "A0050",
  "A0220",
  "A0250",
  "A0900",
  "A1005A",
  "A1005B",
  "A1010A",
  "A1010Z",
  "A1400A",
  "A1400B",
  "A1400C",
  "A1400D",
  "F2000A",
  "F2000B",
  "F2100A",
  "F2100B",
  "F2200A",
  "F2200B",
  "F3000A",
  "F3000B",
  "J0900A",
  "J0900B",
  "J0900C",
  "J0900D",
  "J0905",
  "J0910A",
  "J0910B",
  "J0910C1",
  "J0910C9",
  "J2030A",
  "J2030B",
  "J2030C",
  "J2040A",
  "J2040B",
  "J2050A",
  "J2050B",
  "J2051A",
  "J2051B",
  "J2051C",
  "J2051D",
  "J2051E",
  "J2051F",
  "J2051G",
  "J2051H",
  "J2052A",
  "J2052B",
  "J2052C",
  "J2053A",
  "J2053H",
  "M1190",
  "M1195A",
  "M1195Z",
  "M1200A",
  "M1200Z",
  "N0500A",
  "N0500B",
  "N0510A",
  "N0510B",
  "N0520A",
  "N0520B",
  "Z0350",
  "Z0500B",
];

function answerMap(values: Record<string, string>) {
  return new Map(
    Object.entries(values).map(([itemCode, value]) => [
      itemCode,
      { state: "answered" as const, value },
    ]),
  );
}

function ctx(
  values: Record<string, string>,
  mode: "draft" | "final" = "draft",
): HopeValidationContext {
  const answers = answerMap(values);
  return {
    mode,
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
    activeItems: active.map((itemCode) => ({
      itemCode,
      sectionLabel: itemCode.slice(0, 1),
      kind: "assessment",
      cmsItemTypeCode: itemCode.endsWith("B") ? "Date" : "Code",
    })),
    answers,
    applicability: applicabilityEngine.evaluate({ isc: "HA", activeItemCodes: active, answers }),
  };
}

function ruleIds(values: Record<string, string>, mode: "draft" | "final" = "draft") {
  return validationEngine.evaluate(ctx(values, mode)).map((finding) => finding.ruleId);
}

function huvContext(values: Record<string, string>): HopeValidationContext {
  const huvActive = active.filter(
    (itemCode) => !itemCode.startsWith("A1005") && !itemCode.startsWith("A1010"),
  );
  const answers = answerMap(values);
  const base = ctx(values, "final");
  return {
    ...base,
    assessment: {
      ...base.assessment,
      rfaKind: "02_huv1",
      isc: "HUV",
    },
    activeItems: huvActive.map((itemCode) => ({
      itemCode,
      sectionLabel: itemCode.slice(0, 1),
      kind: "assessment",
      cmsItemTypeCode: itemCode.endsWith("B") ? "Date" : "Code",
    })),
    answers,
    applicability: applicabilityEngine.evaluate({
      isc: "HUV",
      activeItemCodes: huvActive,
      answers,
    }),
  };
}

describe("HOPE v1.00.1 validation engine", () => {
  it("uses stable fingerprints for repeat evaluations", () => {
    const first = validationEngine.evaluate(ctx({ J0910C1: "1", J0910C9: "1" }));
    const second = validationEngine.evaluate(ctx({ J0910C1: "1", J0910C9: "1" }));
    expect(first.find((finding) => finding.ruleId === "-3041")?.fingerprint).toBe("-3041:J0910C9");
    expect(second.find((finding) => finding.ruleId === "-3041")?.fingerprint).toBe("-3041:J0910C9");
  });

  it("detects Section F branch consistency and pre-admission timing warning", () => {
    expect(ruleIds({ A0220: "2025-10-10", F2000A: "0", F2000B: "2025-10-01" })).toContain("-3035");
    expect(ruleIds({ A0220: "2025-10-10", F2000A: "1", F2000B: "2025-10-01" })).toContain("-3063");
  });

  it("enforces the CMS A0600A SSN format edits", () => {
    expect(ruleIds({ A0600A: "12345678A" })).toContain("-3015"); // digits only
    expect(ruleIds({ A0600A: "123-45-6789" })).toContain("-3015"); // dashes are not digits
    expect(ruleIds({ A0600A: "12345678" })).toContain("-3001"); // exactly 9
    expect(ruleIds({ A0600A: "000123456" })).toContain("-3002"); // not 000-prefixed
    expect(ruleIds({ A0600A: "123456789" })).toContain("-3003"); // rejected placeholder
    const clean = ruleIds({ A0600A: "909673453" });
    for (const id of ["-3015", "-3001", "-3002", "-3003"]) expect(clean).not.toContain(id);
    expect(ruleIds({ A0600A: "^" })).not.toContain("-3001"); // the CMS blank value
  });

  it("detects mutually exclusive checklist choices", () => {
    expect(ruleIds({ A1005A: "1", A1005B: "1" })).toContain("-3080");
    expect(ruleIds({ A1010A: "1", A1010Z: "1" })).toContain("-3090");
    expect(ruleIds({ M1195A: "1", M1195Z: "1" })).toContain("-3094");
    expect(ruleIds({ M1200A: "1", M1200Z: "1" })).toContain("-3095");
  });

  it("does not require HA-only ethnicity or race items for HUV1", () => {
    const findings = validationEngine.evaluate(huvContext({}));
    const ruleIdsForHuv = findings.map((finding) => finding.ruleId);

    expect(ruleIdsForHuv).not.toContain("-3080");
    expect(ruleIdsForHuv).not.toContain("-3090");
    expect(ruleIds({}, "final")).toEqual(expect.arrayContaining(["-3080", "-3090"]));
  });

  it("detects pain and SFV branch validation without trusting persisted projections", () => {
    expect(ruleIds({ J0900C: "2", J0905: "0" })).toContain("-3076");
    expect(ruleIds({ J2050A: "1", J2051A: "2" }, "final")).toContain("-3108");
    expect(
      ruleIds({
        J2050A: "1",
        J2051A: "2",
        J2052A: "1",
        J2052B: "2025-10-05",
        J2050B: "2025-10-01",
      }),
    ).toContain("-3105");
  });

  it("detects opioid / bowel-regimen consistency and warnings", () => {
    expect(ruleIds({ N0500A: "1" }, "final")).toContain("-3049");
    expect(ruleIds({ N0500A: "0", N0510A: "0", N0520A: "1" })).toContain("-3060");
    expect(ruleIds({ N0500A: "1", J0905: "0" })).toContain("-3077");
  });

  it("detects record identity and date-order consistency", () => {
    expect(ruleIds({ A0050: "1", A0250: "2" })).toContain("WX-HOPE-RECORD-001");
    expect(ruleIds({ A0050: "2", A0250: "1" })).toContain("WX-HOPE-RECORD-002");
    expect(ruleIds({ A0220: "2025-10-10", Z0500B: "2025-10-09" })).toContain("-3032");
  });
});
