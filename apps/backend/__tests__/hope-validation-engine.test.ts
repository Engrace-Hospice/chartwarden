import {
  HOPE_VALIDATION_RULES,
  REQUIRED_SECTIONS_BY_RFA,
  projectHopeSections,
  validateHopeAssessment,
  valueSetOracle,
} from "@chartwarden/hope";
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
    presentSections: REQUIRED_SECTIONS_BY_RFA["01_admission"],
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
  it.each([
    ["01_admission", "HA"],
    ["02_huv1", "HUV"],
    ["03_huv2", "HUV"],
    ["05_discharge", "HD"],
  ] as const)(
    "derives %s missing-section findings from the authoritative RFA matrix",
    (rfaKind, isc) => {
      const requiredSections = REQUIRED_SECTIONS_BY_RFA[rfaKind];
      const omittedSection = requiredSections.at(-1)!;
      const payload = Object.fromEntries(
        requiredSections
          .filter((section) => section !== omittedSection)
          .map((section) => [section, { completed: true }]),
      );
      const projection = projectHopeSections(payload);
      const activeItems = requiredSections.map((section) => ({
        itemCode: `${section}0001`,
        sectionLabel: section,
        kind: "assessment",
        cmsItemTypeCode: "Code",
      }));
      // The omitted Section has no payload key AND nothing answered in it: answered items document a Section too.
      const answers = answerMap(
        Object.fromEntries(
          activeItems
            .filter((item) => item.sectionLabel !== omittedSection)
            .map((item) => [item.itemCode, "1"]),
        ),
      );
      const base = ctx({}, "final");
      const context: HopeValidationContext = {
        ...base,
        assessment: { ...base.assessment, rfaKind, isc },
        presentSections: projection.presentSections,
        activeItems,
        answers,
        applicability: applicabilityEngine.evaluate({
          isc,
          activeItemCodes: activeItems.map((item) => item.itemCode),
          answers,
        }),
      };

      const missingSections = validationEngine
        .evaluate(context)
        .filter((finding) => finding.ruleId === HOPE_VALIDATION_RULES.REQUIRED_SECTION_MISSING);
      const submissionMissingSections = validateHopeAssessment(
        {
          rfaKind,
          dischargeReason: null,
          presentSections: projection.presentSections,
          sectionI: projection.sectionI,
          sectionJ: projection.sectionJ,
          sectionN: projection.sectionN,
          envelope: null,
        },
        valueSetOracle({ hospiceTerminalDiagnoses: [], hopeJCodes: [] }),
      ).filter((finding) => finding.ruleId === HOPE_VALIDATION_RULES.REQUIRED_SECTION_MISSING);

      expect(missingSections.map((finding) => finding.section)).toEqual(
        submissionMissingSections.map((finding) => finding.section),
      );
      expect(missingSections).toEqual([
        expect.objectContaining({
          section: omittedSection,
          severity: "error",
          findingKind: "missing_required",
          message: `Required Section ${omittedSection} is missing for RFA ${rfaKind}.`,
        }),
      ]);
      expect(missingSections[0]?.itemCode).toBeUndefined();
    },
  );

  describe("required Sections on an answers-only record", () => {
    // The imported CMS spec defines A, F, I, J, M, N and Z; the answers API never writes the stored payload.
    const SPEC_ITEMS = ["A", "F", "I", "J", "M", "N", "Z"].map((section) => `${section}0001`);

    function sectionsContext(input: {
      readonly rfaKind: "01_admission" | "02_huv1" | "04_sfv" | "05_discharge";
      readonly isc: "HA" | "HUV" | "HD" | "XX";
      readonly items: readonly string[];
      readonly sectionLabels?: Readonly<Record<string, string>>;
      readonly answered?: readonly string[];
      readonly skipped?: readonly string[];
      readonly otherKindAnswered?: readonly string[];
      readonly presentSections?: readonly string[];
    }): HopeValidationContext {
      const base = ctx({}, "final");
      const otherKind = input.otherKindAnswered ?? [];
      const activeItems = [
        ...input.items.map((itemCode) => ({
          itemCode,
          sectionLabel: input.sectionLabels?.[itemCode] ?? itemCode.slice(0, 1),
          kind: "assessment",
          cmsItemTypeCode: "Code",
        })),
        ...otherKind.map((itemCode) => ({
          itemCode,
          sectionLabel: itemCode.slice(0, 1),
          kind: "control",
          cmsItemTypeCode: "Code",
        })),
      ];
      const answers = new Map<string, { state: "answered" | "skipped"; value: string | null }>([
        ...[...(input.answered ?? []), ...otherKind].map(
          (itemCode) => [itemCode, { state: "answered" as const, value: "1" }] as const,
        ),
        ...(input.skipped ?? []).map(
          (itemCode) => [itemCode, { state: "skipped" as const, value: null }] as const,
        ),
      ]);
      return {
        ...base,
        assessment: { ...base.assessment, rfaKind: input.rfaKind, isc: input.isc },
        presentSections: input.presentSections ?? [],
        activeItems,
        answers,
        applicability: applicabilityEngine.evaluate({
          isc: input.isc,
          activeItemCodes: input.items,
          answers,
        }),
      };
    }

    const missingSections = (context: HopeValidationContext): readonly string[] =>
      validationEngine
        .evaluate(context)
        .filter((finding) => finding.ruleId === HOPE_VALIDATION_RULES.REQUIRED_SECTION_MISSING)
        .map((finding) => finding.section);

    it("finds no missing Section once every Section's items are answered, with no payload at all", () => {
      expect(REQUIRED_SECTIONS_BY_RFA["01_admission"]).toContain("B"); // the matrix lists letters the spec lacks
      expect(
        missingSections(
          sectionsContext({
            rfaKind: "01_admission",
            isc: "HA",
            items: SPEC_ITEMS,
            answered: SPEC_ITEMS,
          }),
        ),
      ).toEqual([]);
    });

    it("flags a Section the spec defines when nothing in it is answered and the payload lacks it", () => {
      expect(
        missingSections(
          sectionsContext({
            rfaKind: "01_admission",
            isc: "HA",
            items: SPEC_ITEMS,
            answered: SPEC_ITEMS.filter((itemCode) => !itemCode.startsWith("F")),
          }),
        ),
      ).toEqual(["F"]);
    });

    it("counts a skipped item as documenting its Section", () => {
      expect(
        missingSections(
          sectionsContext({
            rfaKind: "01_admission",
            isc: "HA",
            items: SPEC_ITEMS,
            answered: SPEC_ITEMS.filter((itemCode) => !itemCode.startsWith("F")),
            skipped: ["F0001"],
          }),
        ),
      ).toEqual([]);
    });

    it("still counts a Section the stored payload carries", () => {
      expect(
        missingSections(
          sectionsContext({
            rfaKind: "01_admission",
            isc: "HA",
            items: SPEC_ITEMS,
            answered: SPEC_ITEMS.filter((itemCode) => !itemCode.startsWith("F")),
            presentSections: ["F"],
          }),
        ),
      ).toEqual([]);
    });

    it("lets only assessment items document a Section", () => {
      expect(
        missingSections(
          sectionsContext({
            rfaKind: "01_admission",
            isc: "HA",
            items: SPEC_ITEMS,
            answered: SPEC_ITEMS.filter((itemCode) => !itemCode.startsWith("F")),
            otherKindAnswered: ["F9999"],
          }),
        ),
      ).toEqual(["F"]);
    });

    it("does not require a Section whose only item is the signature date the workflow answers at signing", () => {
      const withoutZ = SPEC_ITEMS.filter((itemCode) => !itemCode.startsWith("Z"));
      expect(
        missingSections(
          sectionsContext({
            rfaKind: "01_admission",
            isc: "HA",
            items: [...withoutZ, "Z0500B"],
            answered: withoutZ,
          }),
        ),
      ).toEqual([]);
    });

    it("still requires Section Z when it carries an item besides the signature date", () => {
      const withoutZ = SPEC_ITEMS.filter((itemCode) => !itemCode.startsWith("Z"));
      expect(
        missingSections(
          sectionsContext({
            rfaKind: "01_admission",
            isc: "HA",
            items: [...withoutZ, "Z0350", "Z0500B"],
            answered: withoutZ,
          }),
        ),
      ).toEqual(["Z"]);
    });

    it("reads the Section from the label however it is cased or padded, and from the item code when the label is empty", () => {
      const withoutF = SPEC_ITEMS.filter((itemCode) => !itemCode.startsWith("F"));
      const base = { rfaKind: "01_admission", isc: "HA" } as const;
      expect(
        missingSections(
          sectionsContext({
            ...base,
            items: SPEC_ITEMS,
            answered: SPEC_ITEMS,
            sectionLabels: { F0001: " f " },
          }),
        ),
      ).toEqual([]);
      expect(
        missingSections(
          sectionsContext({
            ...base,
            items: SPEC_ITEMS,
            answered: SPEC_ITEMS,
            sectionLabels: { F0001: "" },
          }),
        ),
      ).toEqual([]);
      expect(
        missingSections(
          sectionsContext({
            ...base,
            items: SPEC_ITEMS,
            answered: withoutF,
            sectionLabels: { F0001: "  " },
          }),
        ),
      ).toEqual(["F"]);
    });

    it("counts a Section as documented when every one of its items is skipped", () => {
      const withoutF = SPEC_ITEMS.filter((itemCode) => !itemCode.startsWith("F"));
      expect(
        missingSections(
          sectionsContext({
            rfaKind: "01_admission",
            isc: "HA",
            items: [...SPEC_ITEMS, "F0002"],
            answered: withoutF,
            skipped: ["F0001", "F0002"],
          }),
        ),
      ).toEqual([]);
    });

    it("still requires Section Z when its other item is unanswered and only the signature date is answered", () => {
      const withoutZ = SPEC_ITEMS.filter((itemCode) => !itemCode.startsWith("Z"));
      expect(
        missingSections(
          sectionsContext({
            rfaKind: "01_admission",
            isc: "HA",
            items: [...withoutZ, "Z0350", "Z0500B"],
            answered: [...withoutZ, "Z0500B"],
          }),
        ),
      ).toEqual(["Z"]);
    });

    // The shapes the imported spec really has: HD is A and Z0500B, HUV is A, J, M, N and Z0500B, SFV (XX) is A and Z0500B.
    it.each([
      ["05_discharge", "HD", ["A0001", "Z0500B"], ["A"]],
      ["02_huv1", "HUV", ["A0001", "J0001", "M0001", "N0001", "Z0500B"], ["A", "J", "M", "N"]],
      ["04_sfv", "XX", ["A0001", "Z0500B"], ["A"]],
    ] as const)(
      "requires only the Sections a %s record's instrument defines",
      (rfaKind, isc, items, definedSections) => {
        const answeredEverythingButTheSignatureDate = items.filter((item) => item !== "Z0500B");
        expect(
          missingSections(
            sectionsContext({
              rfaKind,
              isc,
              items,
              answered: answeredEverythingButTheSignatureDate,
            }),
          ),
        ).toEqual([]);
        for (const section of definedSections) {
          expect(
            missingSections(
              sectionsContext({
                rfaKind,
                isc,
                items,
                answered: answeredEverythingButTheSignatureDate.filter(
                  (item) => !item.startsWith(section),
                ),
              }),
            ),
          ).toEqual([section]);
        }
      },
    );

    it("holds a payload-only record (no active items) to the whole matrix", () => {
      expect(
        missingSections(
          sectionsContext({
            rfaKind: "01_admission",
            isc: "HA",
            items: [],
            presentSections: ["A"],
          }),
        ),
      ).toEqual(REQUIRED_SECTIONS_BY_RFA["01_admission"].filter((section) => section !== "A"));
    });

    it("applies the same rule to a discharge record", () => {
      expect(
        missingSections(
          sectionsContext({
            rfaKind: "05_discharge",
            isc: "HD",
            items: ["A0001", "Z0001"],
            answered: ["A0001", "Z0001"],
          }),
        ),
      ).toEqual([]);
    });
  });

  it("keeps generic item requiredness scoped by the authoritative matrix", () => {
    const answers = answerMap({});
    const activeItems = ["F2000A", "J2050A"].map((itemCode) => ({
      itemCode,
      sectionLabel: itemCode.slice(0, 1),
      kind: "assessment",
      cmsItemTypeCode: "Code",
    }));
    const base = ctx({}, "final");
    const context: HopeValidationContext = {
      ...base,
      assessment: { ...base.assessment, rfaKind: "05_discharge", isc: "HD" },
      presentSections: REQUIRED_SECTIONS_BY_RFA["05_discharge"],
      activeItems,
      answers,
      applicability: applicabilityEngine.evaluate({
        isc: "HD",
        activeItemCodes: activeItems.map((item) => item.itemCode),
        answers,
      }),
    };

    const requiredItems = validationEngine
      .evaluate(context)
      .filter((finding) => finding.ruleId === "CMS-HOPE-REQUIRED");

    expect(requiredItems.map((finding) => finding.itemCode)).toEqual(["J2050A"]);
  });

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
