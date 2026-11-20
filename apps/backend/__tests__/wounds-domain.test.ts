// apps/backend/__tests__/wounds-domain.test.ts — M9 longitudinal wounds: the pure domain in @chartwarden/assessments
// (site vocabulary, observation validation, computed area and percent change). No database, no HTTP.
import {
  WOUND_SITES,
  WoundStateError,
  WoundValidationError,
  assertCorrectable,
  assertValidWound,
  assertValidWoundObservation,
  assertWoundOpen,
  lateralityFitsSite,
  percentAreaChange,
  siteLabel,
  validateObservedAt,
  validateWound,
  validateWoundObservation,
  validateWoundResolution,
  withComputedMeasures,
  woundAreaCm2,
} from "@chartwarden/assessments";
import { describe, expect, it } from "vitest";

const codes = (etiology: Parameters<typeof validateWoundObservation>[0], fields = {}) =>
  validateWoundObservation(etiology, fields).map((v) => v.code);

describe("wound site vocabulary", () => {
  it("has unique codes and a catch-all", () => {
    // Arrange
    const all = WOUND_SITES.map((s) => s.code);
    // Assert
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain("other");
    expect(all.length).toBeGreaterThanOrEqual(28);
  });

  it.each([
    ["heel", "left", "left heel"],
    ["heel", "right", "right heel"],
    ["heel", "bilateral", "bilateral heels"],
    ["sacrum", "midline", "sacrum"],
    ["calf_shin", "left", "left calf"],
    ["sacral_perineal", "midline", "sacral/perineal area"],
  ] as const)("siteLabel(%s, %s) reads %s", (site, laterality, expected) => {
    expect(siteLabel(site, laterality)).toBe(expected);
  });

  it("renders a stored row with an unknown site code instead of throwing", () => {
    expect(siteLabel("retired_code", "left")).toBe("left other site");
  });

  it("accepts a laterality only where the site has sides", () => {
    expect(lateralityFitsSite("heel", "left")).toBe(true);
    expect(lateralityFitsSite("heel", "midline")).toBe(false);
    expect(lateralityFitsSite("sacrum", "midline")).toBe(true);
    expect(lateralityFitsSite("sacrum", "left")).toBe(false);
    expect(lateralityFitsSite("other", "left")).toBe(true);
    expect(lateralityFitsSite("not_a_site", "left")).toBe(false);
  });
});

describe("validateWound", () => {
  const base = { siteCode: "heel", laterality: "left", etiology: "pressure_injury" } as const;

  it("accepts a coded wound", () => {
    expect(validateWound(base, "2026-11-19")).toEqual([]);
  });

  it("rejects a site and laterality that do not fit", () => {
    expect(validateWound({ ...base, siteCode: "sacrum" }, "2026-11-19").map((v) => v.code)).toEqual(
      ["WOUND_SITE_LATERALITY_MISMATCH"],
    );
  });

  it("rejects an onset date in the future", () => {
    expect(
      validateWound({ ...base, onsetOn: "2026-12-01" }, "2026-11-19").map((v) => v.code),
    ).toEqual(["WOUND_ONSET_IN_FUTURE"]);
  });

  it("assertValidWound throws a 422 carrying the rule code", () => {
    // Act
    const act = () => assertValidWound({ ...base, siteCode: "sacrum" }, "2026-11-19");
    // Assert
    expect(act).toThrow(WoundValidationError);
    try {
      act();
    } catch (e) {
      expect(e).toMatchObject({ code: "WOUND_SITE_LATERALITY_MISMATCH", statusCode: 422 });
    }
  });
});

describe("validateWoundObservation", () => {
  it("accepts a complete, coherent pressure-injury observation", () => {
    expect(
      codes("pressure_injury", {
        stage: "stage_3",
        lengthCm: 4.2,
        widthCm: 3,
        depthCm: 0.8,
        undermining: false,
        woundBed: ["granulation", "slough"],
        exudateAmount: "moderate",
        exudateType: "serous",
        odor: "none",
        periwound: ["erythema", "warm"],
        painScore: 4,
        dressing: "foam",
        dressingChanged: true,
        infectionSigns: false,
        trend: "improving",
      }),
    ).toEqual([]);
  });

  it("accepts an observation with nothing recorded but the visit", () => {
    expect(codes("venous_ulcer")).toEqual([]);
  });

  it("allows a stage on a pressure injury only", () => {
    expect(codes("pressure_injury", { stage: "stage_2" })).toEqual([]);
    expect(codes("venous_ulcer", { stage: "stage_2" })).toEqual(["WOUND_STAGE_NOT_APPLICABLE"]);
  });

  it("requires length and width before a depth", () => {
    expect(codes("surgical", { depthCm: 1 })).toEqual(["WOUND_DEPTH_REQUIRES_AREA"]);
    expect(codes("surgical", { depthCm: 1, lengthCm: 2 })).toEqual(["WOUND_DEPTH_REQUIRES_AREA"]);
    expect(codes("surgical", { depthCm: 1, lengthCm: 2, widthCm: 2 })).toEqual([]);
  });

  it("requires a dressing when it was changed, and allows no dressing when it was not", () => {
    expect(codes("surgical", { dressingChanged: true })).toEqual(["WOUND_DRESSING_REQUIRED"]);
    expect(codes("surgical", { dressingChanged: true, dressing: "gauze" })).toEqual([]);
    expect(codes("surgical", { dressingChanged: false })).toEqual([]);
  });

  it.each([
    [{ lengthCm: -0.1 }],
    [{ widthCm: 100.1 }],
    [{ lengthCm: 2, widthCm: 2, depthCm: 30.1 }],
    [{ lengthCm: Number.NaN }],
    [{ lengthCm: 2.25 }],
  ])("rejects an out-of-range or over-precise measurement %j", (fields) => {
    expect(codes("surgical", fields)).toContain("WOUND_MEASUREMENT_RANGE");
  });

  it("accepts a zero measurement (a closed wound)", () => {
    expect(codes("surgical", { lengthCm: 0, widthCm: 0 })).toEqual([]);
  });

  it.each([[-1], [11], [2.5]])("rejects a pain score of %s", (painScore) => {
    expect(codes("surgical", { painScore })).toEqual(["WOUND_PAIN_RANGE"]);
  });

  it("keeps intact periwound skin from sitting beside a finding", () => {
    expect(codes("surgical", { periwound: ["intact"] })).toEqual([]);
    expect(codes("surgical", { periwound: ["intact", "erythema"] })).toEqual([
      "WOUND_PERIWOUND_INTACT_EXCLUSIVE",
    ]);
  });

  it("rejects a repeated bed tissue or periwound condition", () => {
    expect(codes("surgical", { woundBed: ["slough", "slough"] })).toEqual(["WOUND_BED_DUPLICATE"]);
    expect(codes("surgical", { periwound: ["warm", "warm"] })).toEqual([
      "WOUND_PERIWOUND_DUPLICATE",
    ]);
  });

  it("reports every violated rule, in a fixed order", () => {
    expect(
      codes("surgical", { stage: "stage_1", depthCm: 1, dressingChanged: true, painScore: 12 }),
    ).toEqual([
      "WOUND_STAGE_NOT_APPLICABLE",
      "WOUND_DEPTH_REQUIRES_AREA",
      "WOUND_PAIN_RANGE",
      "WOUND_DRESSING_REQUIRED",
    ]);
  });

  it("assertValidWoundObservation throws the first violation as a 422", () => {
    try {
      assertValidWoundObservation("surgical", { stage: "stage_1" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WoundValidationError);
      expect(e).toMatchObject({ code: "WOUND_STAGE_NOT_APPLICABLE", statusCode: 422 });
    }
  });
});

describe("computed measures (display only, never stored)", () => {
  it("area is length times width, null when either is missing, free of float noise", () => {
    expect(woundAreaCm2(3.2, 2.1)).toBe(6.72);
    expect(woundAreaCm2(null, 2)).toBeNull();
    expect(woundAreaCm2(2, undefined)).toBeNull();
    expect(woundAreaCm2(0, 0)).toBe(0);
  });

  it("percent change is negative when the wound shrank, one decimal, null without a baseline", () => {
    expect(percentAreaChange(10, 7.5)).toBe(-25);
    expect(percentAreaChange(4, 5)).toBe(25);
    expect(percentAreaChange(3, 2)).toBe(-33.3);
    expect(percentAreaChange(0, 2)).toBeNull();
    expect(percentAreaChange(null, 2)).toBeNull();
    expect(percentAreaChange(2, null)).toBeNull();
  });

  it("annotates a series against the last earlier observation that has an area", () => {
    // Arrange: oldest first, with an unmeasured visit in the middle
    const series = [
      { id: "a", observedAt: "2026-11-01T10:00:00.000Z", lengthCm: 4, widthCm: 2.5 },
      { id: "b", observedAt: "2026-11-04T10:00:00.000Z", lengthCm: null, widthCm: null },
      { id: "c", observedAt: "2026-11-08T10:00:00.000Z", lengthCm: 3, widthCm: 2.5 },
    ];
    // Act
    const out = withComputedMeasures(series);
    // Assert
    expect(out.map((o) => o.areaCm2)).toEqual([10, null, 7.5]);
    expect(out.map((o) => o.areaChangePercent)).toEqual([null, null, -25]);
    expect(out[2]?.areaChangeSinceObservedAt).toBe("2026-11-01T10:00:00.000Z");
    expect(out[0]?.areaChangeSinceObservedAt).toBeNull();
  });

  it("does not depend on the order it is handed the series", () => {
    const series = [
      { id: "c", observedAt: "2026-11-08T10:00:00.000Z", lengthCm: 3, widthCm: 2.5 },
      { id: "a", observedAt: "2026-11-01T10:00:00.000Z", lengthCm: 4, widthCm: 2.5 },
    ];
    expect(withComputedMeasures(series).map((o) => o.id)).toEqual(["a", "c"]);
  });
});

describe("validateWoundResolution", () => {
  it("accepts a close date between the onset and today", () => {
    expect(
      validateWoundResolution({ onsetOn: "2026-10-01", closedOn: "2026-11-10" }, "2026-11-19"),
    ).toEqual([]);
    expect(
      validateWoundResolution({ onsetOn: null, closedOn: "2026-11-19" }, "2026-11-19"),
    ).toEqual([]);
  });

  it("rejects a close date before the onset or in the future", () => {
    expect(
      validateWoundResolution({ onsetOn: "2026-10-01", closedOn: "2026-09-30" }, "2026-11-19").map(
        (v) => v.code,
      ),
    ).toEqual(["WOUND_CLOSED_BEFORE_ONSET"]);
    expect(
      validateWoundResolution({ onsetOn: null, closedOn: "2026-11-20" }, "2026-11-19").map(
        (v) => v.code,
      ),
    ).toEqual(["WOUND_CLOSE_IN_FUTURE"]);
  });
});

describe("validateObservedAt", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");

  it("accepts a past instant and a few minutes of clock skew", () => {
    expect(validateObservedAt("2026-11-18T08:00:00.000Z", now)).toEqual([]);
    expect(validateObservedAt("2026-11-19T12:03:00.000Z", now)).toEqual([]);
  });

  it("rejects an observation dated later than the skew allowance", () => {
    expect(validateObservedAt("2026-11-19T12:30:00.000Z", now).map((v) => v.code)).toEqual([
      "WOUND_OBSERVED_IN_FUTURE",
    ]);
  });

  it("rejects an observation dated before 2000-01-01, and accepts the first instant of 2000", () => {
    expect(validateObservedAt("1999-12-31T23:59:59.999Z", now).map((v) => v.code)).toEqual([
      "WOUND_OBSERVED_IMPLAUSIBLY_EARLY",
    ]);
    expect(validateObservedAt("1900-06-01T00:00:00.000Z", now).map((v) => v.code)).toEqual([
      "WOUND_OBSERVED_IMPLAUSIBLY_EARLY",
    ]);
    expect(validateObservedAt("2000-01-01T00:00:00.000Z", now)).toEqual([]);
  });

  it("treats an instant that does not parse as out of range", () => {
    expect(validateObservedAt("not a date", now).map((v) => v.code)).toEqual([
      "WOUND_OBSERVED_IMPLAUSIBLY_EARLY",
    ]);
  });

  describe("against the wound's onset date", () => {
    it("rejects an observation dated before the onset (a day of time-zone slack aside)", () => {
      expect(validateObservedAt("2026-10-15T10:00:00.000Z", now, "2026-11-01")).toEqual([
        expect.objectContaining({ code: "WOUND_OBSERVED_BEFORE_ONSET" }),
      ]);
      expect(validateObservedAt("2026-10-30T23:59:59.999Z", now, "2026-11-01")).toEqual([
        expect.objectContaining({ code: "WOUND_OBSERVED_BEFORE_ONSET" }),
      ]);
    });

    it("accepts the onset day itself, up to a day before it (a western zone), and anything later", () => {
      expect(validateObservedAt("2026-11-01T00:00:00.000Z", now, "2026-11-01")).toEqual([]);
      expect(validateObservedAt("2026-10-31T00:00:00.000Z", now, "2026-11-01")).toEqual([]);
      expect(validateObservedAt("2026-11-10T09:00:00.000Z", now, "2026-11-01")).toEqual([]);
    });

    it("has no lower bound but 2000 when the onset is unknown", () => {
      expect(validateObservedAt("2026-01-01T00:00:00.000Z", now, null)).toEqual([]);
      expect(validateObservedAt("2026-01-01T00:00:00.000Z", now, undefined)).toEqual([]);
    });

    it("reports the future bound first", () => {
      expect(validateObservedAt("2026-12-25T00:00:00.000Z", now, "2026-11-01")[0]?.code).toBe(
        "WOUND_OBSERVED_IN_FUTURE",
      );
    });
  });
});

describe("wound state rules", () => {
  it("lets an observation be added only to an open wound", () => {
    expect(() => assertWoundOpen("open")).not.toThrow();
    expect(() => assertWoundOpen("healed")).toThrow(WoundStateError);
    expect(() => assertWoundOpen("resolved_other")).toThrow(
      expect.objectContaining({ code: "WOUND_NOT_OPEN", statusCode: 409 }),
    );
  });

  it("corrects only the active observation the caller read (If-Match)", () => {
    expect(() => assertCorrectable({ status: "active", version: 1 }, 1)).not.toThrow();
    expect(() => assertCorrectable({ status: "active", version: 2 }, 1)).toThrow(
      expect.objectContaining({ code: "STALE_VERSION", statusCode: 409 }),
    );
    expect(() => assertCorrectable({ status: "superseded", version: 2 }, 2)).toThrow(
      expect.objectContaining({ code: "CORRECTION_TARGET_NOT_ACTIVE", statusCode: 409 }),
    );
  });
});
