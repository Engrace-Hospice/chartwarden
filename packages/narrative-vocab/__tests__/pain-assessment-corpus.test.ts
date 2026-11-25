// The pain assessment statements: the corpus entries the composer's helper records, pinned to the rules in `@chartwarden/types`.
// The choice strings are COPIED into the corpus (a shipped phrase's bytes are D11-pinned); these tests are what keeps the copy and
// the rule constants from drifting apart.
import { createHash } from "node:crypto";
import {
  PAIN_ASSESSMENT_CODES,
  PAIN_CHANGE_OPTIONS,
  PAIN_OBSERVATION_TOOLS,
  PAIN_PLAN_DECISIONS,
  PAIN_RELIEF_OPTIONS,
  PAIN_SLOTS,
  PAIN_STATEMENT_CODES,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { VOCAB_BY_CODE, entriesFor, entrySlots, validateSelectionTree } from "../src/index";
import { PAIN_ASSESSMENT_VOCABULARY } from "../src/pain-assessment-entries";

/** sha256 (first 16 hex) of every shipped phrase: a note signed under 2026.12.6 must re-read identically, so a changed phrase needs a new code. */
const PHRASE_PINS: Readonly<Record<string, string>> = {
  "nv.sym.pain_location": "7e7c555edcca2fe6",
  "nv.sym.pain_character": "920d1fb9d16ae8cf",
  "nv.sym.pain_duration": "e77cf8dc7f7582c3",
  "nv.sym.pain_frequency": "997f98d0a6b25559",
  "nv.sym.pain_worsened_by": "f4c61bce6e4afece",
  "nv.sym.pain_relieved_by": "1ee9591e9eb7946d",
  "nv.sym.pain_prn_relief": "095b808b03f2190a",
  "nv.sym.pain_side_effects": "79da1cee4b486977",
  "nv.sym.pain_bowel_regimen": "17d3298490fbf70f",
  "nv.sym.pain_oral_barrier": "14aa662f3ac44212",
  "nv.sym.pain_nonverbal": "b0de13284abf3f66",
  "nv.sym.pain_observation_scale": "c0b172074ca5bc7b",
  "nv.sym.pain_goal": "419ff5b176f61069",
  "nv.sym.pain_last_score": "addae7ddc81ff48b",
  "nv.sym.pain_change": "24dae8045763ec58",
  "nv.sym.pain_plan_decision": "c7bcb64a70919937",
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
  [PAIN_ASSESSMENT_CODES.location]: ["pain_location"],
  [PAIN_ASSESSMENT_CODES.character]: ["pain_character"],
  [PAIN_ASSESSMENT_CODES.duration]: ["pain_duration"],
  [PAIN_ASSESSMENT_CODES.frequency]: ["pain_frequency"],
  [PAIN_ASSESSMENT_CODES.worsenedBy]: ["pain_worsened_by"],
  [PAIN_ASSESSMENT_CODES.relievedBy]: ["pain_relieved_by"],
  [PAIN_ASSESSMENT_CODES.prnRelief]: [PAIN_SLOTS.prnRelief],
  [PAIN_ASSESSMENT_CODES.sideEffects]: ["pain_side_effects"],
  [PAIN_ASSESSMENT_CODES.bowelRegimen]: ["bowel_regimen"],
  [PAIN_ASSESSMENT_CODES.oralBarrier]: [PAIN_SLOTS.oralBarrier],
  [PAIN_ASSESSMENT_CODES.nonverbal]: ["nonverbal_cues"],
  [PAIN_ASSESSMENT_CODES.observationScale]: [
    PAIN_SLOTS.observationTool,
    PAIN_SLOTS.observationScore,
  ],
  [PAIN_ASSESSMENT_CODES.goal]: [PAIN_SLOTS.goal],
  [PAIN_ASSESSMENT_CODES.lastScore]: [PAIN_SLOTS.lastScore],
  [PAIN_ASSESSMENT_CODES.change]: [PAIN_SLOTS.change],
  [PAIN_ASSESSMENT_CODES.planDecision]: [PAIN_SLOTS.planDecision],
};

const optionsOf = (code: string, slot: string): readonly string[] | undefined => {
  const spec = VOCAB_BY_CODE.get(code)?.slotSpecs?.[slot];
  return spec?.kind === "choice" ? spec.options : undefined;
};

describe("the pain assessment corpus entries", () => {
  it("are exactly the statements the shared rules name, each once", () => {
    const shipped = PAIN_ASSESSMENT_VOCABULARY.map((e) => e.code).sort();
    expect(shipped).toEqual(Object.values(PAIN_ASSESSMENT_CODES).sort());
    expect(shipped).toHaveLength(16);
    for (const code of shipped) expect(VOCAB_BY_CODE.get(code)).toBeDefined();
  });

  it("fill the slots the rules read, and no others", () => {
    for (const entry of PAIN_ASSESSMENT_VOCABULARY) {
      expect(entrySlots(entry), entry.code).toEqual(EXPECTED_SLOTS[entry.code]);
    }
  });

  it("offer the same choices the rules recognise", () => {
    const at = PAIN_ASSESSMENT_CODES;
    expect(optionsOf(at.prnRelief, PAIN_SLOTS.prnRelief)).toEqual([...PAIN_RELIEF_OPTIONS]);
    expect(optionsOf(at.change, PAIN_SLOTS.change)).toEqual([...PAIN_CHANGE_OPTIONS]);
    expect(optionsOf(at.observationScale, PAIN_SLOTS.observationTool)).toEqual([
      ...PAIN_OBSERVATION_TOOLS,
    ]);
    expect(optionsOf(at.planDecision, PAIN_SLOTS.planDecision)).toEqual([...PAIN_PLAN_DECISIONS]);
  });

  it("surface wherever the pain statements do, in the same symptom menu, and contradict nothing", () => {
    const limiting = VOCAB_BY_CODE.get(PAIN_STATEMENT_CODES.limiting);
    for (const entry of PAIN_ASSESSMENT_VOCABULARY) {
      expect(entry.category).toBe("symptom_impact");
      expect(entry.disciplines).toEqual(limiting?.disciplines);
      expect(entry.encounterTypes).toEqual(limiting?.encounterTypes);
      expect(entry.exclusiveGroup).toBeUndefined();
    }
    const menu = entriesFor("routine_visit", "rn").map((e) => e.code);
    for (const code of Object.values(PAIN_ASSESSMENT_CODES)) expect(menu).toContain(code);
    const phone = entriesFor("telephonic", "rn").map((e) => e.code);
    for (const code of Object.values(PAIN_ASSESSMENT_CODES)) expect(phone).not.toContain(code);
  });

  it("pins every phrase byte for byte (a shipped phrase never changes; ship a new code instead)", () => {
    expect(Object.keys(PHRASE_PINS).sort()).toEqual(Object.values(PAIN_ASSESSMENT_CODES).sort());
    for (const entry of PAIN_ASSESSMENT_VOCABULARY) {
      const actual = createHash("sha256").update(entry.phrase).digest("hex").slice(0, 16);
      expect(actual, `${entry.code}'s phrase changed`).toBe(PHRASE_PINS[entry.code]);
    }
  });

  it("keep the pain statements' own wording byte for byte (a shipped phrase never changes)", () => {
    expect(VOCAB_BY_CODE.get(PAIN_STATEMENT_CODES.limiting)?.phrase).toBe(
      "${patient} reports pain at ${pain_score} of 10 that limits participation in daily activities",
    );
    expect(VOCAB_BY_CODE.get(PAIN_STATEMENT_CODES.controlled)?.phrase).toBe(
      "${patient}'s pain is well controlled at ${pain_score} of 10 on the current medication regimen",
    );
  });
});

describe("a selected pain assessment statement is validated like any other", () => {
  it("is complete only when every slot is filled", () => {
    expect(validate(PAIN_ASSESSMENT_CODES.location, {})).toEqual(["SLOT_INCOMPLETE:pain_location"]);
    expect(validate(PAIN_ASSESSMENT_CODES.location, { pain_location: "right hip" })).toEqual([]);
    expect(
      validate(PAIN_ASSESSMENT_CODES.observationScale, { observation_tool: "PAINAD" }),
    ).toEqual(["SLOT_INCOMPLETE:observation_score"]);
  });

  it("lets a draft be saved half-way but refuses a bad value", () => {
    expect(validate(PAIN_ASSESSMENT_CODES.goal, {}, false)).toEqual([]);
    expect(validate(PAIN_ASSESSMENT_CODES.goal, { pain_goal: 11 })).toEqual([
      "SLOT_INVALID:pain_goal",
    ]);
    expect(validate(PAIN_ASSESSMENT_CODES.goal, { pain_goal: 3 })).toEqual([]);
    expect(validate(PAIN_ASSESSMENT_CODES.lastScore, { pain_last_score: 2.5 })).toEqual([
      "SLOT_INVALID:pain_last_score",
    ]);
  });

  it("refuses a choice that is not offered", () => {
    expect(validate(PAIN_ASSESSMENT_CODES.prnRelief, { pain_prn_relief: "a little" })).toEqual([
      "SLOT_INVALID:pain_prn_relief",
    ]);
    expect(validate(PAIN_ASSESSMENT_CODES.prnRelief, { pain_prn_relief: "no relief" })).toEqual([]);
    expect(
      validate(PAIN_ASSESSMENT_CODES.observationScale, {
        observation_tool: "CNPI",
        observation_score: 3,
      }),
    ).toEqual(["SLOT_INVALID:observation_tool"]);
  });

  it("refuses text longer than a slot may hold, and a value for a slot the statement does not have", () => {
    expect(validate(PAIN_ASSESSMENT_CODES.character, { pain_character: "x".repeat(201) })).toEqual([
      "SLOT_INVALID:pain_character",
    ]);
    expect(
      validate(PAIN_ASSESSMENT_CODES.character, { pain_character: "aching", patient: "someone" }),
    ).toEqual(["SLOT_UNKNOWN:patient"]);
  });
});
