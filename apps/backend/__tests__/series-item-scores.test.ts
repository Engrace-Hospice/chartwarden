// apps/backend/__tests__/series-item-scores.test.ts — the ESAS-r item scores a scale-series point carries
// (routes/series-item-scores.ts). A redacted point withholds the nine scores with its score, and only an `esas_r` capture has any.
import { describe, expect, it } from "vitest";
import { seriesItemScores } from "../src/modules/09-assessments/routes/series-item-scores";

const NINE_ITEMS = {
  pain: 3,
  tiredness: 4,
  drowsiness: 2,
  nausea: 0,
  lackOfAppetite: 5,
  shortnessOfBreath: 6,
  depression: 1,
  anxiety: 7,
  wellbeing: 2,
};

describe("seriesItemScores", () => {
  it("returns the nine scores for an unredacted ESAS-r capture", () => {
    expect(seriesItemScores("esas_r", NINE_ITEMS, false)).toEqual({ itemScores: NINE_ITEMS });
  });

  it("returns nothing for a redacted point, so the scores are withheld with the score", () => {
    expect(seriesItemScores("esas_r", NINE_ITEMS, true)).toEqual({});
  });

  it("returns nothing for a scale that is not ESAS-r, even when the data carries the nine numbers", () => {
    expect(seriesItemScores("pps", NINE_ITEMS, false)).toEqual({});
  });

  it("returns nothing for an ESAS-r capture that does not hold all nine items", () => {
    const { wellbeing: _wellbeing, ...partial } = NINE_ITEMS;
    expect(seriesItemScores("esas_r", partial, false)).toEqual({});
  });
});
