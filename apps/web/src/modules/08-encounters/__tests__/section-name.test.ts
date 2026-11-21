// How a section id reads on the screens that have no template (sign notice, signed note, amendment pickers): ids in words, and the
// acronym ids by the template's own headings, never "Pps" or "F2f attestation" (ADR-0114 S2). Synthetic data only.
import { describe, expect, it } from "vitest";
import { ORIGIN_LABEL, originsText } from "../draft-model";
import { humanizeSection } from "../sign-draft-notice";

describe("humanizeSection", () => {
  it("reads an ordinary id as words", () => {
    expect(humanizeSection("vitals_review")).toBe("Vitals review");
    expect(humanizeSection("plan")).toBe("Plan");
  });

  it("reads the acronym ids of the recertification and face-to-face templates by their headings", () => {
    expect(humanizeSection("pps")).toBe("Palliative Performance Status");
    expect(humanizeSection("esas")).toBe("Symptom Assessment (ESAS)");
    expect(humanizeSection("recert_summary")).toBe("Recertification Summary");
    expect(humanizeSection("f2f_attestation")).toBe("Face-to-Face Attestation");
  });

  it("reads the admission visit's four drafted sections by their template headings", () => {
    expect(humanizeSection("med_reconciliation")).toBe("Medication Reconciliation");
    expect(humanizeSection("advance_directive")).toBe("Advance Directive Acknowledgment");
    expect(humanizeSection("caregiver_overview")).toBe("Caregiver Overview");
    expect(humanizeSection("baseline_symptoms")).toBe("Baseline Symptoms");
  });

  it("reads the aide visit's drafted section by its template heading, never as 'Adl'", () => {
    expect(humanizeSection("adl")).toBe("Activities of Daily Living");
  });

  it("does not take a name from the object prototype", () => {
    expect(humanizeSection("constructor")).toBe("Constructor");
  });
});

describe("ORIGIN_LABEL", () => {
  it("says when the admission visit's facts were on record: at the visit, never as of today", () => {
    expect(ORIGIN_LABEL.medication_order).toContain("at the visit");
    expect(ORIGIN_LABEL.caregiver).toContain("on the visit date");
    expect(ORIGIN_LABEL.advance_directive_acknowledgment).toContain("at the visit");
  });

  it("claims no clinical judgement about the admission visit's records", () => {
    for (const kind of [
      "medication_order",
      "caregiver",
      "advance_directive_acknowledgment",
    ] as const) {
      expect(ORIGIN_LABEL[kind]).not.toMatch(/reconcil|verified|complete/i);
    }
  });

  it("says the aide's drafted section leads with the ADLs recorded at the visit, before the care-plan interventions", () => {
    expect(originsText(["recorded_adl", "care_plan_intervention"])).toBe(
      "the activities of daily living recorded at this visit; care plan interventions",
    );
  });

  it("does not claim a level of care the benefit-period sentence may leave out", () => {
    expect(ORIGIN_LABEL.benefit_period).toContain("when one applies");
  });
});
