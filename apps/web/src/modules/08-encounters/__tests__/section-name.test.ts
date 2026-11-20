// How a section id reads on the screens that have no template (sign notice, signed note, amendment pickers): ids in words, and the
// acronym ids by the template's own headings, never "Pps" or "F2f attestation" (ADR-0114 S2). Synthetic data only.
import { describe, expect, it } from "vitest";
import { ORIGIN_LABEL } from "../draft-model";
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

  it("does not take a name from the object prototype", () => {
    expect(humanizeSection("constructor")).toBe("Constructor");
  });
});

describe("ORIGIN_LABEL", () => {
  it("does not claim a level of care the benefit-period sentence may leave out", () => {
    expect(ORIGIN_LABEL.benefit_period).toContain("when one applies");
  });
});
