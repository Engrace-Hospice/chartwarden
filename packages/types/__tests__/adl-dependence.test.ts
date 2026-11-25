// packages/types/__tests__/adl-dependence.test.ts -- the ADL dependence score (visit-note Functional Status panel and the note's
// functional-status sentence share it). Pure; synthetic levels only.
import { describe, expect, it } from "vitest";
import {
  ADL_DEPENDENCE_LOWER_THRESHOLD,
  ADL_DEPENDENCE_UPPER_THRESHOLD,
  ADL_DEPENDENT_LEVELS,
  ADL_NOT_DEPENDENT_LEVELS,
  adlDependenceBand,
  scoreAdlDependence,
  statesAdlItemLevel,
} from "../src/adl-dependence";

const ORDER = [
  "bathing",
  "dressing",
  "grooming",
  "toileting",
  "transferring",
  "ambulation",
  "eating",
] as const;

describe("scoreAdlDependence", () => {
  it("scores nothing when no ADL was assessed (no record, an empty record, only not-recorded levels)", () => {
    for (const items of [undefined, {}, { bathing: null }, { bathing: "did_not_occur" }]) {
      expect(scoreAdlDependence(items, ORDER)).toEqual({
        dependent: [],
        assessed: 0,
        band: null,
      });
    }
  });

  it("does not count an ADL that did not occur either way", () => {
    const score = scoreAdlDependence(
      { bathing: "did_not_occur", dressing: "total_dependence", eating: "independent" },
      ORDER,
    );
    expect(score).toEqual({ dependent: ["dressing"], assessed: 2, band: "below" });
  });

  it("counts limited assistance, extensive assistance and total dependence as dependent", () => {
    for (const level of ADL_DEPENDENT_LEVELS) {
      expect(scoreAdlDependence({ bathing: level }, ORDER).dependent).toEqual(["bathing"]);
    }
  });

  it("counts independence and supervision as assessed but not dependent", () => {
    for (const level of ADL_NOT_DEPENDENT_LEVELS) {
      expect(scoreAdlDependence({ bathing: level }, ORDER)).toEqual({
        dependent: [],
        assessed: 1,
        band: "below",
      });
    }
  });

  it("reads one dependent ADL as below the range", () => {
    expect(scoreAdlDependence({ bathing: "limited_assist", eating: "independent" }, ORDER)).toEqual(
      { dependent: ["bathing"], assessed: 2, band: "below" },
    );
  });

  it("reads two dependent ADLs as the lower end of the range", () => {
    expect(
      scoreAdlDependence(
        { bathing: "limited_assist", dressing: "extensive_assist", eating: "supervision" },
        ORDER,
      ),
    ).toEqual({ dependent: ["bathing", "dressing"], assessed: 3, band: "lower" });
  });

  it("reads three or more dependent ADLs as the upper end of the range or beyond", () => {
    const three = scoreAdlDependence(
      { bathing: "limited_assist", dressing: "limited_assist", toileting: "total_dependence" },
      ORDER,
    );
    expect(three).toEqual({
      dependent: ["bathing", "dressing", "toileting"],
      assessed: 3,
      band: "upper",
    });
    const all = scoreAdlDependence(
      Object.fromEntries(ORDER.map((item) => [item, "total_dependence"])),
      ORDER,
    );
    expect(all).toMatchObject({ assessed: 7, band: "upper" });
    expect(all.dependent).toEqual([...ORDER]);
  });

  it("names the dependent ADLs in the canonical order, whatever order the items arrive in", () => {
    const forwards = scoreAdlDependence(
      { bathing: "limited_assist", transferring: "extensive_assist" },
      ORDER,
    );
    const backwards = scoreAdlDependence(
      { transferring: "extensive_assist", bathing: "limited_assist" },
      ORDER,
    );
    expect(forwards.dependent).toEqual(["bathing", "transferring"]);
    expect(backwards).toEqual(forwards);
  });

  it("ignores a level outside the scale (stale data) rather than counting it", () => {
    expect(scoreAdlDependence({ bathing: "limited_assist", eating: "nonsense" }, ORDER)).toEqual({
      dependent: ["bathing"],
      assessed: 1,
      band: "below",
    });
  });

  it("ignores an item that is not one of the ADLs", () => {
    // stored data can carry a key the code does not know: it is not a typed literal at the call site
    const stored: Readonly<Record<string, string>> = {
      bathing: "limited_assist",
      flying: "total_dependence",
    };
    expect(scoreAdlDependence(stored, ORDER)).toEqual({
      dependent: ["bathing"],
      assessed: 1,
      band: "below",
    });
  });

  it("does not read a level off the object prototype", () => {
    expect(scoreAdlDependence<string>({}, ["constructor"])).toEqual({
      dependent: [],
      assessed: 0,
      band: null,
    });
  });
});

describe("adlDependenceBand", () => {
  it("cuts at the lower and upper thresholds", () => {
    expect(ADL_DEPENDENCE_LOWER_THRESHOLD).toBe(2);
    expect(ADL_DEPENDENCE_UPPER_THRESHOLD).toBe(3);
    expect(adlDependenceBand(0)).toBe("below");
    expect(adlDependenceBand(1)).toBe("below");
    expect(adlDependenceBand(2)).toBe("lower");
    expect(adlDependenceBand(3)).toBe("upper");
    expect(adlDependenceBand(7)).toBe("upper");
  });
});

describe("statesAdlItemLevel", () => {
  it("is false when no ADL has a level: no record, no items, or only unassessed items", () => {
    for (const items of [undefined, null, {}, { bathing: null }, { bathing: undefined }]) {
      expect(statesAdlItemLevel(items)).toBe(false);
    }
  });

  it("is true once any one ADL has a level, 'did not occur' included (the note states it)", () => {
    expect(statesAdlItemLevel({ eating: "independent" })).toBe(true);
    expect(statesAdlItemLevel({ bathing: "did_not_occur" })).toBe(true);
    expect(statesAdlItemLevel({ bathing: null, dressing: "limited_assist" })).toBe(true);
  });
});
