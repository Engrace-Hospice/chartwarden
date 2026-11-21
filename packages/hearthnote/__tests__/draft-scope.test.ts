// packages/hearthnote/__tests__/draft-scope.test.ts — which templates draft at all (S1 rollout scope, design §3.2).
// The answer is read off the corpus (the encounter-type and discipline tags of the draft phrases), never a hand-kept list of templates,
// and the compiler obeys it: a template the corpus does not draft stays empty even when every source is supplied.
import { DRAFT_VOCAB_CODES, VOCABULARY, entriesFor } from "@chartwarden/narrative-vocab";
import {
  ENCOUNTER_DISCIPLINE_RULES,
  type EncounterDiscipline,
  type EncounterType,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  type DraftInputs,
  HearthnoteAssemblyError,
  compileDraft,
  draftedSectionIds,
  emptyDraft,
  resolveTemplate,
  templateHasDraftedSection,
  templateKey,
} from "../src/index";
import { AS_OF, DEPS, admissionSources, baseInputs, recertSources } from "./_draft-fixtures";

type Pair = readonly [EncounterType, EncounterDiscipline];

const LEGAL_PAIRS: readonly Pair[] = (
  Object.keys(ENCOUNTER_DISCIPLINE_RULES) as EncounterType[]
).flatMap((type) => ENCOUNTER_DISCIPLINE_RULES[type].map((discipline): Pair => [type, discipline]));

/** Every source filled in and nothing selected: what the compiler would draft for the pair if the corpus allowed it. */
function maximalInputs([type, discipline]: Pair): DraftInputs {
  const base = baseInputs();
  return {
    ...base,
    ...recertSources(),
    ...admissionSources(),
    encounterType: type,
    discipline,
    selection: {
      templateKey: templateKey(type, discipline),
      vocabVersion: base.selection.vocabVersion,
      encounterType: type,
      discipline,
      sections: [],
    },
  };
}

const draftedIdsOf = (pair: Pair): readonly string[] =>
  compileDraft(maximalInputs(pair), DEPS)
    .sections.filter((s) => s.state === "drafted")
    .map((s) => s.sectionId);

describe("the templates the corpus drafts", () => {
  it("today that is the RN routine, admission and recertification visits and the face-to-face visit, and no other legal pair", () => {
    const drafted = LEGAL_PAIRS.filter(([type, discipline]) =>
      templateHasDraftedSection(type, discipline),
    ).map(([type, discipline]) => templateKey(type, discipline));
    expect(drafted).toEqual([
      "routine_visit:rn",
      "admission_visit:rn",
      "recert_visit:rn",
      "face_to_face:md",
      "face_to_face:np",
    ]);
  });

  it("names the five sections the sources feed in the RN routine visit, and never chief_concern", () => {
    expect([...draftedSectionIds("routine_visit", "rn")].sort()).toEqual([
      "assessment",
      "interventions",
      "plan",
      "symptom_management",
      "vitals_review",
    ]);
  });

  it("agrees with the compiler for EVERY legal pair, so a template the corpus gains cannot be missed", () => {
    for (const pair of LEGAL_PAIRS) {
      const [type, discipline] = pair;
      const key = templateKey(type, discipline);
      expect([...draftedIdsOf(pair)].sort(), key).toEqual(
        [...draftedSectionIds(type, discipline)].sort(),
      );
      expect(draftedIdsOf(pair).length > 0, key).toBe(templateHasDraftedSection(type, discipline));
    }
  });

  it("leaves every section of an undrafted template empty even with every source supplied", () => {
    const draft = compileDraft(maximalInputs(["chha_visit", "chha"]), DEPS);
    expect(draft.sections.map((s) => s.state)).toEqual(draft.sections.map(() => "empty"));
  });

  it("a section is drafted only when every phrase it is built from is tagged for the pair", () => {
    // Retag the RN routine visit's entries for the CHHA visit: its `plan` (care-plan goals) becomes draftable, its other sections do not exist.
    const retagged = entriesFor("routine_visit", "rn").map((entry) => ({
      ...entry,
      disciplines: ["chha"] as const,
      encounterTypes: ["chha_visit"] as const,
    }));
    expect([...draftedSectionIds("chha_visit", "chha", retagged)]).toEqual(["plan"]);
    // Drop one of the goal phrases: the section is no longer fully covered, so it is not drafted.
    const withoutGoal = retagged.filter((entry) => entry.code !== "nv.cp.goal_progress");
    expect([...draftedSectionIds("chha_visit", "chha", withoutGoal)]).toEqual([]);
  });

  it("is false for a pair that has no template", () => {
    expect(resolveTemplate("routine_visit", "volunteer")).toBeUndefined();
    expect(templateHasDraftedSection("routine_visit", "volunteer")).toBe(false);
  });

  it("the corpus tags the draft phrases for exactly the pairs the predicate accepts", () => {
    const tagged = new Set(
      VOCABULARY.filter((entry) => DRAFT_VOCAB_CODES.has(entry.code)).flatMap((entry) =>
        entry.encounterTypes.flatMap((type) =>
          entry.disciplines
            .filter((discipline) => ENCOUNTER_DISCIPLINE_RULES[type].includes(discipline))
            .map((discipline) => templateKey(type, discipline)),
        ),
      ),
    );
    const drafted = new Set(
      LEGAL_PAIRS.filter(([type, discipline]) => templateHasDraftedSection(type, discipline)).map(
        ([type, discipline]) => templateKey(type, discipline),
      ),
    );
    expect(drafted).toEqual(tagged);
  });
});

describe("emptyDraft", () => {
  it("is every section of the template, each empty with nothing to draft from, as of the instant given", () => {
    const draft = emptyDraft("chha_visit", "chha", AS_OF);
    expect(draft.templateKey).toBe("chha_visit:chha");
    expect(draft.asOf).toBe(AS_OF);
    expect(draft.sections).toEqual([
      { sectionId: "chief_concern", state: "empty", reason: "nothing_to_draft_from" },
      { sectionId: "adl", state: "empty", reason: "nothing_to_draft_from" },
      { sectionId: "plan", state: "empty", reason: "nothing_to_draft_from" },
    ]);
  });

  it("refuses a pair that has no template, like the compiler", () => {
    expect(() => emptyDraft("routine_visit", "volunteer", AS_OF)).toThrow(HearthnoteAssemblyError);
  });
});
