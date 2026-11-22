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
  draftSourceNeeds,
  draftedSectionIds,
  emptyDraft,
  resolveTemplate,
  templateHasDraftedSection,
  templateKey,
} from "../src/index";
import {
  AS_OF,
  DEPS,
  admissionSources,
  baseInputs,
  disciplinePlanSources,
  recertSources,
} from "./_draft-fixtures";

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
    ...disciplinePlanSources(),
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
  it("today that is the RN routine, admission and recertification visits, the face-to-face visit, the LPN visits, the aide visit, the social-work and chaplain visits, and the IDG follow-up of all six disciplines, and no other legal pair", () => {
    const drafted = LEGAL_PAIRS.filter(([type, discipline]) =>
      templateHasDraftedSection(type, discipline),
    ).map(([type, discipline]) => templateKey(type, discipline));
    expect(drafted).toEqual([
      "routine_visit:rn",
      "routine_visit:lpn",
      "admission_visit:rn",
      "recert_visit:rn",
      "face_to_face:md",
      "face_to_face:np",
      "lpn_visit:lpn",
      "chha_visit:chha",
      "msw_assessment:msw",
      "msw_followup:msw",
      "chaplain_assessment:chaplain",
      "chaplain_visit:chaplain",
      "idg_followup:rn",
      "idg_followup:lpn",
      "idg_followup:msw",
      "idg_followup:chaplain",
      "idg_followup:md",
      "idg_followup:np",
    ]);
  });

  // S5 (VN-D52): each pair drafts exactly the sections its discipline's own visit drafts, and a physician or nurse practitioner only the recorded
  // vitals (and, in the face-to-face visit, the orders in effect and the S2 decline evidence). Without an explicit set, a pair that falls back to the
  // routine visit's sources could draft a section its discipline's rules forbid; this pins every set.
  it("the IDG follow-up drafts as the discipline's own visit does, and the telephonic visit drafts nothing for any discipline (S5)", () => {
    const sorted = (type: EncounterType, discipline: EncounterDiscipline) =>
      [...draftedSectionIds(type, discipline)].sort();
    expect(sorted("idg_followup", "rn")).toEqual(sorted("routine_visit", "rn"));
    expect(sorted("idg_followup", "lpn")).toEqual(sorted("routine_visit", "lpn"));
    expect(sorted("idg_followup", "msw")).toEqual(sorted("msw_followup", "msw"));
    expect(sorted("idg_followup", "chaplain")).toEqual(sorted("chaplain_visit", "chaplain"));
    for (const discipline of ["md", "np"] as const) {
      expect(sorted("idg_followup", discipline), `idg_followup:${discipline}`).toEqual([
        "vitals_review",
      ]);
      expect(sorted("face_to_face", discipline), `face_to_face:${discipline}`).toEqual([
        "med_reconciliation",
        "prognosis",
        "vitals_review",
      ]);
    }
    for (const discipline of ENCOUNTER_DISCIPLINE_RULES.telephonic) {
      expect(sorted("telephonic", discipline), `telephonic:${discipline}`).toEqual([]);
    }
  });

  // S5 (VN-D53): the sections a physician's or nurse practitioner's note leaves to the clinician's own words, and the IDG follow-up's own section (VN-D54).
  it("never drafts a physician's or nurse practitioner's own judgement, an attestation, or the IDG decision follow-up section", () => {
    for (const [type, discipline] of LEGAL_PAIRS) {
      const drafted = draftedSectionIds(type, discipline);
      expect(drafted.has("idg_followup"), `${type}:${discipline}`).toBe(false);
      expect(drafted.has("f2f_attestation"), `${type}:${discipline}`).toBe(false);
      if (discipline !== "md" && discipline !== "np") continue;
      for (const id of [
        "chief_concern",
        "assessment",
        "symptom_management",
        "functional_status",
        "nutrition",
        "skin_wounds",
        "interventions",
        "plan",
      ]) {
        expect(drafted.has(id), `${type}:${discipline} ${id}`).toBe(false);
      }
    }
  });

  it("never drafts a psychosocial, spiritual, family-dynamics or reason-for-visit section for any pair (VN-D45)", () => {
    for (const [type, discipline] of LEGAL_PAIRS) {
      const drafted = draftedSectionIds(type, discipline);
      for (const id of ["psychosocial", "spiritual", "family_dynamics"]) {
        expect(drafted.has(id), `${type}:${discipline} ${id}`).toBe(false);
      }
      if (discipline === "msw" || discipline === "chaplain") {
        expect(drafted.has("chief_concern"), `${type}:${discipline}`).toBe(false);
      }
    }
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
    const draft = compileDraft(maximalInputs(["telephonic", "msw"]), DEPS);
    expect(draft.sections.map((s) => s.state)).toEqual(draft.sections.map(() => "empty"));
  });

  it("a section is drafted only when every phrase it is built from is tagged for the pair", () => {
    // Retag the RN routine visit's entries for a social-work telephonic note, which has no map of its own and so reads as the routine visit:
    // its `interventions` and `plan` (the care plan) become draftable, its other sections do not exist in that template.
    const retagged = entriesFor("routine_visit", "rn").map((entry) => ({
      ...entry,
      disciplines: ["msw"] as const,
      encounterTypes: ["telephonic"] as const,
    }));
    expect([...draftedSectionIds("telephonic", "msw", retagged)].sort()).toEqual([
      "interventions",
      "plan",
    ]);
    // Drop one of the goal phrases: `plan` is no longer fully covered, so it is not drafted.
    const withoutGoal = retagged.filter((entry) => entry.code !== "nv.cp.goal_progress");
    expect([...draftedSectionIds("telephonic", "msw", withoutGoal)]).toEqual(["interventions"]);
  });

  it("the social-work and chaplain templates follow their own phrases (S4), not the routine visit's", () => {
    // Every phrase the social-work follow-up is drafted from is tagged for it: both sections draft.
    expect([...draftedSectionIds("msw_followup", "msw")].sort()).toEqual(["interventions", "plan"]);
    // Drop one goal phrase: `plan` is not fully covered, so it stops drafting; the interventions stay.
    const real = entriesFor("msw_followup", "msw");
    const withoutAgentGoal = real.filter((entry) => entry.code !== "nv.dp.goal_agent");
    expect([...draftedSectionIds("msw_followup", "msw", withoutAgentGoal)]).toEqual([
      "interventions",
    ]);
    // Drop one intervention phrase: the other way round.
    const withoutFrequency = real.filter((entry) => entry.code !== "nv.dp.intervention_frequency");
    expect([...draftedSectionIds("msw_followup", "msw", withoutFrequency)]).toEqual(["plan"]);
    // The routine visit's phrases tagged for the pair draft nothing there: the care plan is not this template's source.
    const routine = entriesFor("routine_visit", "rn").map((entry) => ({
      ...entry,
      disciplines: ["msw"] as const,
      encounterTypes: ["msw_followup"] as const,
    }));
    expect([...draftedSectionIds("msw_followup", "msw", routine)]).toEqual([]);
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

// S3: `draftSourceNeeds` decides which sources are READ (and which read keys are asked), so it must be exactly what the drafted sections are
// built from. A row that omits a source the builder uses would pass every literal check and draft short of its sources; this one compiles.
describe("the sources a template needs read are the sources its drafted sections are built from", () => {
  const WITHOUT = {
    carePlan: { carePlan: null },
    vitals: { vitals: null },
    medicationChanges: { medicationChanges: [] },
    scales: { scaleReadings: [] },
    disciplinePlan: { disciplinePlan: null },
  } as const;
  const SOURCES = Object.keys(WITHOUT) as (keyof typeof WITHOUT)[];
  const DRAFTED_PAIRS = LEGAL_PAIRS.filter(([type, discipline]) =>
    templateHasDraftedSection(type, discipline),
  );
  const draftOf = (pair: Pair, without: Partial<DraftInputs>) =>
    compileDraft({ ...maximalInputs(pair), ...without }, DEPS);

  for (const pair of DRAFTED_PAIRS) {
    it(`${templateKey(pair[0], pair[1])}: taking away a source it needs changes the draft, and one it does not need changes nothing`, () => {
      const needs = draftSourceNeeds(pair[0], pair[1]);
      const full = draftOf(pair, {});
      for (const source of SOURCES) {
        const without = draftOf(pair, WITHOUT[source]);
        if (needs[source]) expect(without, `${source} is needed`).not.toEqual(full);
        else expect(without, `${source} is not needed`).toEqual(full);
      }
    });
  }
});
