// WF09 step 2 — the "reason for visit" entries and the release that shipped them. Adding vocabulary is
// additive (D11), so the bytes of every earlier phrase must stay as they were; this pins the new ones too.
import { createHash } from "node:crypto";
import { ENCOUNTER_DISCIPLINE_RULES, type EncounterType } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  NARRATIVE_VOCAB_RELEASES,
  VOCABULARY,
  VOCAB_VERSION,
  activeNarrativeVocabRelease,
  entriesFor,
  entrySlots,
  narrativeVocabReleaseById,
  validateSelectionTree,
} from "../src/index";

const reasons = VOCABULARY.filter((e) => e.category === "visit_reason");

describe("visit reasons", () => {
  const offered = (type: Parameters<typeof entriesFor>[0], d: Parameters<typeof entriesFor>[1]) =>
    entriesFor(type, d)
      .filter((e) => e.category === "visit_reason")
      .map((e) => e.code);

  it("are offered on every visit a clinician documents, each discipline getting its own", () => {
    expect(offered("routine_visit", "rn")).toContain("nv.reason.fall_followup");
    expect(offered("lpn_visit", "lpn").length).toBeGreaterThan(0);
    expect(offered("face_to_face", "md").length).toBeGreaterThan(0);
    expect(offered("chha_visit", "chha")).toContain("nv.reason.personal_care");
    expect(offered("msw_assessment", "msw")).toContain("nv.reason.psychosocial");
    expect(offered("chaplain_visit", "chaplain")).toContain("nv.reason.ritual");
    expect(offered("volunteer_visit", "volunteer")).toContain("nv.reason.companionship");
    expect(offered("pt_visit", "pt")).toContain("nv.reason.therapy_evaluation");
    expect(offered("slp_visit", "slp")).toContain("nv.reason.swallowing");
    expect(offered("telephonic", "chaplain")).toContain("nv.reason.spiritual_support");
  });

  it("never offer another discipline's reason", () => {
    expect(offered("chaplain_visit", "chaplain")).not.toContain("nv.reason.wound");
    expect(offered("chaplain_visit", "chaplain")).not.toContain("nv.reason.psychosocial");
    expect(offered("routine_visit", "rn")).not.toContain("nv.reason.ritual");
    expect(offered("pt_visit", "pt")).not.toContain("nv.reason.swallowing");
    expect(offered("chha_visit", "chha")).not.toContain("nv.reason.pain");
  });

  it("give every legal visit at least two choices, so it renders as a select", () => {
    for (const type of Object.keys(ENCOUNTER_DISCIPLINE_RULES) as EncounterType[]) {
      if (type === "bereavement_contact" || type === "idg_followup") continue;
      for (const d of ENCOUNTER_DISCIPLINE_RULES[type]) {
        expect(offered(type, d).length, `${type}/${d}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("are not offered on a bereavement contact or an IDG follow-up, which are not a visit's own reason", () => {
    expect(offered("bereavement_contact", "msw")).toEqual([]);
    expect(offered("idg_followup", "rn")).toEqual([]);
  });

  it("read as one choice: every reason shares an exclusive group, so a note carries one", () => {
    expect(reasons.length).toBeGreaterThanOrEqual(8);
    expect(new Set(reasons.map((e) => e.exclusiveGroup))).toEqual(new Set(["visit-reason"]));
    const issues = validateSelectionTree(
      [
        {
          sectionId: "chief_concern",
          entries: [{ code: "nv.reason.routine" }, { code: "nv.reason.pain" }],
        },
      ],
      { requireComplete: true },
    );
    expect(issues.map((i) => i.code)).toEqual(["EXCLUSIVE_CONFLICT"]);
  });

  it("need nothing filled in, so choosing one is always a complete statement", () => {
    for (const e of reasons) expect(entrySlots(e), e.code).toEqual([]);
  });

  it("read as a sentence once the first letter is capitalised", () => {
    for (const e of reasons) expect(e.phrase, e.code).toMatch(/^this (is|visit)/);
  });

  // The D11 byte pin for what 2026.11.0 added. A change to any of these needs a NEW code in a new release.
  const SHIPPED_2026_11: Readonly<Record<string, string>> = {
    "nv.reason.routine": "eeddc625ec86671c",
    "nv.reason.fall_followup": "4e75afa45de1c9f9",
    "nv.reason.pain": "6f7c8e8372f7ddf0",
    "nv.reason.symptom_change": "5293abb97b7cc635",
    "nv.reason.condition_change": "ace733487b685c02",
    "nv.reason.medication": "5fb9be0f6e87caa6",
    "nv.reason.wound": "f36cda341382857f",
    "nv.reason.post_hospital": "5500e04e6557eea5",
    "nv.reason.caregiver": "daefe4e09b571d4c",
    "nv.reason.family_request": "3743b650ed8c7a51",
    "nv.reason.personal_care": "ac507078e9c4318f",
    "nv.reason.respite": "3d7a7b44bc551be7",
    "nv.reason.psychosocial": "82615cc17c43880c",
    "nv.reason.advance_care_planning": "216bed12b2c0ecaa",
    "nv.reason.resources": "655247497dcbe0f5",
    "nv.reason.grief": "6da4bd7783e5b847",
    "nv.reason.crisis": "5a354774025305bd",
    "nv.reason.spiritual_assessment": "249f455f67186af2",
    "nv.reason.spiritual_support": "9410eaaaa80eda3b",
    "nv.reason.ritual": "1a421f7084aaf05c",
    "nv.reason.companionship": "9961ed239c4548f4",
    "nv.reason.practical_help": "a2d9d7ff90c94989",
    "nv.reason.vigil": "b7c6a1a40c9dd96d",
    "nv.reason.therapy_evaluation": "ed968e79ff9fe1ec",
    "nv.reason.function_change": "32b581787964b805",
    "nv.reason.home_safety": "3a612a5e80e4421f",
    "nv.reason.caregiver_training": "528d1095b686df43",
    "nv.reason.swallowing": "701d5774e6a7dfa7",
    "nv.reason.communication": "ee60d61f283aa982",
  };

  it("shipped phrases are byte-stable (D11)", () => {
    expect(Object.keys(SHIPPED_2026_11).sort()).toEqual(reasons.map((e) => e.code).sort());
    for (const [code, hash] of Object.entries(SHIPPED_2026_11)) {
      const phrase = reasons.find((e) => e.code === code)?.phrase;
      expect(phrase, `${code} was removed`).toBeDefined();
      const actual = createHash("sha256")
        .update(phrase as string)
        .digest("hex")
        .slice(0, 16);
      expect(actual, `${code}'s phrase changed — ship a new code instead`).toBe(hash);
    }
  });
});

describe("the release that added them", () => {
  it("is a new release; the one before keeps its id, so signed notes still decode", () => {
    expect(VOCAB_VERSION).toBe("narrative-vocab@2026.11.0");
    expect(NARRATIVE_VOCAB_RELEASES.map((r) => r.version)).toEqual([
      "narrative-vocab@2026.06.0",
      "narrative-vocab@2026.11.0",
    ]);
    expect(narrativeVocabReleaseById("81dcb265-d2ef-456b-b029-1bcce25105e7")?.version).toBe(
      "narrative-vocab@2026.06.0",
    );
    expect(activeNarrativeVocabRelease(VOCAB_VERSION).releasedOn).toBe("2026-11-19");
  });
});
