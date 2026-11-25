// What the note says when the composer's dyspnea assessment helper was used: one deterministic sentence per recorded item, in the order
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

const IMPACT = { code: "nv.sym.dyspnea_impact", params: { ambulation_distance: "25 feet" } };
const IMPACT_SENTENCE = "Dyspnea limits Jane Doe's ability to ambulate beyond 25 feet.";

describe("the assembled dyspnea assessment", () => {
  it("states each recorded item as its own sentence, in the order recorded", () => {
    const narrative = symptomManagement([
      IMPACT,
      { code: "nv.sym.dyspnea_score", params: { dyspnea_score: 6 } },
      { code: "nv.sym.dyspnea_onset", params: { dyspnea_onset: "two days ago" } },
      { code: "nv.sym.dyspnea_setting", params: { dyspnea_setting: "on exertion" } },
      { code: "nv.sym.dyspnea_triggers", params: { dyspnea_triggers: "lying flat" } },
      { code: "nv.sym.dyspnea_relieved_by", params: { dyspnea_relieved_by: "sitting upright" } },
      { code: "nv.sym.dyspnea_quality", params: { dyspnea_quality: "air hunger" } },
      { code: "nv.sym.dyspnea_distress", params: { dyspnea_distress: "anxious at night" } },
      {
        code: "nv.sym.dyspnea_function",
        params: { dyspnea_function: "stops twice to reach the bathroom" },
      },
    ]);
    expect(narrative).toBe(
      `Symptom Management\n${[
        IMPACT_SENTENCE,
        "Dyspnea intensity: 6 of 10.",
        "Dyspnea onset: two days ago.",
        "Dyspnea occurs on exertion.",
        "Dyspnea is brought on or made worse by lying flat.",
        "Dyspnea is relieved by sitting upright.",
        "Dyspnea quality: air hunger.",
        "Distress or anxiety with dyspnea: anxious at night.",
        "Effect of dyspnea on function: stops twice to reach the bathroom.",
      ].join(" ")}`,
    );
  });

  it("says nothing about an item that was not recorded", () => {
    const narrative = symptomManagement([
      IMPACT,
      { code: "nv.sym.dyspnea_onset", params: { dyspnea_onset: "two days ago" } },
    ]);
    expect(narrative).not.toContain("intensity");
    expect(narrative).not.toContain("occurs");
    expect(narrative).not.toContain("brought on");
    expect(narrative).not.toContain("relieved by");
    expect(narrative).not.toContain("quality");
    expect(narrative).not.toContain("Distress");
    expect(narrative).not.toContain("Effect of dyspnea");
  });

  it("states the non-drug measures and the response to the measures tried", () => {
    const narrative = symptomManagement([
      IMPACT,
      {
        code: "nv.sym.dyspnea_nondrug",
        params: { dyspnea_nondrug: "bedside fan, upright positioning, paced breathing" },
      },
      { code: "nv.sym.dyspnea_response", params: { dyspnea_response: "partial relief" } },
    ]);
    expect(narrative).toContain(
      "Non-drug measures for dyspnea: bedside fan, upright positioning, paced breathing.",
    );
    expect(narrative).toContain("Dyspnea response to measures: partial relief.");
  });

  it("states a patient who cannot self-report and the signs observed, in words and without a score", () => {
    const narrative = symptomManagement([
      {
        code: "nv.sym.dyspnea_nonverbal",
        params: { dyspnea_nonverbal: "using accessory muscles and grimacing on turning" },
      },
    ]);
    expect(narrative).toContain(
      "Jane Doe is unable to self-report dyspnea; signs observed: using accessory muscles and grimacing on turning.",
    );
  });

  it("states the patient's own level, the last score, the change and the plan of care decision", () => {
    const narrative = symptomManagement([
      IMPACT,
      { code: "nv.sym.dyspnea_goal", params: { dyspnea_goal: 3 } },
      { code: "nv.sym.dyspnea_last_score", params: { dyspnea_last_score: 4 } },
      { code: "nv.sym.dyspnea_change", params: { dyspnea_change: "new dyspnea" } },
      {
        code: "nv.sym.dyspnea_plan_decision",
        params: {
          dyspnea_plan_decision: "physician notified and IDG plan-of-care review requested",
        },
      },
    ]);
    expect(narrative).toContain("Jane Doe's acceptable dyspnea level is 3 of 10.");
    expect(narrative).toContain("Dyspnea at the last visit was 4 of 10.");
    expect(narrative).toContain("Change in dyspnea since the last visit: new dyspnea.");
    expect(narrative).toContain(
      "Plan of care for dyspnea: physician notified and IDG plan-of-care review requested.",
    );
  });

  it("is byte-identical across runs and keeps the dyspnea statement's wording as shipped", () => {
    const entries: Entries = [
      IMPACT,
      {
        code: "nv.sym.dyspnea_plan_decision",
        params: { dyspnea_plan_decision: "physician notified" },
      },
    ];
    expect(symptomManagement(entries)).toBe(symptomManagement(entries));
    expect(symptomManagement([IMPACT])).toBe(`Symptom Management\n${IMPACT_SENTENCE}`);
  });

  it("assembles beside a pain assessment without either changing the other's sentences", () => {
    const narrative = symptomManagement([
      { code: "nv.sym.pain_uncontrolled", params: { pain_score: 6 } },
      { code: "nv.sym.pain_goal", params: { pain_goal: 3 } },
      IMPACT,
      { code: "nv.sym.dyspnea_goal", params: { dyspnea_goal: 2 } },
    ]);
    expect(narrative).toContain("Jane Doe's stated acceptable pain level is 3 of 10.");
    expect(narrative).toContain("Jane Doe's acceptable dyspnea level is 2 of 10.");
  });
});
