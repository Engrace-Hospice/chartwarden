// WF09 step 2 — the "reason for visit" entries and the release that shipped them. Adding vocabulary is
// additive (D11), so the bytes of every earlier phrase must stay as they were; this pins the new ones too.
import { createHash } from "node:crypto";
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
  it("are offered on the visits a nurse or provider documents, and nowhere a reason makes no sense", () => {
    const offered = (type: Parameters<typeof entriesFor>[0], d: Parameters<typeof entriesFor>[1]) =>
      entriesFor(type, d).filter((e) => e.category === "visit_reason");
    expect(offered("routine_visit", "rn").map((e) => e.code)).toContain("nv.reason.fall_followup");
    expect(offered("lpn_visit", "lpn").length).toBeGreaterThan(0);
    expect(offered("face_to_face", "md").length).toBeGreaterThan(0);
    expect(offered("chaplain_visit", "chaplain")).toEqual([]);
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
