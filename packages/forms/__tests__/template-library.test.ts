// packages/forms/__tests__/template-library.test.ts — M22-T05 the §4.5 Form Template Library.
//
// Proves the platform-floor manifest: 31 templates, the key↔aggregateType mapping (incl. the D21 variants +
// the *_pdf / *_snapshot keys whose key ≠ aggregate type), the D23 SUD retention-upgrade rule, and the seven
// bereavement letterKind sub-layouts.
import { describe, expect, it } from "vitest";
import {
  BEREAVEMENT_LETTER_KINDS,
  FORM_TEMPLATE_LIBRARY,
  isKnownFormTemplate,
  lookupFormTemplate,
  resolveRenderRetentionClass,
} from "../src/index";

describe("Form Template Library (§4.5)", () => {
  it("ships the 31 v1 platform-floor templates with unique keys", () => {
    expect(FORM_TEMPLATE_LIBRARY).toHaveLength(31);
    const keys = FORM_TEMPLATE_LIBRARY.map((t) => t.key);
    expect(new Set(keys).size).toBe(31);
  });

  it("captures the key↔aggregateType mapping where the key is not the aggregate type", () => {
    expect(lookupFormTemplate("encounter_pdf")?.aggregateType).toBe("encounter");
    expect(lookupFormTemplate("lab_results_pdf")?.aggregateType).toBe("order_record");
    expect(lookupFormTemplate("emar_snapshot")?.aggregateType).toBe("medication_administration_record");
    expect(lookupFormTemplate("visit_confirmation_letter")?.aggregateType).toBe("visit_confirmation");
    // D21 — both external-source discharge variants instantiate the discharge_summary aggregate.
    expect(lookupFormTemplate("discharge_summary_v2_external_source")?.aggregateType).toBe("discharge_summary");
    expect(lookupFormTemplate("discharge_summary_v2_external_source_cosigned")?.aggregateType).toBe(
      "discharge_summary",
    );
  });

  it("carries the §4.5 engine / retention / patient-facing facts", () => {
    expect(lookupFormTemplate("consent_record")).toMatchObject({
      aggregateType: "consent_record",
      engine: "react_pdf",
      retentionClass: "compliance",
      patientFacing: true,
    });
    expect(lookupFormTemplate("idg_patient_packet")?.engine).toBe("puppeteer");
    expect(lookupFormTemplate("evv_verification")?.engine).toBe("puppeteer");
    expect(lookupFormTemplate("bereavement_letter")?.retentionClass).toBe("bereavement");
    expect(lookupFormTemplate("visit_confirmation_letter")?.retentionClass).toBe("operational");
    expect(lookupFormTemplate("cti")?.patientFacing).toBe(false);
  });

  it("resolves an unknown key to null and reports membership", () => {
    expect(lookupFormTemplate("not_a_template")).toBeNull();
    expect(isKnownFormTemplate("not_a_template")).toBe(false);
    expect(isKnownFormTemplate("lab_results_pdf")).toBe(true);
  });

  it("applies the D23 SUD retention upgrade to compliance_42cfr_part2", () => {
    // Floor class without SUD.
    expect(resolveRenderRetentionClass("lab_results_pdf")).toBe("clinical_record");
    expect(resolveRenderRetentionClass("lab_results_pdf", { sudClass: false })).toBe("clinical_record");
    // D23 — any SUD-class render upgrades to Part 2 regardless of the floor.
    expect(resolveRenderRetentionClass("lab_results_pdf", { sudClass: true })).toBe("compliance_42cfr_part2");
    expect(resolveRenderRetentionClass("discharge_summary", { sudClass: true })).toBe("compliance_42cfr_part2");
  });

  it("exposes the seven bereavement letterKind sub-layouts", () => {
    expect(BEREAVEMENT_LETTER_KINDS).toHaveLength(7);
    expect(BEREAVEMENT_LETTER_KINDS).toContain("complicated_grief_referral");
    expect(BEREAVEMENT_LETTER_KINDS).toContain("opt_out_confirmation");
  });
});
