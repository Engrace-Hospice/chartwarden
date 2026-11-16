import { describe, expect, it } from "vitest";
import { EMPTY_SECTIONS, type SectionValues, buildHopeData } from "./hope-record-sections";

// The §2.1 payload is a pure function of what the clinician entered (the dialog's tests drive it through the form).

const with_ = (patch: Partial<SectionValues>): SectionValues => ({ ...EMPTY_SECTIONS, ...patch });

describe("buildHopeData", () => {
  it("says nothing was screened and nothing prescribed for an empty form, and writes no I and no Q", () => {
    expect(buildHopeData(EMPTY_SECTIONS, false)).toEqual({
      J: { J2030: { screened: "no" }, J2050: { screened: "no" } },
      N: { opioidPrescribed: false, scheduledBowelRegimen: false },
    });
  });

  it("writes the diagnosis trimmed and upper-cased, and Q only when the discharge needs it", () => {
    const data = buildHopeData(with_({ primaryDiagnosisIcd10: " c34.90 " }), true);

    expect(data.I).toEqual({ primaryDiagnosisIcd10: "C34.90" });
    expect(data.Q).toEqual({ participation: "documented_at_discharge" });
  });

  it("keeps characteristics only for a symptom that was screened, trimmed", () => {
    const screened = buildHopeData(
      with_({ painScreened: true, painCharacteristics: " sharp ", dyspneaCharacteristics: "x" }),
      false,
    );

    expect(screened.J?.J2030).toEqual({ screened: "yes", characteristics: "sharp" });
    expect(screened.J?.J2050).toEqual({ screened: "no" });
  });

  it("lists the severities in the roster's order and labels only the other symptom", () => {
    const data = buildHopeData(
      with_({
        severities: { other: "severe", pain: "mild", anxiety: "none" },
        otherSymptomLabel: " itch ",
      }),
      false,
    );

    expect(data.J?.J2051?.entries).toEqual([
      { symptomCode: "pain", severity: "mild" },
      { symptomCode: "anxiety", severity: "none" },
      { symptomCode: "other", severity: "severe", otherSymptomLabel: "itch" },
    ]);
  });

  it("asks for the regimen and its contraindication only for an opioid, and the contraindication only without a regimen", () => {
    const noOpioid = buildHopeData(
      with_({ scheduledBowelRegimen: true, bowelRegimenContraindication: "x" }),
      false,
    );
    const opioidNoRegimen = buildHopeData(
      with_({ opioidPrescribed: true, bowelRegimenContraindication: " ileus " }),
      false,
    );
    const opioidRegimen = buildHopeData(
      with_({
        opioidPrescribed: true,
        scheduledBowelRegimen: true,
        bowelRegimenContraindication: "x",
      }),
      false,
    );

    expect(noOpioid.N).toEqual({ opioidPrescribed: false, scheduledBowelRegimen: false });
    expect(opioidNoRegimen.N).toEqual({
      opioidPrescribed: true,
      scheduledBowelRegimen: false,
      bowelRegimenContraindication: "ileus",
    });
    expect(opioidRegimen.N).toEqual({ opioidPrescribed: true, scheduledBowelRegimen: true });
  });
});
