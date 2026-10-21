// @chartwarden/hope — CMS HOPE pre-submission validation engine (§2.3, §3, §86) — M10-T04.
import { describe, expect, it } from "vitest";
import { REQUIRED_SECTIONS_BY_RFA, missingRequiredSections } from "../src/sections/required-items";
import { HOPE_VALIDATION_RULES, hasBlockingError } from "../src/validation/findings";
import {
  type HopeAssessmentValidationInput,
  validateHopeAssessment,
} from "../src/validation/validate-hope-assessment";
import { valueSetOracle } from "../src/validation/value-set-oracle";

const ORACLE = valueSetOracle({
  hospiceTerminalDiagnoses: ["G30.9", "I50.9", "C34.90"],
  hopeJCodes: ["J2030", "J2050", "J2051", "PAIN", "DYSPNEA"],
});

/** A clean, fully-populated comprehensive Admission assessment that produces zero findings. */
function cleanAdmission(): HopeAssessmentValidationInput {
  return {
    rfaKind: "01_admission",
    dischargeReason: null,
    presentSections: [...REQUIRED_SECTIONS_BY_RFA["01_admission"]],
    sectionI: { primaryDiagnosisIcd10: "G30.9" },
    sectionJ: {
      painScreenedYes: true,
      painCharacteristicsPresent: true,
      dyspneaScreenedYes: false,
      dyspneaCharacteristicsPresent: false,
      jCodes: ["J2030", "J2051"],
    },
    sectionN: {
      opioidPrescribed: true,
      scheduledBowelRegimenPresent: true,
      bowelRegimenContraindicationDocumented: false,
    },
    envelope: {
      assessmentCcn: "381588",
      admissionCcnAtElection: "381588",
      assessmentMbi: "1EG4-TE5-MK73",
      patientMbiSnapshot: "1EG4-TE5-MK73",
    },
  };
}

describe("required-items matrix", () => {
  it("covers every RFA and the comprehensive set includes Q", () => {
    expect(REQUIRED_SECTIONS_BY_RFA["01_admission"]).toContain("Q");
    expect(REQUIRED_SECTIONS_BY_RFA["04_sfv"]).toEqual(["A", "J", "Z"]);
    // Discharge does NOT flat-require Q (handled by the conditional D9 rule).
    expect(REQUIRED_SECTIONS_BY_RFA["05_discharge"]).not.toContain("Q");
  });

  it("reports missing required sections in matrix order", () => {
    expect(missingRequiredSections("04_sfv", ["A", "Z"])).toEqual(["J"]);
    expect(missingRequiredSections("04_sfv", ["A", "J", "Z"])).toEqual([]);
  });
});

describe("validateHopeAssessment — clean assessment", () => {
  it("a fully-populated comprehensive Admission yields zero findings", () => {
    expect(validateHopeAssessment(cleanAdmission(), ORACLE)).toEqual([]);
  });
});

describe("validateHopeAssessment — required items (§2.3)", () => {
  it("flags each missing required section as a blocking error", () => {
    const input = { ...cleanAdmission(), presentSections: ["A", "Z"] };
    const findings = validateHopeAssessment(input, ORACLE);
    const missing = findings.filter(
      (f) => f.ruleId === HOPE_VALIDATION_RULES.REQUIRED_SECTION_MISSING,
    );
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((f) => f.severity === "error")).toBe(true);
    expect(hasBlockingError(findings)).toBe(true);
  });
});

describe("validateHopeAssessment — Section I value set (§86)", () => {
  it("errors when the primary diagnosis is not in the M38 hospice-terminal value set", () => {
    const input = { ...cleanAdmission(), sectionI: { primaryDiagnosisIcd10: "Z99.9" } };
    const f = validateHopeAssessment(input, ORACLE).find(
      (x) => x.ruleId === HOPE_VALIDATION_RULES.SECTION_I_DIAGNOSIS_NOT_IN_VALUE_SET,
    );
    expect(f).toMatchObject({ severity: "error", section: "I", itemCode: "Z99.9" });
  });

  it("is case/space-insensitive and skips the check for the focused SFV", () => {
    const ok = validateHopeAssessment(
      { ...cleanAdmission(), sectionI: { primaryDiagnosisIcd10: " g30.9 " } },
      ORACLE,
    );
    expect(
      ok.some((f) => f.ruleId === HOPE_VALIDATION_RULES.SECTION_I_DIAGNOSIS_NOT_IN_VALUE_SET),
    ).toBe(false);
    // SFV carries no diagnosis section → no diagnosis value-set finding even with a bogus code.
    const sfv = validateHopeAssessment(
      {
        ...cleanAdmission(),
        rfaKind: "04_sfv",
        presentSections: ["A", "J", "Z"],
        sectionI: { primaryDiagnosisIcd10: "BOGUS" },
      },
      ORACLE,
    );
    expect(
      sfv.some((f) => f.ruleId === HOPE_VALIDATION_RULES.SECTION_I_DIAGNOSIS_NOT_IN_VALUE_SET),
    ).toBe(false);
  });
});

describe("validateHopeAssessment — Section J value set + cross-field (§86, M10-F07)", () => {
  it("warns (does not block) on an unrecognised J-code", () => {
    const input = {
      ...cleanAdmission(),
      sectionJ: { ...cleanAdmission().sectionJ, jCodes: ["J2030", "J9999"] },
    };
    const findings = validateHopeAssessment(input, ORACLE);
    const f = findings.find(
      (x) => x.ruleId === HOPE_VALIDATION_RULES.SECTION_J_CODE_NOT_IN_VALUE_SET,
    );
    expect(f).toMatchObject({ severity: "warning", section: "J", itemCode: "J9999" });
    expect(hasBlockingError(findings)).toBe(false);
  });

  it("errors when J2030=Yes but pain characteristics are absent", () => {
    const input = {
      ...cleanAdmission(),
      sectionJ: {
        ...cleanAdmission().sectionJ,
        painScreenedYes: true,
        painCharacteristicsPresent: false,
      },
    };
    const f = validateHopeAssessment(input, ORACLE).find(
      (x) => x.ruleId === HOPE_VALIDATION_RULES.J2030_PAIN_CHARACTERISTICS_MISSING,
    );
    expect(f).toMatchObject({ severity: "error", itemCode: "J2030" });
  });

  it("errors when J2050=Yes but dyspnea characteristics are absent", () => {
    const input = {
      ...cleanAdmission(),
      sectionJ: {
        ...cleanAdmission().sectionJ,
        dyspneaScreenedYes: true,
        dyspneaCharacteristicsPresent: false,
      },
    };
    const f = validateHopeAssessment(input, ORACLE).find(
      (x) => x.ruleId === HOPE_VALIDATION_RULES.J2050_DYSPNEA_CHARACTERISTICS_MISSING,
    );
    expect(f).toMatchObject({ severity: "error", itemCode: "J2050" });
  });
});

describe("validateHopeAssessment — Section N bowel regimen (§2.3)", () => {
  it("warns when opioid is prescribed without a bowel regimen or contraindication", () => {
    const input = {
      ...cleanAdmission(),
      sectionN: {
        opioidPrescribed: true,
        scheduledBowelRegimenPresent: false,
        bowelRegimenContraindicationDocumented: false,
      },
    };
    const f = validateHopeAssessment(input, ORACLE).find(
      (x) => x.ruleId === HOPE_VALIDATION_RULES.SECTION_N_BOWEL_REGIMEN_MISSING,
    );
    expect(f).toMatchObject({ severity: "warning", section: "N" });
  });

  it("a documented contraindication satisfies the rule", () => {
    const input = {
      ...cleanAdmission(),
      sectionN: {
        opioidPrescribed: true,
        scheduledBowelRegimenPresent: false,
        bowelRegimenContraindicationDocumented: true,
      },
    };
    expect(
      validateHopeAssessment(input, ORACLE).some(
        (x) => x.ruleId === HOPE_VALIDATION_RULES.SECTION_N_BOWEL_REGIMEN_MISSING,
      ),
    ).toBe(false);
  });
});

describe("validateHopeAssessment — Discharge Section Q (D9)", () => {
  const baseDischarge = (): HopeAssessmentValidationInput => ({
    ...cleanAdmission(),
    rfaKind: "05_discharge",
    presentSections: [...REQUIRED_SECTIONS_BY_RFA["05_discharge"]],
  });

  it("death-discharge with Q present is a forbidden-section error", () => {
    const input = {
      ...baseDischarge(),
      dischargeReason: "death" as const,
      presentSections: [...REQUIRED_SECTIONS_BY_RFA["05_discharge"], "Q"],
    };
    const f = validateHopeAssessment(input, ORACLE).find(
      (x) => x.ruleId === HOPE_VALIDATION_RULES.SECTION_Q_FORBIDDEN,
    );
    expect(f).toMatchObject({ severity: "error", section: "Q" });
  });

  it("live-discharge without Q is a required-section error", () => {
    const input = { ...baseDischarge(), dischargeReason: "live_discharge" as const };
    const f = validateHopeAssessment(input, ORACLE).find(
      (x) => x.ruleId === HOPE_VALIDATION_RULES.SECTION_Q_REQUIRED,
    );
    expect(f).toMatchObject({ severity: "error", section: "Q" });
  });

  it("death-discharge without Q is clean for the Q rule", () => {
    const input = { ...baseDischarge(), dischargeReason: "death" as const };
    expect(
      validateHopeAssessment(input, ORACLE).some(
        (x) =>
          x.ruleId === HOPE_VALIDATION_RULES.SECTION_Q_FORBIDDEN ||
          x.ruleId === HOPE_VALIDATION_RULES.SECTION_Q_REQUIRED,
      ),
    ).toBe(false);
  });
});

describe("validateHopeAssessment — cross-RFA temporal order (§2.3)", () => {
  it("errors when HUV1 is not after Admission", () => {
    const input: HopeAssessmentValidationInput = {
      ...cleanAdmission(),
      rfaKind: "02_huv1",
      temporal: {
        targetDate: "2026-06-10T00:00:00.000Z",
        admissionTargetDate: "2026-06-10T00:00:00.000Z",
      },
    };
    const f = validateHopeAssessment(input, ORACLE).find(
      (x) => x.ruleId === HOPE_VALIDATION_RULES.CROSS_RFA_TEMPORAL_ORDER,
    );
    expect(f).toMatchObject({ severity: "error" });
  });

  it("is clean when HUV2 is after HUV1", () => {
    const input: HopeAssessmentValidationInput = {
      ...cleanAdmission(),
      rfaKind: "03_huv2",
      temporal: {
        targetDate: "2026-06-25T00:00:00.000Z",
        huv1TargetDate: "2026-06-15T00:00:00.000Z",
      },
    };
    expect(
      validateHopeAssessment(input, ORACLE).some(
        (x) => x.ruleId === HOPE_VALIDATION_RULES.CROSS_RFA_TEMPORAL_ORDER,
      ),
    ).toBe(false);
  });
});

describe("validateHopeAssessment — iQIES envelope (§2.3)", () => {
  it("errors on CCN mismatch and MBI mismatch", () => {
    const input = {
      ...cleanAdmission(),
      envelope: {
        assessmentCcn: "999999",
        admissionCcnAtElection: "381588",
        assessmentMbi: "WRONG",
        patientMbiSnapshot: "1EG4-TE5-MK73",
      },
    };
    const findings = validateHopeAssessment(input, ORACLE);
    expect(findings.some((f) => f.ruleId === HOPE_VALIDATION_RULES.ENVELOPE_CCN_MISMATCH)).toBe(
      true,
    );
    expect(findings.some((f) => f.ruleId === HOPE_VALIDATION_RULES.ENVELOPE_MBI_MISMATCH)).toBe(
      true,
    );
    expect(hasBlockingError(findings)).toBe(true);
  });
});
