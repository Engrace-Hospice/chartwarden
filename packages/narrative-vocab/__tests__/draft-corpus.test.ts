// packages/narrative-vocab/__tests__/draft-corpus.test.ts — the visit-note draft phrases (S1 PR B, VN-D14/VN-D15).
// The corpus is DRAFT wording until the named clinical reviewer approves it; these tests pin the release
// bookkeeping, the review gate constant, the scoping of the new entries, and their exact wording.
import { ENCOUNTER_DISCIPLINE_RULES, type EncounterType } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  CORPUS_CLINICAL_REVIEW,
  NARRATIVE_VOCAB_RELEASES,
  VOCABULARY,
  VOCAB_VERSION,
  activeNarrativeVocabRelease,
  entriesFor,
  getVocabEntry,
} from "../src/index";

const LEGACY_ENTRY_COUNT = 23;
const LEGACY_CODES = new Set(VOCABULARY.slice(0, LEGACY_ENTRY_COUNT).map((e) => e.code));
const NEW_ENTRIES = VOCABULARY.slice(LEGACY_ENTRY_COUNT);

describe("corpus release", () => {
  it("is a new release, registered with its own uuid and a date", () => {
    expect(VOCAB_VERSION).toBe("narrative-vocab@2026.11.0");
    expect(NARRATIVE_VOCAB_RELEASES.map((r) => r.version)).toEqual([
      "narrative-vocab@2026.06.0",
      "narrative-vocab@2026.11.0",
    ]);
    expect(activeNarrativeVocabRelease(VOCAB_VERSION).releasedOn).toBe("2026-11-18");
  });

  it("keeps the 2026.06.0 release row untouched (a signed note pins that id)", () => {
    expect(NARRATIVE_VOCAB_RELEASES[0]).toEqual({
      version: "narrative-vocab@2026.06.0",
      id: "81dcb265-d2ef-456b-b029-1bcce25105e7",
      releasedOn: "2026-06-01",
    });
  });
});

describe("CORPUS_CLINICAL_REVIEW", () => {
  it("names ADA and is pending until the reviewer approves the draft wording", () => {
    expect(CORPUS_CLINICAL_REVIEW).toEqual({ reviewer: "ADA", status: "pending" });
  });

  it("is typed so a later gate can compare against both states", () => {
    const status: "pending" | "approved" = CORPUS_CLINICAL_REVIEW.status;
    expect(["pending", "approved"]).toContain(status);
  });
});

describe("draft entries", () => {
  it("adds 25 entries after the 23 legacy ones, with unique codes", () => {
    expect(NEW_ENTRIES).toHaveLength(25);
    expect(new Set(VOCABULARY.map((e) => e.code)).size).toBe(VOCABULARY.length);
    for (const e of NEW_ENTRIES) expect(LEGACY_CODES.has(e.code)).toBe(false);
  });

  it("are tagged only for the RN routine visit", () => {
    for (const e of NEW_ENTRIES) {
      expect(e.disciplines).toEqual(["rn"]);
      expect(e.encounterTypes).toEqual(["routine_visit"]);
    }
  });

  it("surface in no other legal (encounter type x discipline) menu", () => {
    for (const type of Object.keys(ENCOUNTER_DISCIPLINE_RULES) as EncounterType[]) {
      for (const discipline of ENCOUNTER_DISCIPLINE_RULES[type]) {
        if (type === "routine_visit" && discipline === "rn") continue;
        const surfaced = entriesFor(type, discipline).filter((e) => !LEGACY_CODES.has(e.code));
        expect(surfaced, `${type}:${discipline}`).toEqual([]);
      }
    }
  });

  it("surface in the RN routine visit menu", () => {
    const codes = entriesFor("routine_visit", "rn").map((e) => e.code);
    for (const e of NEW_ENTRIES) expect(codes).toContain(e.code);
  });

  it("use only the categories the draft needs", () => {
    const categories = [...new Set(NEW_ENTRIES.map((e) => e.category))].sort();
    expect(categories).toEqual([
      "care_plan_element",
      "chief_concern",
      "medication_change",
      "plan",
      "scale_reading",
      "vitals_review",
    ]);
  });

  it("slot names do not collide with the context slots the assembler always supplies", () => {
    for (const e of NEW_ENTRIES) {
      const slots = [...e.phrase.matchAll(/\$\{([A-Za-z0-9_.]+)\}/g)].map((m) => m[1]);
      for (const slot of slots) expect(["patient", "serviceDate", "location"]).not.toContain(slot);
    }
  });
});

describe("draft wording (neutral, factual, numbers only)", () => {
  const wording: ReadonlyArray<readonly [string, string]> = [
    ["nv.scale.pps_first", "PPS ${pps_value}%, no earlier reading recorded"],
    ["nv.scale.pps_down", "PPS ${pps_value}%, down from ${pps_previous_value}% on ${pps_previous_date}"],
    ["nv.scale.pps_up", "PPS ${pps_value}%, up from ${pps_previous_value}% on ${pps_previous_date}"],
    [
      "nv.scale.pps_same",
      "PPS ${pps_value}%, unchanged from ${pps_previous_value}% on ${pps_previous_date}",
    ],
    ["nv.scale.esas_first", "ESAS-r ${esas_label} ${esas_value}, no earlier reading recorded"],
    [
      "nv.scale.esas_down",
      "ESAS-r ${esas_label} ${esas_value}, down from ${esas_previous_value} on ${esas_previous_date}",
    ],
    [
      "nv.scale.esas_up",
      "ESAS-r ${esas_label} ${esas_value}, up from ${esas_previous_value} on ${esas_previous_date}",
    ],
    [
      "nv.scale.esas_same",
      "ESAS-r ${esas_label} ${esas_value}, unchanged from ${esas_previous_value} on ${esas_previous_date}",
    ],
    ["nv.vit.reviewed", "Vital signs for this visit were reviewed"],
    ["nv.vit.bp", "Blood pressure ${bp_systolic}/${bp_diastolic} mmHg"],
    ["nv.vit.hr", "Heart rate ${heart_rate} beats per minute"],
    ["nv.vit.rr", "Respiratory rate ${respiratory_rate} breaths per minute"],
    ["nv.vit.temp", "Temperature ${temperature} degrees ${temperature_unit}"],
    ["nv.vit.spo2", "Oxygen saturation ${spo2}%"],
    ["nv.vit.pain", "Pain score ${pain_score} of 10"],
    ["nv.cp.goal_progress", "Care-plan goal: ${goal_text}; progress: ${progress_statement}"],
    ["nv.cp.goal_listed", "Care-plan goal: ${goal_text}"],
    ["nv.cp.intervention_performed", "Care-plan intervention performed: ${intervention_text}"],
    ["nv.med.started", "${drug_name} was started on ${change_date}"],
    ["nv.med.changed", "${drug_name} order was changed on ${change_date}"],
    ["nv.med.discontinued", "${drug_name} was discontinued on ${change_date}"],
    ["nv.cc.routine_visit", "Routine scheduled visit per the plan of care"],
    ["nv.cc.follow_up", "Visit to follow up on ${follow_up_topic}"],
    ["nv.plan.continue", "The current plan of care continues"],
    ["nv.plan.next_visit", "Next visit is planned for ${next_visit_date}"],
  ];

  it("pins every new phrase byte for byte", () => {
    expect(wording).toHaveLength(NEW_ENTRIES.length);
    for (const [code, phrase] of wording) expect(getVocabEntry(code)?.phrase, code).toBe(phrase);
  });
});
