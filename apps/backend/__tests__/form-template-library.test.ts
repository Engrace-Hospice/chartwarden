import {
  FORM_TEMPLATE_REGISTRY,
  TemplateResolutionError,
  type TenantTemplateOverlay,
  V1_TEMPLATE_VERSION,
  findFormTemplate,
  listPlatformTemplates,
  resolveTemplate,
  validateOverlay,
} from "@wardenx/forms";
// apps/backend/__tests__/form-template-library.test.ts — M22-T05 §4.5 Form Template Library (D14/D16/D20/D21).
//
// Covers: the 31-key platform-floor catalog + versioning (D14); the golden-template-diff overlay validator
// (D16 — add-only branding passes; dropping a required field / widening / non-subset narrowing / removing a
// watermark are rejected with a field-level diff); render-time overlay resolution (defense-in-depth re-check);
// and the D20/D21 template-specific floors (lab-results required block; external-source discharge watermark +
// source-traceability fields the overlay can never drop).
import { describe, expect, it } from "vitest";

const ORG = "org-1";

describe("§4.5 platform-floor catalog (D14)", () => {
  it("ships the 31 v1 templates, all at version 1.0.0", () => {
    expect(FORM_TEMPLATE_REGISTRY).toHaveLength(31);
    expect(listPlatformTemplates()).toHaveLength(31);
    for (const t of FORM_TEMPLATE_REGISTRY) expect(t.version).toBe(V1_TEMPLATE_VERSION);
  });

  it("resolves a known key and returns undefined for an unknown one", () => {
    expect(findFormTemplate("cti")?.aggregateType).toBe("cti");
    expect(findFormTemplate("nope")).toBeUndefined();
  });

  it("D20: lab_results_pdf carries the result-values floor; D21: external-source carries its watermark + source fields", () => {
    const lab = findFormTemplate("lab_results_pdf")!;
    expect(lab.requiredFields).toContain("result_values_block");

    const ext = findFormTemplate("discharge_summary_v2_external_source")!;
    expect(ext.requiredWatermarks).toContain(
      "DISCHARGE RECORDED FROM EXTERNAL NOTIFICATION — PENDING MEDICAL DIRECTOR REVIEW",
    );
    expect(ext.requiredFields).toEqual(
      expect.arrayContaining(["source_facility_name", "source_proposal_id"]),
    );
  });
});

describe("§4.5 / D16 golden-template-diff validator", () => {
  it("accepts an add-only branding + body-text overlay (tighten-only)", () => {
    const overlay: TenantTemplateOverlay = {
      templateKey: "bereavement_letter",
      organizationId: ORG,
      version: 2,
      branding: { logoObjectKey: "tenant-org-1/logo.png", footerText: "From all of us" },
      bodyTextOverride: "Our deepest condolences.",
    };
    expect(validateOverlay(overlay)).toEqual({ ok: true });
  });

  it("rejects an overlay that DROPS a platform-required field (NPP wording)", () => {
    const overlay: TenantTemplateOverlay = {
      templateKey: "hipaa_privacy_notice",
      organizationId: ORG,
      version: 2,
      droppedFields: ["npp_required_wording"],
    };
    const res = validateOverlay(overlay);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.violations[0]).toMatchObject({
      kind: "dropped_required_field",
      field: "npp_required_wording",
    });
  });

  it("rejects an overlay that REMOVES a platform-required watermark (D16/D22)", () => {
    const overlay: TenantTemplateOverlay = {
      templateKey: "discharge_summary_v2_external_source",
      organizationId: ORG,
      version: 2,
      droppedWatermarks: [
        "DISCHARGE RECORDED FROM EXTERNAL NOTIFICATION — PENDING MEDICAL DIRECTOR REVIEW",
      ],
    };
    const res = validateOverlay(overlay);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.violations[0]?.kind).toBe("dropped_required_watermark");
  });

  it("rejects WIDENING a field value space (widening is loosening)", () => {
    const overlay: TenantTemplateOverlay = {
      templateKey: "code_status_directive",
      organizationId: ORG,
      version: 2,
      widenedFields: { code_status_field: ["full_code", "experimental_status"] },
    };
    const res = validateOverlay(overlay);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.violations[0]?.kind).toBe("widened_field");
  });

  it("ACCEPTS narrowing a tightenable field to a subset of the platform floor", () => {
    const overlay: TenantTemplateOverlay = {
      templateKey: "code_status_directive",
      organizationId: ORG,
      version: 2,
      narrowedFields: { code_status_field: ["full_code", "dnr"] },
    };
    expect(validateOverlay(overlay)).toEqual({ ok: true });
  });

  it("rejects narrowing to a NON-SUBSET (a value not in the platform floor)", () => {
    const overlay: TenantTemplateOverlay = {
      templateKey: "code_status_directive",
      organizationId: ORG,
      version: 2,
      narrowedFields: { code_status_field: ["full_code", "made_up"] },
    };
    const res = validateOverlay(overlay);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.violations[0]?.kind).toBe("narrowed_field_not_subset");
  });

  it("rejects narrowing a field that is not platform-tightenable", () => {
    const overlay: TenantTemplateOverlay = {
      templateKey: "cti",
      organizationId: ORG,
      version: 2,
      narrowedFields: { physician_signature_block: ["a"] },
    };
    const res = validateOverlay(overlay);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.violations[0]?.kind).toBe("narrowed_field_not_tightenable");
  });

  it("rejects an overlay for an unknown template", () => {
    const res = validateOverlay({ templateKey: "ghost", organizationId: ORG, version: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.violations[0]?.kind).toBe("unknown_template");
  });
});

describe("§4.5 resolveTemplate (render-time, defense-in-depth)", () => {
  it("resolves the bare platform floor with no overlay", () => {
    const r = resolveTemplate("cti");
    expect(r.key).toBe("cti");
    expect(r.version).toBe(V1_TEMPLATE_VERSION);
    expect(r.overlayVersion).toBeNull();
    expect(r.requiredFields).toContain("physician_signature_block");
  });

  it("applies a validated overlay's branding + narrowing; required floor carries through unchanged", () => {
    const r = resolveTemplate("code_status_directive", {
      templateKey: "code_status_directive",
      organizationId: ORG,
      version: 3,
      branding: { footerText: "tenant footer" },
      narrowedFields: { code_status_field: ["full_code", "dnr"] },
    });
    expect(r.overlayVersion).toBe(3);
    expect(r.branding?.footerText).toBe("tenant footer");
    expect(r.effectiveFieldValues.code_status_field).toEqual(["full_code", "dnr"]);
    // platform-required floor unchanged by the overlay
    expect(r.requiredFields).toContain("physician_signature_block");
  });

  it("REFUSES to render an overlay that loosens the floor (D16 render-time re-check / W8)", () => {
    expect(() =>
      resolveTemplate("hipaa_privacy_notice", {
        templateKey: "hipaa_privacy_notice",
        organizationId: ORG,
        version: 4,
        droppedFields: ["npp_required_wording"],
      }),
    ).toThrowError(TemplateResolutionError);
  });

  it("throws UNKNOWN_TEMPLATE for an unknown key", () => {
    try {
      resolveTemplate("ghost");
      throw new Error("unreachable");
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateResolutionError);
      expect((e as TemplateResolutionError).code).toBe("UNKNOWN_TEMPLATE");
    }
  });
});
