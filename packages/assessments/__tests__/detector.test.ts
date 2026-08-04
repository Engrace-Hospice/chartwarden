// @wardenx/assessments — §2.4 significant-change detector + D2 tenant-override floor enforcement (M9-T08,
// test plan §9.1: "per rule, fixed input pairs at the threshold boundary — just-below, at, just-above").
import { describe, expect, it } from "vitest";
import {
  SIGNIFICANT_CHANGE_THRESHOLDS,
  detectSignificantChanges,
  resolveSignificantChangeThreshold,
} from "../src/detector";

const at = (day: string) => `2026-06-${day}T12:00:00.000Z`;

describe("detectSignificantChanges — absolute boundary rules (§9.1 just-below / at / just-above)", () => {
  it("painad_ge_4 fires AT the threshold and just-above, never just-below", () => {
    expect(
      detectSignificantChanges({ scaleType: "painad", score: 3, capturedAt: at("20") }),
    ).toHaveLength(0);
    const atEdge = detectSignificantChanges({
      scaleType: "painad",
      score: 4,
      capturedAt: at("20"),
    });
    expect(atEdge).toHaveLength(1);
    expect(atEdge[0]).toMatchObject({ ruleId: "painad_ge_4", deltaValue: 4, thresholdValue: 4 });
    expect(
      detectSignificantChanges({ scaleType: "painad", score: 5, capturedAt: at("20") }),
    ).toHaveLength(1);
  });

  it("morse_ge_51 fires at 51 (high fall risk), not at 50", () => {
    expect(
      detectSignificantChanges({ scaleType: "morse", score: 50, capturedAt: at("20") }),
    ).toHaveLength(0);
    expect(
      detectSignificantChanges({ scaleType: "morse", score: 51, capturedAt: at("20") }),
    ).toHaveLength(1);
  });

  it("braden_le_12 fires AT and below the threshold (a `≤` rule), never above — and is CRITICAL", () => {
    expect(
      detectSignificantChanges({ scaleType: "braden", score: 13, capturedAt: at("20") }),
    ).toHaveLength(0);
    const atEdge = detectSignificantChanges({
      scaleType: "braden",
      score: 12,
      capturedAt: at("20"),
    });
    expect(atEdge[0]).toMatchObject({ ruleId: "braden_le_12", severity: "clinical_urgent" });
    expect(
      detectSignificantChanges({ scaleType: "braden", score: 11, capturedAt: at("20") }),
    ).toHaveLength(1);
  });

  it("esas_symptom_ge_7 keys on the single worst per-item score, not the total", () => {
    expect(
      detectSignificantChanges({
        scaleType: "esas_r",
        score: 30,
        maxSymptomScore: 6,
        capturedAt: at("20"),
      }),
    ).toHaveLength(0);
    const fired = detectSignificantChanges({
      scaleType: "esas_r",
      score: 12,
      maxSymptomScore: 7,
      capturedAt: at("20"),
    });
    expect(fired.some((f) => f.ruleId === "esas_symptom_ge_7")).toBe(true);
  });
});

describe("detectSignificantChanges — windowed delta rules (drop / increase)", () => {
  it("pps_drop_20_in_14d fires on a ≥20 drop inside the window and is CRITICAL", () => {
    const priorSeries = [{ score: 70, capturedAt: at("10") }];
    expect(
      detectSignificantChanges({ scaleType: "pps", score: 51, capturedAt: at("20"), priorSeries }),
    ).toHaveLength(0); // drop 19 < 20
    const fired = detectSignificantChanges({
      scaleType: "pps",
      score: 50,
      capturedAt: at("20"),
      priorSeries,
    });
    expect(fired[0]).toMatchObject({
      ruleId: "pps_drop_20_in_14d",
      deltaValue: 20,
      thresholdValue: 20,
      severity: "clinical_urgent",
    });
  });

  it("a drop OUTSIDE the 14-day window does not fire (window pruning)", () => {
    const priorSeries = [{ score: 80, capturedAt: at("01") }]; // 19 days before — out of window
    expect(
      detectSignificantChanges({ scaleType: "pps", score: 40, capturedAt: at("20"), priorSeries }),
    ).toHaveLength(0);
  });

  it("uses the worst (highest) prior in-window as the drop baseline", () => {
    const priorSeries = [
      { score: 60, capturedAt: at("12") },
      { score: 80, capturedAt: at("14") }, // the baseline a drop is measured from
    ];
    const fired = detectSignificantChanges({
      scaleType: "pps",
      score: 55,
      capturedAt: at("20"),
      priorSeries,
    });
    expect(fired[0]).toMatchObject({ ruleId: "pps_drop_20_in_14d", deltaValue: 25 });
  });

  it("esas_total_increase_20_in_7d fires on a ≥20 total worsening from the in-window low", () => {
    const priorSeries = [{ score: 15, capturedAt: at("16") }];
    expect(
      detectSignificantChanges({
        scaleType: "esas_r",
        score: 34,
        capturedAt: at("20"),
        priorSeries,
      }).some((f) => f.ruleId === "esas_total_increase_20_in_7d"),
    ).toBe(false); // +19
    expect(
      detectSignificantChanges({
        scaleType: "esas_r",
        score: 35,
        capturedAt: at("20"),
        priorSeries,
      }).some((f) => f.ruleId === "esas_total_increase_20_in_7d"),
    ).toBe(true); // +20
  });

  it("a first-ever reading (no prior series) never fires a delta rule", () => {
    expect(
      detectSignificantChanges({ scaleType: "pps", score: 30, capturedAt: at("20") }),
    ).toHaveLength(0);
  });
});

describe("resolveSignificantChangeThreshold — D2 floor enforcement (§9.1)", () => {
  it("a tenant CANNOT set painad ≥ 3 when the floor is ≥ 4 — the override is rejected", () => {
    expect(() => resolveSignificantChangeThreshold("painad_ge_4", 3)).toThrowError(/floor/i);
  });

  it("painad is pinned (floor === platform): even a stricter-looking raise to ≥ 5 is a loosening reject", () => {
    expect(() => resolveSignificantChangeThreshold("painad_ge_4", 5)).toThrowError(
      /loosen|tighten/i,
    );
    expect(resolveSignificantChangeThreshold("painad_ge_4", 4)).toBe(4); // the floor value is accepted
  });

  it("a delta rule may TIGHTEN within [floor, platform] but never loosen above the platform default", () => {
    expect(resolveSignificantChangeThreshold("pps_drop_20_in_14d", 15)).toBe(15); // tighter (smaller drop)
    expect(() => resolveSignificantChangeThreshold("pps_drop_20_in_14d", 25)).toThrowError(
      /loosen|tighten/i,
    );
    expect(() => resolveSignificantChangeThreshold("pps_drop_20_in_14d", 5)).toThrowError(/floor/i);
  });

  it("with no override the platform default holds for every numeric rule", () => {
    for (const [ruleId, t] of Object.entries(SIGNIFICANT_CHANGE_THRESHOLDS)) {
      expect(resolveSignificantChangeThreshold(ruleId as never)).toBe(t!.platform);
    }
  });
});

describe("detectSignificantChanges — tenant override applied at detection time", () => {
  it("a tightened painad floor (still 4, the only legal value) fires at 4", () => {
    const fired = detectSignificantChanges({
      scaleType: "painad",
      score: 4,
      capturedAt: at("20"),
      overrides: { painad_ge_4: 4 },
    });
    expect(fired).toHaveLength(1);
  });

  it("a tightened pps drop override (15) fires on a 15-point decline that the platform 20 would miss", () => {
    const priorSeries = [{ score: 60, capturedAt: at("12") }];
    expect(
      detectSignificantChanges({ scaleType: "pps", score: 45, capturedAt: at("20"), priorSeries }),
    ).toHaveLength(0); // drop 15 < platform 20
    const fired = detectSignificantChanges({
      scaleType: "pps",
      score: 45,
      capturedAt: at("20"),
      priorSeries,
      overrides: { pps_drop_20_in_14d: 15 },
    });
    expect(fired[0]).toMatchObject({
      ruleId: "pps_drop_20_in_14d",
      deltaValue: 15,
      thresholdValue: 15,
    });
  });
});
