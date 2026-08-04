// apps/backend/__tests__/assessment-eraser.test.ts — M9-T07 the `clinical_assessment` eraser (§8.4, D7/D8)
// + the M22 assessment-summary PDF forward-seam deny-stub (§12 forward seam). Proves M9 registers the REAL
// clinical_assessment eraser over the Phase-0 deny-stub (validateErasers passes at boot), the eraser locks the
// patient then deletes the child rows + the assessment rows (active AND superseded) WITHOUT touching the
// org-level license/policy tables, and the M22 PDF stub fails closed until M22 lands (Wave F).
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetErasersForTest,
  getEraser,
  validateErasers,
} from "../src/bootstrap/erasers/registry";
import { buildServer } from "../src/bootstrap/index";
import { wireModuleErasers, wireModuleSeams } from "../src/index";
import {
  denyStubAssessmentSummaryPdfRenderer,
  eraseAssessmentRecord,
  createInMemoryAssessmentEraseStore as makeEraseStore,
  registerAssessmentErasers,
} from "../src/modules/09-assessments/index";

describe("M9-T07 — clinical_assessment eraser (§8.4, D7/D8)", () => {
  beforeEach(() => __resetErasersForTest());

  it("locks the patient, deletes child rows then the assessment rows, reports the total", async () => {
    const { store, locked } = makeEraseStore({
      cosignatures: 2,
      significantChangeEvents: 3,
      assessments: 5, // active + superseded, §8.4 #2
    });
    const { erased, counts } = await eraseAssessmentRecord("org_a", "pat_1", store);
    expect(erased).toBe(10);
    expect(counts.assessments).toBe(5);
    expect(counts.significantChangeEvents).toBe(3);
    expect(locked).toEqual(["pat_1"]); // advisory lock acquired before the deletes (§8.4 #1)
  });

  it("is idempotent — a second erase removes nothing", async () => {
    const { store } = makeEraseStore({ cosignatures: 1, assessments: 2 });
    expect((await eraseAssessmentRecord("org_a", "pat_1", store)).erased).toBe(3);
    expect((await eraseAssessmentRecord("org_a", "pat_1", store)).erased).toBe(0);
  });

  it("registers over the deny-stub; the boot hook makes validateErasers() pass for the data class", async () => {
    registerAssessmentErasers({ store: makeEraseStore({ assessments: 1 }).store });
    const r = await getEraser("clinical_assessment").erase({ orgId: "org_a" }, "pat_1");
    expect(r.erased).toBe(1);
  });

  it("a real buildServer() boot wires the eraser so validateErasers() passes", async () => {
    const app = buildServer({
      registerModuleSeams: wireModuleSeams,
      registerModuleErasers: wireModuleErasers,
    });
    expect(() => validateErasers()).not.toThrow();
    const r = await getEraser("clinical_assessment").erase({ orgId: "org_a" }, "pat_unseeded");
    expect(r.erased).toBe(0);
    await app.close();
  });
});

describe("M9-T07 — M22 assessment-summary PDF forward seam (deny-stub; §12 forward seam)", () => {
  it("fails closed with M22_NOT_BOUND until M22 lands (Wave F)", async () => {
    const result = await denyStubAssessmentSummaryPdfRenderer.render("org_a", {
      patientId: "pat_1",
      generatedAt: "2026-06-22T00:00:00.000Z",
      scales: [
        {
          scaleType: "pps",
          score: 60,
          scoreInterpretation: "decline",
          capturedAt: "2026-06-20T00:00:00.000Z",
        },
      ],
    });
    expect(result).toEqual({ available: false, reason: "M22_NOT_BOUND" });
  });
});
