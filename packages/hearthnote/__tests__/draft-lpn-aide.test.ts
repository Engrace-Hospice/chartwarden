// packages/hearthnote/__tests__/draft-lpn-aide.test.ts — S3: the LPN visits' and the aide visit's draft (design §3.5, VN-D39 to VN-D41).
// Synthetic names and ids only: no SSN, MBI, or value copied from a real record.
//
// What these pin: which sections an LPN note and an aide note draft (scope is read off the corpus tags), that an LPN never gets the PPS or ESAS-r
// sections (a functional determination is the RN's or physician's), that the aide's `adl` states the care-plan interventions with the recorded ADLs
// kept in the section (a confirmed section replaces the whole section), the sources each template needs read, and fail-closed Part 2.
import { describe, expect, it } from "vitest";
import {
  type DraftInputs,
  type DraftSection,
  compileDraft,
  describeRecordedAdl,
  draftSourceNeeds,
  draftedSectionIds,
  templateHasDraftedSection,
} from "../src/index";
import { DEPS, baseInputs, deepFreeze } from "./_draft-fixtures";

const LPN_PAIRS = [
  ["routine_visit", "lpn"],
  ["lpn_visit", "lpn"],
] as const;

/** An LPN visit: every S1 source supplied, nothing selected. Mutable copy per call. */
function lpnInputs(type: "routine_visit" | "lpn_visit"): DraftInputs {
  const base = baseInputs();
  return {
    ...base,
    encounterType: type,
    discipline: "lpn",
    selection: {
      templateKey: `${type}:lpn`,
      vocabVersion: base.selection.vocabVersion,
      encounterType: type,
      discipline: "lpn",
      sections: [],
    },
  };
}

const RECORDED_ADL = { items: { bathing: "extensive_assistance" }, devices: ["walker"] } as const;

/** The aide visit: the care plan and a recorded ADL, nothing selected. Mutable copy per call. */
function aideInputs(): DraftInputs {
  const base = baseInputs();
  return {
    ...base,
    encounterType: "chha_visit",
    discipline: "chha",
    context: { ...base.context, recordedAdl: RECORDED_ADL as never },
    selection: {
      templateKey: "chha_visit:chha",
      vocabVersion: base.selection.vocabVersion,
      encounterType: "chha_visit",
      discipline: "chha",
      sections: [],
    },
  };
}

const sectionOf = (inputs: DraftInputs, id: string): DraftSection => {
  const found = compileDraft(inputs, DEPS).sections.find((s) => s.sectionId === id);
  if (found === undefined) throw new Error(`no section '${id}'`);
  return found;
};
const textOf = (inputs: DraftInputs, id: string): string => {
  const s = sectionOf(inputs, id);
  return s.state === "drafted" ? s.text : "";
};
const draftedIds = (inputs: DraftInputs): string[] =>
  compileDraft(inputs, DEPS)
    .sections.filter((s) => s.state === "drafted")
    .map((s) => s.sectionId);

describe("the sections an LPN note drafts (scope is read off the corpus tags)", () => {
  it.each(LPN_PAIRS)("%s by an LPN drafts the vitals, the interventions and the plan", (type) => {
    expect([...draftedSectionIds(type, "lpn")].sort()).toEqual([
      "interventions",
      "plan",
      "vitals_review",
    ]);
    expect(templateHasDraftedSection(type, "lpn")).toBe(true);
    expect(draftedIds(lpnInputs(type))).toEqual(["vitals_review", "interventions", "plan"]);
  });

  it.each(LPN_PAIRS)(
    "%s: never drafts the PPS or ESAS-r sections, even with every scale reading supplied",
    (type) => {
      const inputs = lpnInputs(type);
      expect(inputs.scaleReadings.length).toBeGreaterThan(0);
      for (const id of ["assessment", "symptom_management", "chief_concern"]) {
        expect(sectionOf(inputs, id).state, id).toBe("empty");
      }
      for (const section of compileDraft(inputs, DEPS).sections) {
        if (section.state === "drafted") expect(section.text).not.toMatch(/PPS|ESAS/);
      }
    },
  );

  it("states the vitals, the care-plan interventions and medication changes, and the goals, as the routine visit does", () => {
    const inputs = lpnInputs("lpn_visit");
    const rn = baseInputs();
    for (const id of ["vitals_review", "interventions", "plan"]) {
      expect(textOf(inputs, id), id).toBe(textOf(rn, id));
    }
  });

  it("is Part 2 derived unless every source behind a section is proven not SUD-related (fail closed)", () => {
    const inputs = lpnInputs("lpn_visit");
    const withFlag = {
      ...inputs,
      medicationChanges: inputs.medicationChanges.map((m) => ({ ...m, sudRelated: undefined })),
    };
    const interventions = sectionOf(withFlag, "interventions");
    expect(interventions.state === "drafted" && interventions.part2Derived).toBe(true);
    const vitals = sectionOf(withFlag, "vitals_review");
    expect(vitals.state === "drafted" && vitals.part2Derived).toBe(false);
  });

  it("does not mutate its inputs", () => {
    const frozen = deepFreeze(lpnInputs("routine_visit"));
    expect(() => compileDraft(frozen, DEPS)).not.toThrow();
  });
});

describe("the sections an aide note drafts", () => {
  it("drafts the activities of daily living and nothing else", () => {
    expect([...draftedSectionIds("chha_visit", "chha")]).toEqual(["adl"]);
    expect(templateHasDraftedSection("chha_visit", "chha")).toBe(true);
    expect(draftedIds(aideInputs())).toEqual(["adl"]);
  });

  it("states the recorded ADLs first, then each care-plan intervention performed, by intervention id", () => {
    const inputs = aideInputs();
    const withTwo: DraftInputs = {
      ...inputs,
      carePlan: {
        goals: inputs.carePlan?.goals ?? [],
        interventions: [
          { id: "intervention-b", interventionText: "Assist with a bed bath", sudRelated: false },
          { id: "intervention-a", interventionText: "Change linens", sudRelated: false },
        ],
      },
    };
    expect(textOf(withTwo, "adl")).toBe(
      [
        describeRecordedAdl(RECORDED_ADL as never),
        "Care-plan intervention performed: Change linens.",
        "Care-plan intervention performed: Assist with a bed bath.",
      ].join(" "),
    );
  });

  it("an aide with no intervention has an empty adl (the usual assembly then states the recorded ADLs)", () => {
    const none: DraftInputs = { ...aideInputs(), carePlan: { goals: [], interventions: [] } };
    expect(sectionOf(none, "adl")).toEqual({
      sectionId: "adl",
      state: "empty",
      reason: "nothing_to_draft_from",
    });
    expect(sectionOf({ ...aideInputs(), carePlan: null }, "adl").state).toBe("empty");
  });

  it("states no ADL sentence when none was recorded, and never a default phrase", () => {
    const base = aideInputs();
    const { recordedAdl: _unused, ...context } = base.context;
    expect(textOf({ ...base, context }, "adl")).toBe(
      "Care-plan intervention performed: Skin assessment and repositioning schedule review.",
    );
  });

  it("states the dependence score and its change since the previous visit in the drafted adl text, and a new prior moves the content hash", () => {
    const base = aideInputs();
    const recordedAdl = {
      items: { bathing: "limited_assist", dressing: "extensive_assist" },
    } as const;
    const now: DraftInputs = { ...base, context: { ...base.context, recordedAdl } };
    const earlier = (level: "independent" | "limited_assist"): DraftInputs => ({
      ...now,
      context: {
        ...now.context,
        priorAdl: { on: "2026-11-10", items: { bathing: level, dressing: level } },
      },
    });
    expect(textOf(now, "adl")).toContain(
      "dependent in 2 of 2 assessed ADLs (bathing and dressing).",
    );
    expect(textOf(earlier("independent"), "adl")).toContain(
      "dependent in 2 of 2 assessed ADLs (bathing and dressing), up from 0 of 2 assessed at the visit on 2026-11-10.",
    );
    expect(textOf(earlier("independent"), "adl")).toBe(
      [
        describeRecordedAdl(recordedAdl, earlier("independent").context.priorAdl),
        "Care-plan intervention performed: Skin assessment and repositioning schedule review.",
      ].join(" "),
    );
    const hashOf = (inputs: DraftInputs): string | undefined => {
      const section = sectionOf(inputs, "adl");
      return section.state === "drafted" ? section.contentHash : undefined;
    };
    expect(hashOf(earlier("independent"))).not.toBe(hashOf(now));
    expect(hashOf(earlier("independent"))).not.toBe(hashOf(earlier("limited_assist")));
  });

  it("names the recorded ADLs as a source of the section, first as they lead the text, and none when no ADL was recorded", () => {
    const withAdl = sectionOf(aideInputs(), "adl");
    expect(withAdl.state === "drafted" && withAdl.sourceRefs.map((ref) => ref.kind)).toEqual([
      "recorded_adl",
      "care_plan_intervention",
    ]);
    const base = aideInputs();
    const { recordedAdl: _unused, ...context } = base.context;
    const without = sectionOf({ ...base, context }, "adl");
    expect(without.state === "drafted" && without.sourceRefs.map((ref) => ref.kind)).toEqual([
      "care_plan_intervention",
    ]);
  });

  it("never drafts the plan from the care-plan goals or the reason for visit, and states no scale, vitals or medication source", () => {
    const inputs = aideInputs();
    expect(inputs.carePlan?.goals.length).toBeGreaterThan(0);
    expect(inputs.vitals).not.toBeNull();
    for (const id of ["chief_concern", "plan"]) {
      expect(sectionOf(inputs, id).state, id).toBe("empty");
    }
    expect(textOf(inputs, "adl")).not.toMatch(/morphine|PPS|ESAS|blood pressure|BP /i);
  });

  it("is Part 2 derived when a care-plan intervention's parent problem is not proven non-SUD (fail closed)", () => {
    const base = aideInputs();
    const unknown: DraftInputs = {
      ...base,
      carePlan: {
        goals: [],
        interventions: [
          { id: "intervention-1", interventionText: "Bathing", sudRelated: undefined },
        ],
      },
    };
    const adl = sectionOf(unknown, "adl");
    expect(adl.state === "drafted" && adl.part2Derived).toBe(true);
    const known = sectionOf(base, "adl");
    expect(known.state === "drafted" && known.part2Derived).toBe(false);
  });

  it("changes its content hash when a recorded ADL changes, so a confirmation of the old text goes stale", () => {
    const base = aideInputs();
    const changed: DraftInputs = {
      ...base,
      context: {
        ...base.context,
        recordedAdl: { items: { bathing: "total_assistance" } } as never,
      },
    };
    const a = sectionOf(base, "adl");
    const b = sectionOf(changed, "adl");
    expect(a.state === "drafted" && b.state === "drafted" && a.contentHash !== b.contentHash).toBe(
      true,
    );
  });
});

describe("the sources a template needs read (draftSourceNeeds)", () => {
  it("an LPN visit needs the care plan, the vitals and the medication changes, and no scale", () => {
    for (const [type] of LPN_PAIRS) {
      expect(draftSourceNeeds(type, "lpn")).toEqual({
        carePlan: true,
        vitals: true,
        medicationChanges: true,
        scales: false,
        disciplinePlan: false,
        idgFollowUp: false,
      });
    }
  });

  it("an aide visit needs the care plan alone", () => {
    expect(draftSourceNeeds("chha_visit", "chha")).toEqual({
      carePlan: true,
      vitals: false,
      medicationChanges: false,
      scales: false,
      disciplinePlan: false,
      idgFollowUp: false,
    });
  });

  it("the RN visits that draft from every source need every source", () => {
    for (const type of ["routine_visit", "recert_visit", "admission_visit"] as const) {
      expect(draftSourceNeeds(type, "rn"), type).toEqual({
        carePlan: true,
        vitals: true,
        medicationChanges: true,
        scales: true,
        disciplinePlan: false,
        idgFollowUp: false,
      });
    }
  });

  it("the face-to-face visit needs the vitals and the scales (the PPS) and none of the S1 sources it never drafts from", () => {
    for (const discipline of ["md", "np"] as const) {
      expect(draftSourceNeeds("face_to_face", discipline), discipline).toEqual({
        carePlan: false,
        vitals: true,
        medicationChanges: false,
        scales: true,
        disciplinePlan: false,
        idgFollowUp: false,
      });
    }
  });

  it("a template that drafts nothing needs nothing", () => {
    expect(draftSourceNeeds("telephonic", "msw")).toEqual({
      carePlan: false,
      vitals: false,
      medicationChanges: false,
      scales: false,
      disciplinePlan: false,
      idgFollowUp: false,
    });
  });
});
