import { SCALE_TYPES } from "@wardenx/types";
// packages/assessments/__tests__/eligibility.test.ts — M9-T05 the D8 discipline × scale eligibility
// matrix (§4.7). Pins the load-bearing examples the spec fixes (§ Design decisions D8) and the
// fail-closed behavior the recording gate + ABAC predicate rely on.
import { describe, expect, it } from "vitest";
import {
  SCALE_DISCIPLINE_ELIGIBILITY,
  anyDisciplineCanRecordScale,
  disciplineCanRecordScale,
  scalesRecordableBy,
} from "../src/eligibility";

describe("M9-T05 — discipline × scale eligibility (D8)", () => {
  it("covers every canonical scale type", () => {
    for (const s of SCALE_TYPES) {
      expect(SCALE_DISCIPLINE_ELIGIBILITY[s].length).toBeGreaterThan(0);
    }
  });

  it("prognostic instruments (NYHA / MELD / BODE / Flacker) are MD/NP-only", () => {
    for (const s of ["nyha", "meld", "bode", "flacker"] as const) {
      expect(disciplineCanRecordScale("md", s)).toBe(true);
      expect(disciplineCanRecordScale("np", s)).toBe(true);
      expect(disciplineCanRecordScale("rn", s)).toBe(false);
      expect(disciplineCanRecordScale("chaplain", s)).toBe(false);
    }
  });

  it("PPS / KPS / FAST allow RN + MD/NP + LPN (LPN under §7.4 cosign)", () => {
    for (const s of ["pps", "kps", "fast"] as const) {
      expect(disciplineCanRecordScale("rn", s)).toBe(true);
      expect(disciplineCanRecordScale("lpn", s)).toBe(true);
      expect(disciplineCanRecordScale("md", s)).toBe(true);
      expect(disciplineCanRecordScale("chaplain", s)).toBe(false);
    }
  });

  it("Braden + Morse are broad-discipline; AIMS is RN + MD/NP only", () => {
    expect(disciplineCanRecordScale("chha", "braden")).toBe(true);
    expect(disciplineCanRecordScale("chha", "morse")).toBe(true);
    expect(disciplineCanRecordScale("rn", "aims")).toBe(true);
    expect(disciplineCanRecordScale("chaplain", "aims")).toBe(false);
    expect(disciplineCanRecordScale("chha", "aims")).toBe(false);
  });

  it("is case-insensitive and fails closed on an unknown discipline", () => {
    expect(disciplineCanRecordScale("RN", "pps")).toBe(true);
    expect(disciplineCanRecordScale("nurse_aide", "braden")).toBe(false);
  });

  it("anyDisciplineCanRecordScale qualifies when one of several disciplines is eligible", () => {
    expect(anyDisciplineCanRecordScale(["chaplain", "rn"], "aims")).toBe(true);
    expect(anyDisciplineCanRecordScale(["chaplain", "volunteer"], "aims")).toBe(false);
  });

  it("scalesRecordableBy returns only the scales a discipline may record", () => {
    const rnScales = scalesRecordableBy("rn");
    expect(rnScales).toContain("pps");
    expect(rnScales).not.toContain("nyha");
  });
});
