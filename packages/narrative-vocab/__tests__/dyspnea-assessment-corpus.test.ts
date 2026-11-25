// The dyspnea assessment statements: the corpus entries the composer's helper records, pinned to the rules in `@chartwarden/types`.
// The choice strings are COPIED into the corpus (a shipped phrase's bytes are D11-pinned); these tests are what keeps the copy and
// the rule constants from drifting apart. The existing "dyspnea limiting function" statement they hang off is unchanged.
import { createHash } from "node:crypto";
import {
  DYSPNEA_ASSESSMENT_CODES,
  DYSPNEA_CHANGE_OPTIONS,
  DYSPNEA_PLAN_DECISIONS,
  DYSPNEA_RESPONSE_OPTIONS,
  DYSPNEA_SETTING_OPTIONS,
  DYSPNEA_SLOTS,
  DYSPNEA_STATEMENT_CODE,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { DYSPNEA_ASSESSMENT_VOCABULARY } from "../src/dyspnea-assessment-entries";
import {
  VOCABULARY,
  VOCAB_BY_CODE,
  entriesFor,
  entrySlots,
  validateSelectionTree,
} from "../src/index";

/** Every shipped phrase, as the spec states it. */
const EXPECTED_PHRASES: Readonly<Record<string, string>> = {
  [DYSPNEA_ASSESSMENT_CODES.score]: "Dyspnea intensity: ${dyspnea_score} of 10",
  [DYSPNEA_ASSESSMENT_CODES.onset]: "Dyspnea onset: ${dyspnea_onset}",
  [DYSPNEA_ASSESSMENT_CODES.setting]: "Dyspnea occurs ${dyspnea_setting}",
  [DYSPNEA_ASSESSMENT_CODES.triggers]: "Dyspnea is brought on or made worse by ${dyspnea_triggers}",
  [DYSPNEA_ASSESSMENT_CODES.relievedBy]: "Dyspnea is relieved by ${dyspnea_relieved_by}",
  [DYSPNEA_ASSESSMENT_CODES.quality]: "Dyspnea quality: ${dyspnea_quality}",
  [DYSPNEA_ASSESSMENT_CODES.distress]: "Distress or anxiety with dyspnea: ${dyspnea_distress}",
  [DYSPNEA_ASSESSMENT_CODES.function]: "Effect of dyspnea on function: ${dyspnea_function}",
  [DYSPNEA_ASSESSMENT_CODES.nonDrug]: "Non-drug measures for dyspnea: ${dyspnea_nondrug}",
  [DYSPNEA_ASSESSMENT_CODES.response]: "Dyspnea response to measures: ${dyspnea_response}",
  [DYSPNEA_ASSESSMENT_CODES.goal]: "${patient}'s acceptable dyspnea level is ${dyspnea_goal} of 10",
  [DYSPNEA_ASSESSMENT_CODES.lastScore]: "Dyspnea at the last visit was ${dyspnea_last_score} of 10",
  [DYSPNEA_ASSESSMENT_CODES.change]: "Change in dyspnea since the last visit: ${dyspnea_change}",
  [DYSPNEA_ASSESSMENT_CODES.nonverbal]:
    "${patient} is unable to self-report dyspnea; signs observed: ${dyspnea_nonverbal}",
  [DYSPNEA_ASSESSMENT_CODES.planDecision]: "Plan of care for dyspnea: ${dyspnea_plan_decision}",
};

/** sha256 (first 16 hex) of every shipped phrase: a note signed under 2026.12.6 must re-read identically, so a changed phrase needs a new code. */
const PHRASE_PINS: Readonly<Record<string, string>> = {
  "nv.sym.dyspnea_score": "022952131fef3133",
  "nv.sym.dyspnea_onset": "3bf3f22849c5ead0",
  "nv.sym.dyspnea_setting": "a7e432e7fc1e4c80",
  "nv.sym.dyspnea_triggers": "d35d6490c18b15f0",
  "nv.sym.dyspnea_relieved_by": "26608c56cbe23835",
  "nv.sym.dyspnea_quality": "e0b528c48dfd1ac9",
  "nv.sym.dyspnea_distress": "db6d69fd3ceda1f2",
  "nv.sym.dyspnea_function": "35d00ebb6f715110",
  "nv.sym.dyspnea_nondrug": "6c16721f45524fa4",
  "nv.sym.dyspnea_response": "ed803051da893fae",
  "nv.sym.dyspnea_goal": "aa1e6fc787371276",
  "nv.sym.dyspnea_last_score": "8e7cdc8c70b7ed8b",
  "nv.sym.dyspnea_change": "4ee80565ba878f79",
  "nv.sym.dyspnea_nonverbal": "bfc0277ab7937273",
  "nv.sym.dyspnea_plan_decision": "60471cf7cdac12bc",
};

/**
 * sha256 (first 16 hex) of each choice list as the corpus ships it (`JSON.stringify` of the options, in order). The corpus copies the
 * strings and `@chartwarden/types` holds its own copy, so a test that only compares the two passes when both are edited together; these
 * pins fail on that edit too (a shipped choice string never changes; ship a new code instead).
 */
const CHOICE_PINS: Readonly<Record<string, string>> = {
  "nv.sym.dyspnea_setting": "b5809220331a1eb7",
  "nv.sym.dyspnea_response": "86f178e2419beba5",
  "nv.sym.dyspnea_change": "f0678cdfb5b081cc",
  "nv.sym.dyspnea_plan_decision": "e4ddb5df8dd6d525",
};

const SECTION = "symptom_management";
const validate = (
  code: string,
  params: Record<string, string | number>,
  requireComplete = true,
): string[] =>
  validateSelectionTree([{ sectionId: SECTION, entries: [{ code, params }] }], {
    requireComplete,
  }).map((i) => `${i.code}:${i.slot ?? ""}`);

/** Every helper statement and the slots its phrase must carry. */
const EXPECTED_SLOTS: Readonly<Record<string, readonly string[]>> = {
  [DYSPNEA_ASSESSMENT_CODES.score]: [DYSPNEA_SLOTS.score],
  [DYSPNEA_ASSESSMENT_CODES.onset]: [DYSPNEA_SLOTS.onset],
  [DYSPNEA_ASSESSMENT_CODES.setting]: [DYSPNEA_SLOTS.setting],
  [DYSPNEA_ASSESSMENT_CODES.triggers]: [DYSPNEA_SLOTS.triggers],
  [DYSPNEA_ASSESSMENT_CODES.relievedBy]: [DYSPNEA_SLOTS.relievedBy],
  [DYSPNEA_ASSESSMENT_CODES.quality]: [DYSPNEA_SLOTS.quality],
  [DYSPNEA_ASSESSMENT_CODES.distress]: [DYSPNEA_SLOTS.distress],
  [DYSPNEA_ASSESSMENT_CODES.function]: [DYSPNEA_SLOTS.function],
  [DYSPNEA_ASSESSMENT_CODES.nonDrug]: [DYSPNEA_SLOTS.nonDrug],
  [DYSPNEA_ASSESSMENT_CODES.response]: [DYSPNEA_SLOTS.response],
  [DYSPNEA_ASSESSMENT_CODES.goal]: [DYSPNEA_SLOTS.goal],
  [DYSPNEA_ASSESSMENT_CODES.lastScore]: [DYSPNEA_SLOTS.lastScore],
  [DYSPNEA_ASSESSMENT_CODES.change]: [DYSPNEA_SLOTS.change],
  [DYSPNEA_ASSESSMENT_CODES.nonverbal]: [DYSPNEA_SLOTS.nonverbal],
  [DYSPNEA_ASSESSMENT_CODES.planDecision]: [DYSPNEA_SLOTS.planDecision],
};

const optionsOf = (code: string, slot: string): readonly string[] | undefined => {
  const spec = VOCAB_BY_CODE.get(code)?.slotSpecs?.[slot];
  return spec?.kind === "choice" ? spec.options : undefined;
};

describe("the dyspnea assessment corpus entries", () => {
  it("are exactly the statements the shared rules name, each once, and are in the corpus", () => {
    const shipped = DYSPNEA_ASSESSMENT_VOCABULARY.map((e) => e.code).sort();
    expect(shipped).toEqual(Object.values(DYSPNEA_ASSESSMENT_CODES).sort());
    expect(shipped).toHaveLength(15);
    for (const code of shipped) expect(VOCAB_BY_CODE.get(code)).toBeDefined();
  });

  it("add nothing else under the dyspnea prefix: no oxygen, teaching or observation-scale statement", () => {
    const prefixed = VOCABULARY.map((e) => e.code)
      .filter((code) => code.startsWith("nv.sym.dyspnea_"))
      .sort();
    expect(prefixed).toEqual(
      [...Object.values(DYSPNEA_ASSESSMENT_CODES), DYSPNEA_STATEMENT_CODE].sort(),
    );
  });

  it("fill the slots the rules read, and no others", () => {
    for (const entry of DYSPNEA_ASSESSMENT_VOCABULARY) {
      expect(entrySlots(entry), entry.code).toEqual(EXPECTED_SLOTS[entry.code]);
    }
  });

  it("offer the same choices the rules recognise", () => {
    const at = DYSPNEA_ASSESSMENT_CODES;
    expect(optionsOf(at.setting, DYSPNEA_SLOTS.setting)).toEqual([...DYSPNEA_SETTING_OPTIONS]);
    expect(optionsOf(at.response, DYSPNEA_SLOTS.response)).toEqual([...DYSPNEA_RESPONSE_OPTIONS]);
    expect(optionsOf(at.change, DYSPNEA_SLOTS.change)).toEqual([...DYSPNEA_CHANGE_OPTIONS]);
    expect(optionsOf(at.planDecision, DYSPNEA_SLOTS.planDecision)).toEqual([
      ...DYSPNEA_PLAN_DECISIONS,
    ]);
  });

  it("limit the three 0 to 10 slots to whole numbers from 0 to 10, and make no other slot a number", () => {
    const at = DYSPNEA_ASSESSMENT_CODES;
    const numeric = [
      [at.score, DYSPNEA_SLOTS.score],
      [at.goal, DYSPNEA_SLOTS.goal],
      [at.lastScore, DYSPNEA_SLOTS.lastScore],
    ] as const;
    for (const [code, slot] of numeric) {
      const spec = VOCAB_BY_CODE.get(code)?.slotSpecs?.[slot];
      expect(spec, code).toMatchObject({ kind: "integer", min: 0, max: 10 });
    }
    const specs = DYSPNEA_ASSESSMENT_VOCABULARY.flatMap((e) => Object.values(e.slotSpecs ?? {}));
    expect(specs.filter((s) => s.kind === "integer")).toHaveLength(3);
    expect(specs.filter((s) => s.kind === "choice")).toHaveLength(4);
    expect(specs).toHaveLength(7);
  });

  it("surface wherever the dyspnea statement does, in the same symptom menu, and contradict nothing", () => {
    const impact = VOCAB_BY_CODE.get(DYSPNEA_STATEMENT_CODE);
    expect(impact?.disciplines.length).toBeGreaterThan(0);
    for (const entry of DYSPNEA_ASSESSMENT_VOCABULARY) {
      expect(entry.category, entry.code).toBe("symptom_impact");
      expect(entry.disciplines, entry.code).toEqual(impact?.disciplines);
      expect(entry.encounterTypes, entry.code).toEqual(impact?.encounterTypes);
      expect(entry.exclusiveGroup, entry.code).toBeUndefined();
    }
    const menu = entriesFor("routine_visit", "rn").map((e) => e.code);
    for (const code of Object.values(DYSPNEA_ASSESSMENT_CODES)) expect(menu).toContain(code);
    const phone = entriesFor("telephonic", "rn").map((e) => e.code);
    for (const code of Object.values(DYSPNEA_ASSESSMENT_CODES)) expect(phone).not.toContain(code);
  });

  it("carry the phrases the spec states, byte for byte", () => {
    expect(Object.keys(EXPECTED_PHRASES).sort()).toEqual(
      Object.values(DYSPNEA_ASSESSMENT_CODES).sort(),
    );
    for (const entry of DYSPNEA_ASSESSMENT_VOCABULARY) {
      expect(entry.phrase, entry.code).toBe(EXPECTED_PHRASES[entry.code]);
    }
  });

  it("pins every phrase byte for byte (a shipped phrase never changes; ship a new code instead)", () => {
    expect(Object.keys(PHRASE_PINS).sort()).toEqual(Object.values(DYSPNEA_ASSESSMENT_CODES).sort());
    for (const entry of DYSPNEA_ASSESSMENT_VOCABULARY) {
      const actual = createHash("sha256").update(entry.phrase).digest("hex").slice(0, 16);
      expect(actual, `${entry.code}'s phrase changed`).toBe(PHRASE_PINS[entry.code]);
    }
  });

  it("pins every choice list byte for byte, independent of the copy in the rules package", () => {
    const slots = DYSPNEA_ASSESSMENT_VOCABULARY.flatMap((entry) =>
      Object.entries(entry.slotSpecs ?? {}).map(
        ([slot, spec]) => [entry.code, slot, spec] as const,
      ),
    );
    const choices = slots.filter(([, , spec]) => spec.kind === "choice");
    expect(choices.map(([code]) => code).sort()).toEqual(Object.keys(CHOICE_PINS).sort());
    for (const [code, slot, spec] of choices) {
      const options = spec.kind === "choice" ? spec.options : [];
      const actual = createHash("sha256")
        .update(JSON.stringify(options))
        .digest("hex")
        .slice(0, 16);
      expect(actual, `${code}.${slot}'s choices changed`).toBe(CHOICE_PINS[code]);
    }
  });

  it("state only what the clinician typed or chose: no threshold, oxygen, dose or scale wording", () => {
    for (const entry of DYSPNEA_ASSESSMENT_VOCABULARY) {
      for (const banned of [/severe/i, /oxygen/i, /\bRDOS\b/, /titrat/i, /\bdose\b/i, /opioid/i]) {
        expect(entry.phrase, entry.code).not.toMatch(banned);
      }
    }
  });

  it("leave the dyspnea statement they hang off unchanged, byte for byte", () => {
    expect(VOCAB_BY_CODE.get(DYSPNEA_STATEMENT_CODE)?.phrase).toBe(
      "Dyspnea limits ${patient}'s ability to ambulate beyond ${ambulation_distance}",
    );
  });
});

describe("a selected dyspnea assessment statement is validated like any other", () => {
  it("is complete only when every slot is filled", () => {
    expect(validate(DYSPNEA_ASSESSMENT_CODES.onset, {})).toEqual(["SLOT_INCOMPLETE:dyspnea_onset"]);
    expect(validate(DYSPNEA_ASSESSMENT_CODES.onset, { dyspnea_onset: "two days ago" })).toEqual([]);
  });

  it("lets a draft be saved half-way but refuses a bad value", () => {
    expect(validate(DYSPNEA_ASSESSMENT_CODES.goal, {}, false)).toEqual([]);
    expect(validate(DYSPNEA_ASSESSMENT_CODES.goal, { dyspnea_goal: 11 })).toEqual([
      "SLOT_INVALID:dyspnea_goal",
    ]);
    expect(validate(DYSPNEA_ASSESSMENT_CODES.goal, { dyspnea_goal: 3 })).toEqual([]);
    expect(validate(DYSPNEA_ASSESSMENT_CODES.score, { dyspnea_score: -1 })).toEqual([
      "SLOT_INVALID:dyspnea_score",
    ]);
    expect(validate(DYSPNEA_ASSESSMENT_CODES.score, { dyspnea_score: 0 })).toEqual([]);
    expect(validate(DYSPNEA_ASSESSMENT_CODES.score, { dyspnea_score: 10 })).toEqual([]);
    expect(validate(DYSPNEA_ASSESSMENT_CODES.lastScore, { dyspnea_last_score: 2.5 })).toEqual([
      "SLOT_INVALID:dyspnea_last_score",
    ]);
  });

  it("refuses a choice that is not offered, including a pain statement's wording", () => {
    const at = DYSPNEA_ASSESSMENT_CODES;
    expect(validate(at.setting, { dyspnea_setting: "sometimes" })).toEqual([
      "SLOT_INVALID:dyspnea_setting",
    ]);
    expect(validate(at.setting, { dyspnea_setting: "on exertion" })).toEqual([]);
    expect(validate(at.response, { dyspnea_response: "no dose taken" })).toEqual([
      "SLOT_INVALID:dyspnea_response",
    ]);
    expect(validate(at.response, { dyspnea_response: "none tried" })).toEqual([
      "SLOT_INVALID:dyspnea_response",
    ]);
    expect(validate(at.response, { dyspnea_response: "no measures tried" })).toEqual([]);
    expect(validate(at.change, { dyspnea_change: "new pain" })).toEqual([
      "SLOT_INVALID:dyspnea_change",
    ]);
    expect(validate(at.change, { dyspnea_change: "new dyspnea" })).toEqual([]);
  });

  it("refuses text longer than a slot may hold, and a value for a slot the statement does not have", () => {
    const at = DYSPNEA_ASSESSMENT_CODES;
    expect(validate(at.quality, { dyspnea_quality: "x".repeat(201) })).toEqual([
      "SLOT_INVALID:dyspnea_quality",
    ]);
    expect(validate(at.quality, { dyspnea_quality: "air hunger", patient: "someone" })).toEqual([
      "SLOT_UNKNOWN:patient",
    ]);
  });
});
