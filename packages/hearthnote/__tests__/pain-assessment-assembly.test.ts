// What the note says when the composer's pain assessment helper was used: one deterministic sentence per recorded item, in the order
// the clinician recorded them, with nothing stated for an item that was not recorded. Synthetic patient and values only.
import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import { describe, expect, it } from "vitest";
import {
  type AssemblyContext,
  type SelectionState,
  assembleLayer1,
  resolveTemplate,
} from "../src/index";

const CONTEXT: AssemblyContext = {
  patient: "Jane Doe",
  serviceDate: "2026-06-21",
  location: "patient residence",
};

type Entries = SelectionState["sections"][number]["entries"];

function routineRn(symptomEntries: Entries): SelectionState {
  return {
    templateKey: "routine_visit:rn",
    vocabVersion: VOCAB_VERSION,
    encounterType: "routine_visit",
    discipline: "rn",
    sections: [{ sectionId: "symptom_management", entries: symptomEntries }],
  };
}

function symptomManagement(entries: Entries): string {
  const template = resolveTemplate("routine_visit", "rn");
  if (template === undefined) throw new Error("no template");
  const { narrative } = assembleLayer1(template, routineRn(entries), CONTEXT);
  return narrative;
}

const LIMITING = { code: "nv.sym.pain_uncontrolled", params: { pain_score: 6 } };

describe("the assembled pain assessment", () => {
  it("states each recorded item as its own sentence, in the order recorded", () => {
    const narrative = symptomManagement([
      LIMITING,
      { code: "nv.sym.pain_location", params: { pain_location: "right hip" } },
      { code: "nv.sym.pain_character", params: { pain_character: "aching" } },
      { code: "nv.sym.pain_duration", params: { pain_duration: "since Tuesday" } },
      { code: "nv.sym.pain_frequency", params: { pain_frequency: "constant" } },
      { code: "nv.sym.pain_worsened_by", params: { pain_worsened_by: "turning in bed" } },
      { code: "nv.sym.pain_relieved_by", params: { pain_relieved_by: "a warm pack" } },
    ]);
    expect(narrative).toBe(
      `Symptom Management\n${[
        "Jane Doe reports pain at 6 of 10 that limits participation in daily activities.",
        "Pain location: right hip.",
        "Pain character: aching.",
        "Pain duration: since Tuesday.",
        "Pain frequency: constant.",
        "Pain is made worse by turning in bed.",
        "Pain is relieved by a warm pack.",
      ].join(" ")}`,
    );
  });

  it("says nothing about an item that was not recorded", () => {
    const narrative = symptomManagement([
      LIMITING,
      { code: "nv.sym.pain_location", params: { pain_location: "right hip" } },
    ]);
    expect(narrative).not.toContain("character");
    expect(narrative).not.toContain("duration");
    expect(narrative).not.toContain("frequency");
    expect(narrative).not.toContain("made worse");
    expect(narrative).not.toContain("relieved by");
  });

  it("states the response to treatment, side effects and the bowel regimen the clinician recorded", () => {
    const narrative = symptomManagement([
      LIMITING,
      { code: "nv.sym.pain_prn_relief", params: { pain_prn_relief: "partial relief" } },
      { code: "nv.sym.pain_side_effects", params: { pain_side_effects: "drowsiness, no nausea" } },
      {
        code: "nv.sym.pain_bowel_regimen",
        params: { bowel_regimen: "senna twice daily, last bowel movement yesterday" },
      },
    ]);
    expect(narrative).toContain(
      "Response to the last as-needed pain medication dose: partial relief.",
    );
    expect(narrative).toContain("Pain medication side effects: drowsiness, no nausea.");
    expect(narrative).toContain(
      "Bowel regimen with the opioid: senna twice daily, last bowel movement yesterday.",
    );
  });

  it("states a patient who cannot self-report, the cues, and the observation scale with its score", () => {
    const narrative = symptomManagement([
      {
        code: "nv.sym.pain_nonverbal",
        params: { nonverbal_cues: "grimacing and guarding the left arm" },
      },
      {
        code: "nv.sym.pain_observation_scale",
        params: { observation_tool: "PAINAD", observation_score: 5 },
      },
      { code: "nv.sym.pain_oral_barrier", params: { oral_barrier: "unable to swallow" } },
    ]);
    expect(narrative).toContain(
      "Jane Doe is unable to self-report pain; nonverbal cues observed: grimacing and guarding the left arm.",
    );
    expect(narrative).toContain("PAINAD score is 5 of 10.");
    expect(narrative).toContain("Jane Doe cannot take oral pain medication: unable to swallow.");
  });

  it("states the patient's own level, the last score, the change and the plan of care decision", () => {
    const narrative = symptomManagement([
      LIMITING,
      { code: "nv.sym.pain_goal", params: { pain_goal: 3 } },
      { code: "nv.sym.pain_last_score", params: { pain_last_score: 4 } },
      { code: "nv.sym.pain_change", params: { pain_change: "worsened" } },
      {
        code: "nv.sym.pain_plan_decision",
        params: { pain_plan_decision: "physician notified and IDG plan-of-care review requested" },
      },
    ]);
    expect(narrative).toContain("Jane Doe's stated acceptable pain level is 3 of 10.");
    expect(narrative).toContain("Pain at the last visit was 4 of 10.");
    expect(narrative).toContain("Change in pain since the last visit: worsened.");
    expect(narrative).toContain(
      "Plan of care for pain: physician notified and IDG plan-of-care review requested.",
    );
  });

  it("is byte-identical across runs and keeps the pain statement's wording as shipped", () => {
    const entries: Entries = [
      LIMITING,
      { code: "nv.sym.pain_plan_decision", params: { pain_plan_decision: "physician notified" } },
    ];
    expect(symptomManagement(entries)).toBe(symptomManagement(entries));
    expect(symptomManagement([LIMITING])).toBe(
      "Symptom Management\nJane Doe reports pain at 6 of 10 that limits participation in daily activities.",
    );
  });
});
