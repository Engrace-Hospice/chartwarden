// packages/hearthnote/__tests__/recorded-findings.test.ts — WF09.
// The deterministic sentences for recorded ADLs, nutrition and wounds: plain clinical English, values quoted
// exactly, no inference, "" when nothing is recorded, and a label for EVERY value of EVERY value set.
import { ADL_DEPENDENT_LEVELS, ADL_NOT_DEPENDENT_LEVELS } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  ADL_DEVICES,
  ADL_ITEMS,
  ADL_LEVELS,
  APPETITE_LEVELS,
  CONTINENCE_LEVELS,
  EXUDATE_AMOUNTS,
  EXUDATE_TYPES,
  FLUID_INTAKE_LEVELS,
  NUTRITION_SUPPORTS,
  PERIWOUND_CONDITIONS,
  PRESSURE_STAGES,
  type RecordedWound,
  SWALLOWING_LEVELS,
  WOUND_BED_TISSUES,
  WOUND_DRESSINGS,
  WOUND_ETIOLOGIES,
  WOUND_ODORS,
  WOUND_TRENDS,
  describeRecordedAdl,
  describeRecordedNutrition,
  describeRecordedWounds,
} from "../src/index";

const SACRUM: RecordedWound = {
  site: "sacrum",
  etiology: "pressure_injury",
  stage: "stage_3",
  lengthCm: 4,
  widthCm: 3,
  depthCm: 1.2,
  woundBed: ["granulation", "slough"],
  exudateAmount: "moderate",
  exudateType: "serosanguineous",
  odor: "none",
  periwound: ["erythema"],
  painScore: 4,
  dressing: "foam",
  dressingChanged: true,
  trend: "improving",
};

/** Output for each value of a set, run through `build`; proves every value is worded, distinctly, with no raw snake_case token. */
function expectEveryValueLabelled<T extends string>(
  values: readonly T[],
  baseline: string,
  build: (value: T) => string,
): void {
  const outputs = values.map((value) => build(value));
  for (const [i, out] of outputs.entries()) {
    const value = values[i] as string;
    expect(out, `${value} must change the sentence`).not.toBe(baseline);
    expect(out, `${value} must not leave an underscore token`).not.toMatch(/_/);
  }
  expect(new Set(outputs).size, "labels must be distinct").toBe(values.length);
}

describe("describeRecordedAdl", () => {
  it("returns an empty string when nothing is recorded", () => {
    for (const recorded of [
      undefined,
      {},
      { items: {} },
      { items: {}, bladder: null, bowel: null, devices: [] },
    ]) {
      expect(describeRecordedAdl(recorded)).toBe("");
    }
  });

  it("states the assistance levels, continence and devices as recorded", () => {
    const sentence = describeRecordedAdl({
      items: {
        bathing: "limited_assist",
        dressing: "limited_assist",
        transferring: "extensive_assist",
      },
      bladder: "occasionally_incontinent",
      devices: ["walker", "hospital_bed"],
    });
    expect(sentence).toBe(
      "Functional status: needed limited assistance with bathing and dressing, extensive assistance with transferring; dependent in 3 of 3 assessed ADLs (bathing, dressing and transferring); bladder occasionally incontinent; uses a walker and a hospital bed.",
    );
  });

  it("states only what was recorded (partial data)", () => {
    expect(describeRecordedAdl({ bowel: "continent" })).toBe("Functional status: bowel continent.");
    expect(describeRecordedAdl({ devices: ["cane"] })).toBe("Functional status: uses a cane.");
    expect(describeRecordedAdl({ items: { eating: "independent" } })).toBe(
      "Functional status: independent with eating; dependent in 0 of 1 assessed ADL.",
    );
  });

  it("words every level in its own clause, in scale order, whatever order the items arrive in", () => {
    const sentence = describeRecordedAdl({
      items: {
        ambulation: "did_not_occur",
        eating: "independent",
        toileting: "total_dependence",
        grooming: "supervision",
      },
    });
    expect(sentence).toBe(
      "Functional status: independent with eating, needed supervision with grooming, was totally dependent for toileting, ambulation did not occur; dependent in 1 of 3 assessed ADLs (toileting).",
    );
    const reversed = describeRecordedAdl({
      items: {
        grooming: "supervision",
        toileting: "total_dependence",
        eating: "independent",
        ambulation: "did_not_occur",
      },
    });
    expect(reversed).toBe(sentence);
  });

  it("lists three or more items of one level with a single closing 'and'", () => {
    expect(
      describeRecordedAdl({
        items: {
          bathing: "extensive_assist",
          dressing: "extensive_assist",
          grooming: "extensive_assist",
        },
      }),
    ).toBe(
      "Functional status: needed extensive assistance with bathing, dressing and grooming; dependent in 3 of 3 assessed ADLs (bathing, dressing and grooming).",
    );
  });

  it("keeps the devices in the order they were recorded and states each once", () => {
    expect(describeRecordedAdl({ devices: ["wheelchair", "cane", "wheelchair"] })).toBe(
      "Functional status: uses a wheelchair and a cane.",
    );
  });

  it("drops a value that is not in the value set rather than printing a raw token", () => {
    const stale = { items: { bathing: "limited_assist", eating: "nonsense" } } as never;
    expect(describeRecordedAdl(stale)).toBe(
      "Functional status: needed limited assistance with bathing; dependent in 1 of 1 assessed ADL (bathing).",
    );
  });

  describe("the dependence score", () => {
    const BATHING_DRESSING_TOILETING = {
      bathing: "limited_assist",
      dressing: "extensive_assist",
      toileting: "total_dependence",
    } as const;

    it("states how many assessed ADLs the patient is dependent in, naming them in the canonical order", () => {
      expect(
        describeRecordedAdl({
          items: {
            eating: "supervision",
            toileting: "total_dependence",
            bathing: "limited_assist",
          },
        }),
      ).toBe(
        "Functional status: needed supervision with eating, limited assistance with bathing, was totally dependent for toileting; dependent in 2 of 3 assessed ADLs (bathing and toileting).",
      );
    });

    it("names no ADL when the patient is dependent in none", () => {
      expect(
        describeRecordedAdl({ items: { bathing: "independent", eating: "supervision" } }),
      ).toBe(
        "Functional status: independent with bathing, needed supervision with eating; dependent in 0 of 2 assessed ADLs.",
      );
    });

    it("leaves an ADL that did not occur out of both numbers", () => {
      expect(
        describeRecordedAdl({
          items: { bathing: "did_not_occur", dressing: "limited_assist", eating: "independent" },
        }),
      ).toBe(
        "Functional status: independent with eating, needed limited assistance with dressing, bathing did not occur; dependent in 1 of 2 assessed ADLs (dressing).",
      );
    });

    it("states no score when no ADL was assessed (all did not occur), so the sentence is as it was", () => {
      expect(describeRecordedAdl({ items: { bathing: "did_not_occur" }, devices: ["cane"] })).toBe(
        "Functional status: bathing did not occur; uses a cane.",
      );
    });

    it("states a score only from the ADL levels, never from continence or devices", () => {
      expect(describeRecordedAdl({ bladder: "incontinent", devices: ["mechanical_lift"] })).toBe(
        "Functional status: bladder incontinent; uses a mechanical lift.",
      );
    });

    it("states the same score whatever order the items arrive in", () => {
      const forwards = describeRecordedAdl({ items: BATHING_DRESSING_TOILETING });
      const backwards = describeRecordedAdl({
        items: {
          toileting: "total_dependence",
          dressing: "extensive_assist",
          bathing: "limited_assist",
        },
      });
      expect(backwards).toBe(forwards);
    });

    it("never says the patient qualifies or is eligible: it states a count, not a determination", () => {
      const sentence = describeRecordedAdl({ items: BATHING_DRESSING_TOILETING });
      expect(sentence).not.toMatch(/qualif|eligib|hospice|guideline|meets/i);
    });

    it("covers every level of the scale exactly once: dependent, not dependent, or not assessed", () => {
      const covered = [...ADL_DEPENDENT_LEVELS, ...ADL_NOT_DEPENDENT_LEVELS, "did_not_occur"];
      expect([...covered].sort()).toEqual([...ADL_LEVELS].sort());
    });
  });

  describe("the change in dependence since an earlier visit", () => {
    const NOW = {
      items: {
        bathing: "limited_assist",
        dressing: "extensive_assist",
        transferring: "limited_assist",
        eating: "independent",
      },
    } as const;

    it("states an increase and what it was at the earlier visit", () => {
      const prior = {
        on: "2026-11-10",
        items: { bathing: "limited_assist", dressing: "supervision", eating: "independent" },
      } as const;
      expect(describeRecordedAdl(NOW, prior)).toBe(
        "Functional status: independent with eating, needed limited assistance with bathing and transferring, extensive assistance with dressing; dependent in 3 of 4 assessed ADLs (bathing, dressing and transferring), up from 1 of 3 assessed at the visit on 2026-11-10.",
      );
    });

    it("states a decrease", () => {
      const prior = {
        on: "2026-11-10",
        items: {
          bathing: "total_dependence",
          dressing: "total_dependence",
          grooming: "extensive_assist",
          transferring: "limited_assist",
          eating: "limited_assist",
        },
      } as const;
      expect(describeRecordedAdl(NOW, prior)).toContain(
        "dependent in 3 of 4 assessed ADLs (bathing, dressing and transferring), down from 5 of 5 assessed at the visit on 2026-11-10.",
      );
    });

    it("states no change, with the earlier numbers", () => {
      const prior = {
        on: "2026-11-10",
        items: {
          bathing: "limited_assist",
          dressing: "limited_assist",
          grooming: "limited_assist",
          eating: "independent",
        },
      } as const;
      expect(describeRecordedAdl(NOW, prior)).toContain(
        "(bathing, dressing and transferring), unchanged from 3 of 4 assessed at the visit on 2026-11-10.",
      );
    });

    it("compares the share dependent, so a different number assessed is stated, not hidden", () => {
      const prior = { on: "2026-11-10", items: { bathing: "independent" } } as const;
      expect(describeRecordedAdl(NOW, prior)).toContain(
        "up from 0 of 1 assessed at the visit on 2026-11-10.",
      );
    });

    // The movement is the change in the SHARE of assessed ADLs the patient was dependent in, not in the count: "1 of 1" after "2 of 2"
    // is everything assessed, as before, so it is not "down".
    describe("compares the share of assessed ADLs, not the count of dependent ones", () => {
      const sentence = (
        now: Readonly<Record<string, string>>,
        before: Readonly<Record<string, string>>,
      ): string =>
        describeRecordedAdl({ items: now } as never, { on: "2026-11-10", items: before } as never);
      const D = "limited_assist";
      const I = "independent";

      it("is unchanged when every assessed ADL was dependent at both visits (1 of 1 after 2 of 2)", () => {
        expect(sentence({ bathing: D }, { bathing: D, dressing: D })).toContain(
          "dependent in 1 of 1 assessed ADL (bathing), unchanged from 2 of 2 assessed at the visit on 2026-11-10.",
        );
      });

      it("is down when fewer of a larger number assessed were dependent (2 of 7 after 1 of 2)", () => {
        const now = {
          bathing: D,
          dressing: D,
          grooming: I,
          toileting: I,
          transferring: I,
          ambulation: I,
          eating: I,
        };
        expect(sentence(now, { bathing: D, dressing: I })).toContain(
          "dependent in 2 of 7 assessed ADLs (bathing and dressing), down from 1 of 2 assessed at the visit on 2026-11-10.",
        );
      });

      it("is up when more of the same number assessed were dependent (2 of 3 after 1 of 3)", () => {
        expect(
          sentence({ bathing: D, dressing: D, eating: I }, { bathing: D, dressing: I, eating: I }),
        ).toContain("up from 1 of 3 assessed at the visit on 2026-11-10.");
      });

      it("is down when fewer of the same number assessed were dependent (1 of 3 after 2 of 3)", () => {
        expect(
          sentence({ bathing: D, dressing: I, eating: I }, { bathing: D, dressing: D, eating: I }),
        ).toContain("down from 2 of 3 assessed at the visit on 2026-11-10.");
      });

      it("is down when the same count is a smaller share (1 of 3 after 1 of 2) and up when it is a larger one (1 of 2 after 1 of 3)", () => {
        expect(
          sentence({ bathing: D, dressing: I, eating: I }, { bathing: D, dressing: I }),
        ).toContain("down from 1 of 2 assessed");
        expect(
          sentence({ bathing: D, dressing: I }, { bathing: D, dressing: I, eating: I }),
        ).toContain("up from 1 of 3 assessed");
      });

      it("is unchanged for an equal share written with different numbers (2 of 4 after 1 of 2)", () => {
        const now = { bathing: D, dressing: D, grooming: I, eating: I };
        expect(sentence(now, { bathing: D, dressing: I })).toContain(
          "unchanged from 1 of 2 assessed",
        );
      });

      it("is unchanged when nobody was dependent at either visit (0 of 2 after 0 of 1)", () => {
        expect(sentence({ bathing: I, dressing: I }, { bathing: I })).toContain(
          "dependent in 0 of 2 assessed ADLs, unchanged from 0 of 1 assessed",
        );
      });
    });

    it("says 'the previous visit' when the earlier service date is blank", () => {
      const prior = { on: "  ", items: { bathing: "independent" } } as const;
      expect(describeRecordedAdl(NOW, prior)).toContain(
        "up from 0 of 1 assessed at the previous visit.",
      );
    });

    it("states no change when the earlier visit assessed no ADL (nothing to compare)", () => {
      for (const prior of [
        { on: "2026-11-10" },
        { on: "2026-11-10", items: {} },
        { on: "2026-11-10", items: { bathing: "did_not_occur" } },
      ] as const) {
        expect(describeRecordedAdl(NOW, prior)).toBe(describeRecordedAdl(NOW));
      }
      expect(describeRecordedAdl(NOW, null)).toBe(describeRecordedAdl(NOW));
    });

    it("states nothing about an earlier visit when this visit assessed no ADL", () => {
      const prior = { on: "2026-11-10", items: { bathing: "limited_assist" } } as const;
      expect(describeRecordedAdl({ devices: ["cane"] }, prior)).toBe(
        "Functional status: uses a cane.",
      );
      expect(describeRecordedAdl(undefined, prior)).toBe("");
    });

    it("ignores a stale level at the earlier visit rather than counting it", () => {
      const prior = {
        on: "2026-11-10",
        items: { bathing: "limited_assist", eating: "nonsense" },
      } as never;
      // 3 of 4 now against the one level that counts (1 of 1): a smaller share dependent.
      expect(describeRecordedAdl(NOW, prior)).toContain(
        "down from 1 of 1 assessed at the visit on",
      );
    });
  });

  it("has a distinct label for every item, level, continence level and device", () => {
    const baseline = describeRecordedAdl({ devices: ["cane"] });
    expectEveryValueLabelled(ADL_ITEMS, baseline, (item) =>
      describeRecordedAdl({ devices: ["cane"], items: { [item]: "supervision" } }),
    );
    expectEveryValueLabelled(ADL_LEVELS, baseline, (level) =>
      describeRecordedAdl({ devices: ["cane"], items: { bathing: level } }),
    );
    expectEveryValueLabelled(CONTINENCE_LEVELS, baseline, (level) =>
      describeRecordedAdl({ devices: ["cane"], bladder: level }),
    );
    expectEveryValueLabelled(CONTINENCE_LEVELS, baseline, (level) =>
      describeRecordedAdl({ devices: ["cane"], bowel: level }),
    );
    expectEveryValueLabelled(
      ADL_DEVICES.filter((d) => d !== "cane"),
      baseline,
      (device) => describeRecordedAdl({ devices: [device] }),
    );
  });
});

describe("describeRecordedNutrition", () => {
  it("returns an empty string when nothing is recorded", () => {
    for (const recorded of [
      undefined,
      {},
      { appetite: null, mealIntakePercent: null, support: null },
    ]) {
      expect(describeRecordedNutrition(recorded)).toBe("");
    }
  });

  it("states every recorded field in plain words", () => {
    expect(
      describeRecordedNutrition({
        appetite: "poor",
        mealIntakePercent: 25,
        fluidIntake: "decreased",
        swallowing: "difficulty_solids",
        support: "oral_supplements",
      }),
    ).toBe(
      "Nutrition: appetite poor, ate about 25% of meals, fluid intake decreased, difficulty swallowing solids, receives oral supplements.",
    );
  });

  it("states only what was recorded (partial data)", () => {
    expect(describeRecordedNutrition({ fluidIntake: "minimal" })).toBe(
      "Nutrition: fluid intake minimal.",
    );
    expect(describeRecordedNutrition({ mealIntakePercent: 0 })).toBe(
      "Nutrition: ate about 0% of meals.",
    );
  });

  it("drops an intake percent outside 0 to 100 rather than stating it", () => {
    expect(describeRecordedNutrition({ mealIntakePercent: 140 })).toBe("");
    expect(describeRecordedNutrition({ mealIntakePercent: -5 })).toBe("");
    expect(describeRecordedNutrition({ mealIntakePercent: Number.NaN })).toBe("");
  });

  it("has a distinct label for every appetite, fluid, swallowing and support value", () => {
    const baseline = describeRecordedNutrition({ mealIntakePercent: 50 });
    expectEveryValueLabelled(APPETITE_LEVELS, baseline, (appetite) =>
      describeRecordedNutrition({ mealIntakePercent: 50, appetite }),
    );
    expectEveryValueLabelled(FLUID_INTAKE_LEVELS, baseline, (fluidIntake) =>
      describeRecordedNutrition({ mealIntakePercent: 50, fluidIntake }),
    );
    expectEveryValueLabelled(SWALLOWING_LEVELS, baseline, (swallowing) =>
      describeRecordedNutrition({ mealIntakePercent: 50, swallowing }),
    );
    expectEveryValueLabelled(NUTRITION_SUPPORTS, baseline, (support) =>
      describeRecordedNutrition({ mealIntakePercent: 50, support }),
    );
  });
});

describe("describeRecordedWounds", () => {
  it("returns an empty string when no wound is recorded", () => {
    expect(describeRecordedWounds(undefined)).toBe("");
    expect(describeRecordedWounds([])).toBe("");
  });

  it("states one wound as one sentence with every recorded descriptor", () => {
    expect(describeRecordedWounds([SACRUM])).toBe(
      "Sacrum pressure injury, stage 3, 4.0 x 3.0 x 1.2 cm, granulation and slough in the wound bed, moderate serosanguineous drainage, no odor, periwound erythema, pain 4 of 10, foam dressing changed, trend improving.",
    );
  });

  it("states a wound with only a site and a cause", () => {
    expect(describeRecordedWounds([{ site: "left heel", etiology: "diabetic_ulcer" }])).toBe(
      "Left heel diabetic ulcer.",
    );
    expect(describeRecordedWounds([{ site: "  ", etiology: "other" }])).toBe("Wound.");
  });

  it("states one sentence per wound, in the order recorded", () => {
    const sentences = describeRecordedWounds([
      { site: "right hip", etiology: "skin_tear" },
      SACRUM,
      { site: "left heel", etiology: "venous_ulcer", trend: "new" },
    ]);
    expect(sentences.startsWith("Right hip skin tear. Sacrum pressure injury, stage 3,")).toBe(
      true,
    );
    expect(sentences.endsWith(" Left heel venous ulcer, new wound.")).toBe(true);
    expect(
      describeRecordedWounds([{ site: "left heel", etiology: "venous_ulcer" }, SACRUM]),
    ).not.toBe(describeRecordedWounds([SACRUM, { site: "left heel", etiology: "venous_ulcer" }]));
  });

  it("quotes measurements without rounding and labels the ones that cannot be paired", () => {
    const wound = (m: Partial<RecordedWound>): string =>
      describeRecordedWounds([{ site: "sacrum", etiology: "other", ...m }]);
    expect(wound({ lengthCm: 2.55, widthCm: 1, depthCm: 0.3 })).toBe(
      "Sacrum wound, 2.55 x 1.0 x 0.3 cm.",
    );
    expect(wound({ lengthCm: 4, widthCm: 3 })).toBe("Sacrum wound, 4.0 x 3.0 cm.");
    expect(wound({ depthCm: 0.5 })).toBe("Sacrum wound, depth 0.5 cm.");
    expect(wound({ lengthCm: 4, depthCm: 0.5 })).toBe("Sacrum wound, length 4.0 cm, depth 0.5 cm.");
    expect(wound({ lengthCm: 0, widthCm: 0 })).toBe("Sacrum wound, 0.0 x 0.0 cm.");
    expect(wound({ lengthCm: -1, widthCm: Number.NaN })).toBe("Sacrum wound.");
  });

  it("states yes/no findings only when they were recorded", () => {
    const wound = (m: Partial<RecordedWound>): string =>
      describeRecordedWounds([{ site: "sacrum", etiology: "other", ...m }]);
    expect(wound({ undermining: true })).toBe("Sacrum wound, undermining present.");
    expect(wound({ undermining: false })).toBe("Sacrum wound, no undermining.");
    expect(wound({ infectionSigns: true })).toBe("Sacrum wound, signs of infection present.");
    expect(wound({ infectionSigns: false })).toBe("Sacrum wound, no signs of infection.");
    expect(wound({ dressingChanged: true })).toBe("Sacrum wound, dressing changed.");
    expect(wound({ dressingChanged: false })).toBe("Sacrum wound, dressing not changed.");
    expect(wound({ dressing: "gauze" })).toBe("Sacrum wound, gauze dressing.");
    expect(wound({ dressing: "gauze", dressingChanged: false })).toBe(
      "Sacrum wound, gauze dressing not changed.",
    );
    expect(wound({ undermining: null, infectionSigns: null, dressingChanged: null })).toBe(
      "Sacrum wound.",
    );
  });

  it("states drainage from whichever of amount and type was recorded", () => {
    const wound = (m: Partial<RecordedWound>): string =>
      describeRecordedWounds([{ site: "sacrum", etiology: "other", ...m }]);
    expect(wound({ exudateAmount: "scant" })).toBe("Sacrum wound, scant drainage.");
    expect(wound({ exudateType: "purulent" })).toBe("Sacrum wound, purulent drainage.");
    expect(wound({ exudateAmount: "none", exudateType: "serous" })).toBe(
      "Sacrum wound, no drainage.",
    );
  });

  it("lists wound-bed tissues and periwound conditions in the order recorded", () => {
    const sentence = describeRecordedWounds([
      {
        site: "sacrum",
        etiology: "other",
        woundBed: ["slough", "granulation", "slough"],
        periwound: ["erythema", "edematous", "warm"],
      },
    ]);
    expect(sentence).toBe(
      "Sacrum wound, slough and granulation in the wound bed, periwound erythema, edema and warmth.",
    );
  });

  it("drops a value that is not in the value set rather than printing a raw token", () => {
    const stale = {
      site: "sacrum",
      etiology: "mystery",
      odor: "fruity",
      woundBed: ["goo"],
    } as never;
    expect(describeRecordedWounds([stale])).toBe("Sacrum wound.");
  });

  it("has a distinct label for every wound value set", () => {
    const wound = (m: Partial<RecordedWound>): string =>
      describeRecordedWounds([{ site: "sacrum", etiology: "other", ...m }]);
    const baseline = wound({});
    // `other` is the baseline etiology, so it is compared against the first non-other value instead.
    expectEveryValueLabelled(
      WOUND_ETIOLOGIES.filter((e) => e !== "other"),
      baseline,
      (etiology) => describeRecordedWounds([{ site: "sacrum", etiology }]),
    );
    expectEveryValueLabelled(PRESSURE_STAGES, baseline, (stage) => wound({ stage }));
    expectEveryValueLabelled(WOUND_BED_TISSUES, baseline, (tissue) =>
      wound({ woundBed: [tissue] }),
    );
    expectEveryValueLabelled(EXUDATE_AMOUNTS, baseline, (exudateAmount) =>
      wound({ exudateAmount }),
    );
    expectEveryValueLabelled(EXUDATE_TYPES, baseline, (exudateType) => wound({ exudateType }));
    expectEveryValueLabelled(WOUND_ODORS, baseline, (odor) => wound({ odor }));
    expectEveryValueLabelled(PERIWOUND_CONDITIONS, baseline, (c) => wound({ periwound: [c] }));
    expectEveryValueLabelled(WOUND_DRESSINGS, baseline, (dressing) => wound({ dressing }));
    expectEveryValueLabelled(WOUND_TRENDS, baseline, (trend) => wound({ trend }));
  });

  it("words every etiology in a way that names the kind of wound", () => {
    for (const etiology of WOUND_ETIOLOGIES) {
      expect(describeRecordedWounds([{ site: "sacrum", etiology }])).not.toMatch(/_/);
    }
  });

  it("is byte-identical across repeated runs", () => {
    expect(describeRecordedWounds([SACRUM, SACRUM])).toBe(describeRecordedWounds([SACRUM, SACRUM]));
  });
});
