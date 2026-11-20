import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
// packages/hearthnote/__tests__/assembly.test.ts — M8-T05 (spec §2.6, architecture §10.5.2).
// Layer-1 deterministic core: byte-identical assembly, template-order rendering, verbatim free-text,
// numeric-direct interpolation, and the D11 vocab-pin / legal-pair / unknown-code guards.
import { describe, expect, it } from "vitest";
import {
  type AssemblyContext,
  HearthnoteAssemblyError,
  type SelectionState,
  assemble,
  assembleLayer1,
  resolveTemplate,
} from "../src/index";

const CONTEXT: AssemblyContext = {
  patient: "Jane Doe",
  serviceDate: "2026-06-21",
  location: "patient residence",
};

/** A routine RN visit selection (valid corpus codes, pinned to the active version). */
function rnRoutineSelection(overrides: Partial<SelectionState> = {}): SelectionState {
  return {
    templateKey: "routine_visit:rn",
    vocabVersion: VOCAB_VERSION,
    encounterType: "routine_visit",
    discipline: "rn",
    sections: [
      {
        sectionId: "chief_concern",
        entries: [],
        freeText: "Routine scheduled visit per care plan.",
      },
      {
        sectionId: "assessment",
        entries: [{ code: "nv.cv.stable" }, { code: "nv.resp.unlabored" }],
      },
      {
        sectionId: "symptom_management",
        entries: [{ code: "nv.sym.pain_controlled", params: { pain_score: 2 } }],
      },
      {
        sectionId: "plan",
        entries: [],
        freeText: "Continue current plan; RN to revisit in one week.",
      },
    ],
    ...overrides,
  };
}

describe("assembleLayer1 — deterministic core", () => {
  const template = resolveTemplate("routine_visit", "rn")!;

  it("renders sections in TEMPLATE order, omitting empty sections", () => {
    const { narrative, sectionsAssembled } = assembleLayer1(
      template,
      rnRoutineSelection(),
      CONTEXT,
    );
    expect(sectionsAssembled).toEqual([
      "chief_concern",
      "assessment",
      "symptom_management",
      "plan",
    ]);
    expect(narrative).toBe(
      [
        "Reason for Visit\nRoutine scheduled visit per care plan.",
        "Assessment\nJane Doe is cardiovascularly stable with no chest pain or palpitations reported. Jane Doe's respirations are unlabored and lung sounds are clear to auscultation.",
        "Symptom Management\nJane Doe's pain is well controlled at 2 of 10 on the current medication regimen.",
        "Plan and Next Visit\nContinue current plan; RN to revisit in one week.",
      ].join("\n\n"),
    );
  });

  it("is byte-identical across repeated runs (same inputs → same bytes)", () => {
    const a = assembleLayer1(template, rnRoutineSelection(), CONTEXT).narrative;
    const b = assembleLayer1(template, rnRoutineSelection(), CONTEXT).narrative;
    expect(a).toBe(b);
  });

  it("renders in template order regardless of selection order", () => {
    const reordered = rnRoutineSelection({
      sections: [...rnRoutineSelection().sections].reverse(),
    });
    expect(assembleLayer1(template, reordered, CONTEXT).sectionsAssembled).toEqual([
      "chief_concern",
      "assessment",
      "symptom_management",
      "plan",
    ]);
  });

  it("preserves clinician free-text verbatim (no grammar applied)", () => {
    const verbatim = "pt's spouse asked about respite — referred to MSW.";
    const sel = rnRoutineSelection({
      sections: [{ sectionId: "chief_concern", entries: [], freeText: verbatim }],
    });
    expect(assembleLayer1(template, sel, CONTEXT).narrative).toBe(`Reason for Visit\n${verbatim}`);
  });

  it("interpolates numeric-direct vitals from context (never paraphrased)", () => {
    const sel = rnRoutineSelection({
      sections: [{ sectionId: "assessment", entries: [{ code: "nv.resp.dyspnea" }] }],
    });
    const ctx: AssemblyContext = { ...CONTEXT, vitals: { o2_lpm: 2 } };
    expect(assembleLayer1(template, sel, ctx).narrative).toContain("oxygen at 2 L/min");
  });

  it("entry params override context for slot collisions", () => {
    const sel = rnRoutineSelection({
      sections: [
        {
          sectionId: "symptom_management",
          entries: [{ code: "nv.sym.pain_controlled", params: { pain_score: 7 } }],
        },
      ],
    });
    expect(assembleLayer1(template, sel, CONTEXT).narrative).toContain("controlled at 7 of 10");
  });

  it("a param named like a context slot never replaces what the assembly supplies", () => {
    const sel = rnRoutineSelection({
      sections: [
        {
          sectionId: "symptom_management",
          entries: [
            {
              code: "nv.sym.pain_controlled",
              params: {
                pain_score: 3,
                patient: "Jane Roe, who is ordered off hospice,",
                serviceDate: "1999-01-01",
              },
            },
          ],
        },
      ],
    });
    const { narrative } = assembleLayer1(template, sel, CONTEXT);
    expect(narrative).toContain("controlled at 3 of 10");
    expect(narrative).not.toContain("Jane Roe");
    expect(narrative).not.toContain("1999-01-01");
  });

  it("throws UNKNOWN_VOCAB_CODE for a code outside the corpus", () => {
    const sel = rnRoutineSelection({
      sections: [{ sectionId: "assessment", entries: [{ code: "nv.bogus" }] }],
    });
    expect(() => assembleLayer1(template, sel, CONTEXT)).toThrowError(HearthnoteAssemblyError);
    try {
      assembleLayer1(template, sel, CONTEXT);
    } catch (e) {
      expect((e as HearthnoteAssemblyError).code).toBe("UNKNOWN_VOCAB_CODE");
    }
  });
});

describe("assembleLayer1 — recorded vitals (WF09)", () => {
  const template = resolveTemplate("routine_visit", "rn")!;
  const RECORDED: AssemblyContext["recordedVitals"] = {
    bpSystolic: 128,
    bpDiastolic: 88,
    heartRate: 78,
    respiratoryRate: 12,
    temperature: "97.8",
    temperatureUnit: "f",
    spo2: 97,
    painScore: 5,
  };
  const withVitals = (recordedVitals: AssemblyContext["recordedVitals"]): AssemblyContext => ({
    ...CONTEXT,
    recordedVitals,
  });
  const vitalsSection = (n: string): string => n.split("\n\n").find((b) => b.startsWith("Vital"))!;

  it("renders the recorded vitals under Vital Signs Review, ahead of the clinician's own words", () => {
    const sel = rnRoutineSelection({
      sections: [{ sectionId: "vitals_review", entries: [], freeText: "Patient resting." }],
    });
    const { narrative } = assembleLayer1(template, sel, withVitals(RECORDED));
    expect(vitalsSection(narrative)).toBe(
      "Vital Signs Review\nVital signs: blood pressure 128/88 mmHg, heart rate 78 bpm, respiratory rate 12 breaths/min, temperature 97.8 °F, SpO₂ 97%, pain score 5 of 10. Patient resting.",
    );
  });

  it("renders the vitals even when the clinician wrote nothing in that section", () => {
    const sel = rnRoutineSelection({ sections: [] });
    const out = assembleLayer1(template, sel, withVitals({ heartRate: 78 }));
    expect(out.sectionsAssembled).toEqual(["vitals_review"]);
    expect(out.narrative).toBe("Vital Signs Review\nVital signs: heart rate 78 bpm.");
  });

  it("names a lone blood-pressure reading for what it is", () => {
    const sel = rnRoutineSelection({ sections: [] });
    expect(assembleLayer1(template, sel, withVitals({ bpSystolic: 128 })).narrative).toContain(
      "systolic blood pressure 128 mmHg",
    );
  });

  it("states a weight in the unit it was taken in", () => {
    const sel = rnRoutineSelection({ sections: [] });
    const ctx = withVitals({ weight: "61.5", weightUnit: "kg" });
    expect(assembleLayer1(template, sel, ctx).narrative).toContain("weight 61.5 kg");
  });

  it("adds nothing when no vitals were recorded or every value is empty", () => {
    const sel = rnRoutineSelection({ sections: [] });
    for (const ctx of [
      CONTEXT,
      withVitals({}),
      withVitals({ heartRate: null, temperature: " " }),
    ]) {
      expect(assembleLayer1(template, sel, ctx).narrative).toBe("");
    }
  });

  it("puts vitals in no other section", () => {
    const { narrative } = assembleLayer1(template, rnRoutineSelection(), withVitals(RECORDED));
    expect(narrative.match(/Vital signs:/g)).toHaveLength(1);
    expect(vitalsSection(narrative)).toContain("Vital signs:");
  });

  it("is byte-identical across repeated runs", () => {
    const sel = rnRoutineSelection();
    const a = assembleLayer1(template, sel, withVitals(RECORDED)).narrative;
    expect(assembleLayer1(template, sel, withVitals(RECORDED)).narrative).toBe(a);
  });
});

describe("assembleLayer1 — recorded ADLs, nutrition and wounds (WF09)", () => {
  const rn = resolveTemplate("routine_visit", "rn")!;
  const ADL: AssemblyContext["recordedAdl"] = {
    items: { bathing: "limited_assist", transferring: "extensive_assist" },
    devices: ["walker"],
  };
  const NUTRITION: AssemblyContext["recordedNutrition"] = {
    appetite: "poor",
    support: "oral_supplements",
  };
  const WOUNDS: AssemblyContext["recordedWounds"] = [
    { site: "sacrum", etiology: "pressure_injury", stage: "stage_3", trend: "improving" },
    { site: "left heel", etiology: "diabetic_ulcer" },
  ];
  const ADL_SENTENCE =
    "Functional status: needed limited assistance with bathing, extensive assistance with transferring; uses a walker.";
  const NUTRITION_SENTENCE = "Nutrition: appetite poor, receives oral supplements.";
  const WOUND_SENTENCES =
    "Sacrum pressure injury, stage 3, trend improving. Left heel diabetic ulcer.";
  const nothing = rnRoutineSelection({ sections: [] });
  const blockOf = (narrative: string, heading: string): string | undefined =>
    narrative.split("\n\n").find((b) => b.startsWith(`${heading}\n`));

  it("renders each recorded finding under its own section with no selection needed", () => {
    const out = assembleLayer1(rn, nothing, {
      ...CONTEXT,
      recordedAdl: ADL,
      recordedNutrition: NUTRITION,
      recordedWounds: WOUNDS,
    });
    expect(out.sectionsAssembled).toEqual(["functional_status", "nutrition", "skin_wounds"]);
    expect(out.narrative).toBe(
      [
        `Functional Status\n${ADL_SENTENCE}`,
        `Nutrition and Hydration\n${NUTRITION_SENTENCE}`,
        `Skin and Wounds\n${WOUND_SENTENCES}`,
      ].join("\n\n"),
    );
  });

  it("places them after Assessment and before Symptom Management", () => {
    const { narrative } = assembleLayer1(rn, rnRoutineSelection(), {
      ...CONTEXT,
      recordedAdl: ADL,
      recordedNutrition: NUTRITION,
      recordedWounds: WOUNDS,
    });
    const headings = narrative.split("\n\n").map((b) => b.split("\n")[0]);
    expect(headings).toEqual([
      "Reason for Visit",
      "Assessment",
      "Functional Status",
      "Nutrition and Hydration",
      "Skin and Wounds",
      "Symptom Management",
      "Plan and Next Visit",
    ]);
  });

  it("puts the recorded facts ahead of the clinician's own words", () => {
    const sel = rnRoutineSelection({
      sections: [
        { sectionId: "skin_wounds", entries: [], freeText: "Dressing supplies restocked." },
      ],
    });
    const out = assembleLayer1(rn, sel, { ...CONTEXT, recordedWounds: WOUNDS });
    expect(out.narrative).toBe(`Skin and Wounds\n${WOUND_SENTENCES} Dressing supplies restocked.`);
  });

  it("still renders the clinician's own words when nothing was recorded", () => {
    const sel = rnRoutineSelection({
      sections: [{ sectionId: "nutrition", entries: [], freeText: "Eating small portions." }],
    });
    expect(assembleLayer1(rn, sel, CONTEXT).narrative).toBe(
      "Nutrition and Hydration\nEating small portions.",
    );
  });

  it("renders nothing for a section with neither selections nor recorded facts", () => {
    const empty: AssemblyContext = {
      ...CONTEXT,
      recordedAdl: {},
      recordedNutrition: { appetite: null },
      recordedWounds: [],
    };
    for (const ctx of [CONTEXT, empty]) {
      expect(assembleLayer1(rn, nothing, ctx)).toEqual({
        narrative: "",
        sectionsAssembled: [],
        vocabVersion: VOCAB_VERSION,
      });
    }
  });

  it("is byte-identical to the original output when the new context fields are absent", () => {
    const baseline = assembleLayer1(rn, rnRoutineSelection(), CONTEXT).narrative;
    const explicit = assembleLayer1(rn, rnRoutineSelection(), {
      ...CONTEXT,
      recordedAdl: undefined,
      recordedNutrition: undefined,
      recordedWounds: undefined,
    }).narrative;
    expect(explicit).toBe(baseline);
    expect(baseline).not.toContain("Functional Status");
  });

  it("states a recorded finding only in a template that has its section", () => {
    const pt = resolveTemplate("pt_visit", "pt")!;
    const slp = resolveTemplate("slp_visit", "slp")!;
    const telephonic = resolveTemplate("telephonic", "rn")!;
    const ctx: AssemblyContext = {
      ...CONTEXT,
      recordedAdl: ADL,
      recordedNutrition: NUTRITION,
      recordedWounds: WOUNDS,
    };
    const sel = (t: typeof pt): SelectionState => ({
      ...nothing,
      templateKey: t.key,
      encounterType: t.encounterType,
      discipline: t.discipline,
    });
    expect(assembleLayer1(pt, sel(pt), ctx).sectionsAssembled).toEqual(["functional_status"]);
    expect(assembleLayer1(slp, sel(slp), ctx).sectionsAssembled).toEqual(["nutrition"]);
    expect(assembleLayer1(telephonic, sel(telephonic), ctx).sectionsAssembled).toEqual([
      "functional_status",
      "nutrition",
    ]);
  });

  it("puts each recorded finding in no other section", () => {
    const { narrative } = assembleLayer1(rn, rnRoutineSelection(), {
      ...CONTEXT,
      recordedAdl: ADL,
      recordedNutrition: NUTRITION,
      recordedWounds: WOUNDS,
    });
    expect(narrative.match(/Functional status:/g)).toHaveLength(1);
    expect(narrative.match(/Nutrition:/g)).toHaveLength(1);
    expect(blockOf(narrative, "Assessment")).not.toContain("Functional status");
  });

  it("states the recorded ADLs ahead of the ticked statements in CHHA's ADL section", () => {
    const chha = resolveTemplate("chha_visit", "chha")!;
    const sel: SelectionState = {
      templateKey: "chha_visit:chha",
      vocabVersion: VOCAB_VERSION,
      encounterType: "chha_visit",
      discipline: "chha",
      sections: [
        {
          sectionId: "adl",
          entries: [{ code: "nv.adl.personal_care" }],
          freeText: "Daughter present.",
        },
      ],
    };
    const adlBlock = blockOf(
      assembleLayer1(chha, sel, { ...CONTEXT, recordedAdl: ADL }).narrative,
      "Activities of Daily Living",
    )!;
    expect(adlBlock.startsWith(`Activities of Daily Living\n${ADL_SENTENCE} `)).toBe(true);
    expect(adlBlock.endsWith(" Daughter present.")).toBe(true);
  });

  it("assembles the same recorded findings to the same bytes on every run", () => {
    const ctx: AssemblyContext = {
      ...CONTEXT,
      recordedAdl: ADL,
      recordedNutrition: NUTRITION,
      recordedWounds: WOUNDS,
    };
    expect(assembleLayer1(rn, nothing, ctx).narrative).toBe(
      assembleLayer1(rn, nothing, ctx).narrative,
    );
  });

  it("states height, BMI and the weight change through the vitals section", () => {
    const ctx: AssemblyContext = {
      ...CONTEXT,
      recordedVitals: {
        weight: "61.2",
        weightUnit: "kg",
        height: "170",
        heightUnit: "cm",
        bmi: "24.3",
        priorWeight: { value: "62.5", unit: "kg", on: "2026-11-05" },
      },
    };
    expect(assembleLayer1(rn, nothing, ctx).narrative).toBe(
      "Vital Signs Review\nVital signs: weight 61.2 kg, 1.3 kg lower than 62.5 kg on 2026-11-05, height 170 cm, BMI 24.3.",
    );
  });
});

describe("assemble — resolves + guards", () => {
  it("assembles a valid selection via its own pair", () => {
    expect(assemble(rnRoutineSelection(), CONTEXT).narrative.length).toBeGreaterThan(0);
  });

  it("throws VOCAB_VERSION_MISMATCH when the pin is stale (D11)", () => {
    const sel = rnRoutineSelection({ vocabVersion: "narrative-vocab@1900.01.0" });
    try {
      assemble(sel, CONTEXT);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as HearthnoteAssemblyError).code).toBe("VOCAB_VERSION_MISMATCH");
    }
  });

  it("throws TEMPLATE_KEY_MISMATCH when templateKey disagrees with the pair", () => {
    const sel = rnRoutineSelection({ templateKey: "telephonic:rn" });
    try {
      assemble(sel, CONTEXT);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as HearthnoteAssemblyError).code).toBe("TEMPLATE_KEY_MISMATCH");
    }
  });

  it("throws TEMPLATE_NOT_FOUND for an illegal pair", () => {
    const sel = rnRoutineSelection({
      templateKey: "face_to_face:rn",
      encounterType: "face_to_face",
      discipline: "rn",
    });
    try {
      assemble(sel, CONTEXT);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as HearthnoteAssemblyError).code).toBe("TEMPLATE_NOT_FOUND");
    }
  });
});

describe("assembleLayer1 — linked fall (WF09)", () => {
  const template = resolveTemplate("routine_visit", "rn")!;
  const select = (code: string | undefined): SelectionState =>
    rnRoutineSelection({
      sections: [{ sectionId: "chief_concern", entries: code === undefined ? [] : [{ code }] }],
    });
  const reasonBlock = (selection: SelectionState, linkedFall?: { occurredOn: string }): string =>
    assembleLayer1(template, selection, { ...CONTEXT, ...(linkedFall ? { linkedFall } : {}) })
      .narrative;

  it("states the date of the linked fall right after the follow-up reason", () => {
    expect(reasonBlock(select("nv.reason.fall_followup"), { occurredOn: "2026-06-18" })).toBe(
      "Reason for Visit\nThis visit is a follow-up after a recent fall. The fall occurred on 2026-06-18.",
    );
  });

  it("states nothing extra when no fall is linked", () => {
    expect(reasonBlock(select("nv.reason.fall_followup"))).toBe(
      "Reason for Visit\nThis visit is a follow-up after a recent fall.",
    );
  });

  it("never states a fall beside a different reason, even if a link is still present", () => {
    expect(reasonBlock(select("nv.reason.pain"), { occurredOn: "2026-06-18" })).not.toContain(
      "The fall occurred",
    );
    expect(reasonBlock(select(undefined), { occurredOn: "2026-06-18" })).toBe("");
  });

  it("is byte-identical on a re-render", () => {
    const fall = { occurredOn: "2026-06-18" };
    expect(reasonBlock(select("nv.reason.fall_followup"), fall)).toBe(
      reasonBlock(select("nv.reason.fall_followup"), fall),
    );
  });
});
