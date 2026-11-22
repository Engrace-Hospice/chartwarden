// packages/hearthnote/__tests__/draft-msw-chaplain.test.ts — S4: the social-work and chaplain visits' draft (design §3.6, VN-D45 to VN-D50).
// Synthetic names and ids only: no SSN, MBI, or value copied from a real record.
//
// What these pin: which sections the four templates draft (scope is read off the corpus tags: the plan on all four, the interventions on the two
// social-work templates, and never a psychosocial, spiritual, family or reason-for-visit section), that the text states what the discipline's plan
// lists and nothing of status, progress or outcome, who stated a goal where the record says so, that the M7 care plan is not the source, the sources
// each template needs read, and fail-closed Part 2.
import { describe, expect, it } from "vitest";
import {
  DraftInputError,
  type DraftInputs,
  type DraftSection,
  compileDraft,
  draftSourceNeeds,
  draftedSectionIds,
  templateHasDraftedSection,
} from "../src/index";
import {
  DEPS,
  baseInputs,
  deepFreeze,
  disciplinePlanSources,
  reverseKeys,
} from "./_draft-fixtures";

const MSW_PAIRS = [
  ["msw_assessment", "msw"],
  ["msw_followup", "msw"],
] as const;
const CHAPLAIN_PAIRS = [
  ["chaplain_assessment", "chaplain"],
  ["chaplain_visit", "chaplain"],
] as const;
const ALL_PAIRS = [...MSW_PAIRS, ...CHAPLAIN_PAIRS] as const;

type Pair = (typeof ALL_PAIRS)[number];

/** A social-work or chaplain visit: the discipline plan supplied, nothing selected. The M7 care plan is supplied too, to prove it is not read. */
function inputsFor([type, discipline]: Pair): DraftInputs {
  const base = baseInputs();
  return {
    ...base,
    ...disciplinePlanSources(),
    encounterType: type,
    discipline,
    selection: {
      templateKey: `${type}:${discipline}`,
      vocabVersion: base.selection.vocabVersion,
      encounterType: type,
      discipline,
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

describe("the sections a social-work or chaplain note drafts (scope is read off the corpus tags)", () => {
  it.each(MSW_PAIRS)("%s by a social worker drafts the interventions and the plan", (type, d) => {
    expect([...draftedSectionIds(type, d)].sort()).toEqual(["interventions", "plan"]);
    expect(templateHasDraftedSection(type, d)).toBe(true);
    expect(draftedIds(inputsFor([type, d]))).toEqual(["interventions", "plan"]);
  });

  it.each(CHAPLAIN_PAIRS)("%s by a chaplain drafts the plan alone", (type, d) => {
    expect([...draftedSectionIds(type, d)]).toEqual(["plan"]);
    expect(templateHasDraftedSection(type, d)).toBe(true);
    expect(draftedIds(inputsFor([type, d]))).toEqual(["plan"]);
  });

  it.each(ALL_PAIRS)(
    "%s never drafts the reason for visit or an assessment, even with every source supplied (VN-D45)",
    (type, d) => {
      const inputs = inputsFor([type, d] as Pair);
      expect(inputs.carePlan?.goals.length).toBeGreaterThan(0);
      for (const id of ["chief_concern", "psychosocial", "spiritual", "family_dynamics"]) {
        const found = compileDraft(inputs, DEPS).sections.find((s) => s.sectionId === id);
        if (found !== undefined) expect(found.state, id).toBe("empty");
      }
    },
  );
});

describe("what the plan section states", () => {
  it("lists each open goal by goal id, with who stated it where the record says it was not the clinician", () => {
    expect(textOf(inputsFor(["msw_followup", "msw"]), "plan")).toBe(
      [
        "Plan-of-care goal, stated by the patient: See my grandson.",
        "Plan-of-care goal: Name two ways to cope with the diagnosis.",
        "Plan-of-care goal, stated by the family: Plan the memorial together.",
        "Plan-of-care goal, stated by the patient's agent: Keep the farm in the family.",
      ].join(" "),
    );
  });

  it("states the same plan for a chaplain visit", () => {
    expect(textOf(inputsFor(["chaplain_visit", "chaplain"]), "plan")).toBe(
      textOf(inputsFor(["msw_followup", "msw"]), "plan"),
    );
  });

  it("says nothing of status, progress, outcome or anything done", () => {
    for (const pair of ALL_PAIRS) {
      // The chaplain's template has no interventions section: judge the sections each template drafts.
      for (const id of draftedIds(inputsFor(pair))) {
        expect(textOf(inputsFor(pair), id), `${pair[0]} ${id}`).not.toMatch(
          /progress|status|outcome|achiev|complet|perform|met\b|improv|declin/i,
        );
      }
    }
  });

  it("names the discipline plan's goals as the sources, by kind, in the order stated", () => {
    const plan = sectionOf(inputsFor(["msw_assessment", "msw"]), "plan");
    expect(plan.state === "drafted" && plan.sourceRefs).toEqual([
      { kind: "discipline_plan_goal", id: "goal-a" },
      { kind: "discipline_plan_goal", id: "goal-b" },
      { kind: "discipline_plan_goal", id: "goal-c" },
      { kind: "discipline_plan_goal", id: "goal-d" },
    ]);
  });

  it("is empty with no plan, and with a plan of interventions only", () => {
    const inputs = inputsFor(["msw_followup", "msw"]);
    const empty = { sectionId: "plan", state: "empty", reason: "nothing_to_draft_from" };
    expect(sectionOf({ ...inputs, disciplinePlan: null }, "plan")).toEqual(empty);
    expect(sectionOf({ ...inputs, disciplinePlan: undefined }, "plan")).toEqual(empty);
    expect(
      sectionOf(
        {
          ...inputs,
          disciplinePlan: { goals: [], interventions: inputs.disciplinePlan?.interventions ?? [] },
        },
        "plan",
      ),
    ).toEqual(empty);
  });

  it("never drafts the plan from the M7 care plan's goals", () => {
    const inputs = inputsFor(["msw_followup", "msw"]);
    expect(inputs.carePlan?.goals.length).toBeGreaterThan(0);
    expect(textOf(inputs, "plan")).not.toContain("Care-plan goal");
    expect(textOf({ ...inputs, disciplinePlan: null }, "plan")).toBe("");
  });
});

describe("what the interventions section states (social work)", () => {
  it.each(MSW_PAIRS)(
    "%s lists each active intervention by id, with its frequency when it has one",
    (type, d) => {
      expect(textOf(inputsFor([type, d]), "interventions")).toBe(
        [
          "Plan-of-care intervention: Caregiver resource referral.",
          "Plan-of-care intervention: Supportive counselling; frequency: weekly.",
          "Plan-of-care intervention: Legacy work.",
        ].join(" "),
      );
    },
  );

  it("names the discipline plan's interventions as the sources", () => {
    const section = sectionOf(inputsFor(["msw_followup", "msw"]), "interventions");
    expect(section.state === "drafted" && section.sourceRefs.map((r) => r.kind)).toEqual([
      "discipline_plan_intervention",
      "discipline_plan_intervention",
      "discipline_plan_intervention",
    ]);
  });

  it("never drafts the M7 care plan's interventions or the medication changes into it", () => {
    const text = textOf(inputsFor(["msw_followup", "msw"]), "interventions");
    expect(text).not.toContain("Care-plan intervention");
    expect(text).not.toMatch(/morphine/i);
  });

  it.each([".", "...", " . "])(
    "states an intervention whose frequency is only %j without a frequency, as it does for none",
    (frequencyText) => {
      const inputs = inputsFor(["msw_followup", "msw"]);
      const bare: DraftInputs = {
        ...inputs,
        disciplinePlan: {
          goals: inputs.disciplinePlan?.goals ?? [],
          interventions: [
            {
              id: "iv-a",
              interventionText: "Supportive counselling",
              frequencyText,
              sudRelated: false,
            },
          ],
        },
      };
      expect(textOf(bare, "interventions")).toBe(
        "Plan-of-care intervention: Supportive counselling.",
      );
    },
  );

  it("is empty with no intervention", () => {
    const inputs = inputsFor(["msw_followup", "msw"]);
    expect(
      sectionOf(
        {
          ...inputs,
          disciplinePlan: { goals: inputs.disciplinePlan?.goals ?? [], interventions: [] },
        },
        "interventions",
      ),
    ).toEqual({ sectionId: "interventions", state: "empty", reason: "nothing_to_draft_from" });
  });
});

describe("the draft is deterministic and fail closed", () => {
  it("does not depend on the order the sources arrive in, nor on the order of object keys", () => {
    for (const pair of ALL_PAIRS) {
      const inputs = inputsFor(pair);
      const plan = inputs.disciplinePlan;
      const reordered: DraftInputs = {
        ...inputs,
        disciplinePlan:
          plan === null || plan === undefined
            ? plan
            : {
                goals: [...plan.goals].reverse(),
                interventions: [...plan.interventions].reverse(),
              },
      };
      expect(compileDraft(reverseKeys(reordered), DEPS)).toEqual(compileDraft(inputs, DEPS));
    }
  });

  it("does not mutate its inputs", () => {
    expect(() =>
      compileDraft(deepFreeze(inputsFor(["msw_assessment", "msw"])), DEPS),
    ).not.toThrow();
  });

  it("is Part 2 derived unless every goal behind the section is proven not SUD-related", () => {
    const inputs = inputsFor(["msw_followup", "msw"]);
    const goals = inputs.disciplinePlan?.goals ?? [];
    const unknown: DraftInputs = {
      ...inputs,
      disciplinePlan: {
        goals: goals.map((g, i) => (i === 0 ? { ...g, sudRelated: undefined } : g)),
        interventions: inputs.disciplinePlan?.interventions ?? [],
      },
    };
    const plan = sectionOf(unknown, "plan");
    expect(plan.state === "drafted" && plan.part2Derived).toBe(true);
    // The interventions are a different source: one goal of unknown flag does not make them Part 2.
    const interventions = sectionOf(unknown, "interventions");
    expect(interventions.state === "drafted" && interventions.part2Derived).toBe(false);
    const known = sectionOf(inputs, "plan");
    expect(known.state === "drafted" && known.part2Derived).toBe(false);
  });

  it("is Part 2 derived when an intervention's flag is not the literal false", () => {
    const inputs = inputsFor(["msw_followup", "msw"]);
    const interventions = inputs.disciplinePlan?.interventions ?? [];
    const flagged: DraftInputs = {
      ...inputs,
      disciplinePlan: {
        goals: inputs.disciplinePlan?.goals ?? [],
        interventions: interventions.map((i) => ({ ...i, sudRelated: null })),
      },
    };
    const section = sectionOf(flagged, "interventions");
    expect(section.state === "drafted" && section.part2Derived).toBe(true);
  });

  it("changes its content hash when a goal's words change, so a confirmation of the old text goes stale", () => {
    const base = inputsFor(["msw_followup", "msw"]);
    const goals = base.disciplinePlan?.goals ?? [];
    const changed: DraftInputs = {
      ...base,
      disciplinePlan: {
        goals: goals.map((g) =>
          g.id === "goal-a" ? { ...g, goalText: "See my granddaughter" } : g,
        ),
        interventions: base.disciplinePlan?.interventions ?? [],
      },
    };
    const a = sectionOf(base, "plan");
    const b = sectionOf(changed, "plan");
    expect(a.state === "drafted" && b.state === "drafted" && a.contentHash !== b.contentHash).toBe(
      true,
    );
  });

  it("refuses a goal stated by someone the record does not name, and a goal with no words", () => {
    const base = inputsFor(["msw_followup", "msw"]);
    const interventions = base.disciplinePlan?.interventions ?? [];
    const withGoal = (goal: Record<string, unknown>): DraftInputs =>
      ({ ...base, disciplinePlan: { goals: [goal], interventions } }) as unknown as DraftInputs;
    expect(() =>
      compileDraft(
        withGoal({ id: "g", goalText: "x", statedBy: "oracle", sudRelated: false }),
        DEPS,
      ),
    ).toThrow(DraftInputError);
    expect(() =>
      compileDraft(withGoal({ id: "g", goalText: "  ", statedBy: null, sudRelated: false }), DEPS),
    ).toThrow(DraftInputError);
  });
});

describe("the sources a social-work or chaplain template needs read (draftSourceNeeds)", () => {
  it.each(ALL_PAIRS)("%s needs the discipline plan alone", (type, d) => {
    expect(draftSourceNeeds(type, d)).toEqual({
      carePlan: false,
      vitals: false,
      medicationChanges: false,
      scales: false,
      disciplinePlan: true,
    });
  });
});
