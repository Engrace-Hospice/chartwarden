// @wardenx/emar — §2.4 D3 PRN reassessment trigger — M13-T04.
import { describe, expect, it } from "vitest";
import {
  REASSESSMENT_WINDOW_DEFAULT_BY_CATEGORY,
  buildPrnReassessmentTrigger,
  computeReassessmentDueAt,
  recommendReassessmentScale,
  resolveReassessmentWindowMinutes,
} from "../src/prn";

const ADMINISTERED = "2026-06-22T14:35:00.000Z";

describe("§2.4 recommendReassessmentScale", () => {
  it("analgesic → ESAS-r pain (the breakthrough-pain fixture)", () => {
    expect(recommendReassessmentScale("analgesic")).toEqual({ scale: "esas_r", item: "pain" });
  });
  it("antipsychotic with dementia context → PAINAD; else agitation-observed", () => {
    expect(recommendReassessmentScale("antipsychotic", { hasDementiaContext: true })).toEqual({
      scale: "painad",
      item: null,
    });
    expect(recommendReassessmentScale("antipsychotic")).toEqual({
      scale: "agitation_observed",
      item: null,
    });
  });
  it("anxiolytic → ESAS-r anxiety item; antiemetic → ESAS-r nausea item", () => {
    expect(recommendReassessmentScale("anxiolytic")).toEqual({ scale: "esas_r", item: "anxiety" });
    expect(recommendReassessmentScale("antiemetic")).toEqual({ scale: "esas_r", item: "nausea" });
  });
  it("other → no recommendation", () => {
    expect(recommendReassessmentScale("other")).toEqual({ scale: null, item: null });
  });
});

describe("§2.4 resolveReassessmentWindowMinutes (order → tenant → category)", () => {
  it("the order policy wins when positive", () => {
    expect(
      resolveReassessmentWindowMinutes({
        orderWindowMinutes: 45,
        tenantDefaultMinutes: 90,
        category: "analgesic",
      }),
    ).toBe(45);
  });
  it("falls through to the tenant default when the order omits it", () => {
    expect(
      resolveReassessmentWindowMinutes({
        orderWindowMinutes: null,
        tenantDefaultMinutes: 90,
        category: "analgesic",
      }),
    ).toBe(90);
  });
  it("falls through to the per-category default (breakthrough-pain 30, sedating 120)", () => {
    expect(resolveReassessmentWindowMinutes({ category: "analgesic" })).toBe(30);
    expect(resolveReassessmentWindowMinutes({ category: "antipsychotic" })).toBe(120);
    expect(resolveReassessmentWindowMinutes({ category: "anxiolytic" })).toBe(120);
    expect(resolveReassessmentWindowMinutes({ category: "other" })).toBe(60);
    expect(REASSESSMENT_WINDOW_DEFAULT_BY_CATEGORY.analgesic).toBe(30);
  });
  it("ignores a non-positive / non-finite candidate at any tier", () => {
    expect(
      resolveReassessmentWindowMinutes({
        orderWindowMinutes: 0,
        tenantDefaultMinutes: -5,
        category: "antiemetic",
      }),
    ).toBe(60);
  });
});

describe("§2.4 computeReassessmentDueAt", () => {
  it("administeredAt + windowMinutes", () => {
    expect(computeReassessmentDueAt(ADMINISTERED, 30)).toBe("2026-06-22T15:05:00.000Z");
  });
});

describe("§2.4 D3 buildPrnReassessmentTrigger", () => {
  const base = {
    prnAdministrationId: "prn-1",
    administrationRecordId: "adm-1",
    patientId: "pat-1",
    admissionId: "adm-x",
    medicationOrderId: "ord-1",
    administeredAt: ADMINISTERED,
  };

  it("assembles the m13.prn_administration_recorded payload (the §5 breakthrough-pain fixture)", () => {
    const t = buildPrnReassessmentTrigger({ ...base, category: "analgesic" });
    expect(t).toMatchObject({
      prnAdministrationId: "prn-1",
      administrationRecordId: "adm-1",
      patientId: "pat-1",
      medicationOrderId: "ord-1",
      administeredAt: ADMINISTERED,
      reassessmentWindowMinutes: 30,
      reassessmentDueAt: "2026-06-22T15:05:00.000Z",
      recommendedScale: "esas_r",
      recommendedScaleItem: "pain",
    });
  });

  it("the order's window overrides the category default", () => {
    const t = buildPrnReassessmentTrigger({
      ...base,
      category: "analgesic",
      orderWindowMinutes: 60,
    });
    expect(t.reassessmentWindowMinutes).toBe(60);
    expect(t.reassessmentDueAt).toBe("2026-06-22T15:35:00.000Z");
  });

  it("carries no PHI — only IDs + the deadline + the scale id", () => {
    const t = buildPrnReassessmentTrigger({ ...base, category: "anxiolytic" });
    expect(Object.keys(t).sort()).toEqual(
      [
        "administeredAt",
        "administrationRecordId",
        "admissionId",
        "medicationOrderId",
        "patientId",
        "prnAdministrationId",
        "reassessmentDueAt",
        "reassessmentWindowMinutes",
        "recommendedScale",
        "recommendedScaleItem",
      ].sort(),
    );
  });
});
