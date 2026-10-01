// M14 minutes DECISION CONTENT (pure): per-kind human-readable summaries, field caps, superseded lineage and the
// 42 CFR Part 2 fail-closed withholding that mirrors the discipline-note snapshot.
import { describe, expect, it } from "vitest";
import {
  DECISION_ITEM_CAP,
  DECISION_TEXT_CAP,
  ELLIPSIS,
  buildDecisionContent,
  capText,
  summarizeDecisionPayload,
} from "../src/modules/14-idg/minutes-decision-content";

const U = "11111111-1111-4111-8111-111111111111";

describe("summarizeDecisionPayload — one SAFE summary per kind", () => {
  it("care_plan_update: one line per mutation op, ids never printed", () => {
    const lines = summarizeDecisionPayload("care_plan_update", {
      kind: "care_plan_update",
      mutations: [
        {
          op: "problem_add",
          icd10Code: "R52",
          snomedCode: null,
          description: "Pain",
          problemKind: "terminal",
        },
        { op: "problem_update", problemId: U, updates: { status: "resolved" } },
        {
          op: "goal_add",
          problemId: U,
          originalText: "Comfort",
          revisedText: null,
          source: "patient_stated",
          measurableOutcome: "Pain <= 3",
        },
        { op: "goal_update", goalId: U, updates: { status: "met", statusNote: "Reached" } },
        {
          op: "intervention_add",
          problemId: U,
          goalRefs: [],
          discipline: "rn",
          scopeText: "Titrate opioid",
          frequencyText: "Daily",
          frequencyValue: "1/d",
        },
        { op: "intervention_discontinue", interventionId: U, reason: "No longer needed" },
      ],
    });
    expect(lines).toEqual([
      "Add problem (Terminal) | Pain | ICD-10: R52",
      "Update problem | Status: Resolved",
      "Add goal (Patient Stated) | Comfort | Measurable outcome: Pain <= 3",
      "Update goal | Status: Met | Note: Reached",
      "Add intervention (Rn) | Titrate opioid | Frequency: Daily",
      "Discontinue intervention | Reason: No longer needed",
    ]);
    expect(lines.join("\n")).not.toContain(U);
  });
  it("order_request, medication_recommendation", () => {
    expect(
      summarizeDecisionPayload("order_request", {
        requestedOrders: [
          {
            kindHint: "comfort_kit",
            narrative: "Replace kit",
            recommendedTimeframe: "24h",
            triggeringProblemId: null,
          },
        ],
      }),
    ).toEqual(["Comfort Kit | Replace kit | Timeframe: 24h"]);
    expect(
      summarizeDecisionPayload("medication_recommendation", {
        recommendations: [
          {
            recommendationKind: "change_dose",
            drugLabel: "Morphine",
            proposedStrength: "10 mg",
            proposedRoute: null,
            proposedFrequency: "q4h",
            triggeringProblemId: null,
            rationaleText: "Breakthrough pain",
          },
        ],
      }),
    ).toEqual(["Change Dose: Morphine | 10 mg | q4h | Rationale: Breakthrough pain"]);
  });
  it("level_of_care, recertification, family meeting, bereavement, referral, team note", () => {
    expect(
      summarizeDecisionPayload("level_of_care_consideration", {
        consideredLevel: "general_inpatient",
        rationaleText: "Dyspnea",
      }),
    ).toEqual(["Level of care considered: General Inpatient | Rationale: Dyspnea"]);
    expect(
      summarizeDecisionPayload("recertification_consideration", {
        periodIndex: 3,
        rationaleText: "Decline",
      }),
    ).toEqual(["Recertification period: 3 | Rationale: Decline"]);
    expect(
      summarizeDecisionPayload("family_meeting_needed", {
        familyMembers: ["Ana", "Luis"],
        preferredWindow: { startIso: "2026-10-01T10:00:00Z", endIso: "2026-10-01T11:00:00Z" },
        rationaleText: "Goals of care",
      }),
    ).toEqual([
      "Family meeting needed | Family members: Ana, Luis | Preferred window: 2026-10-01T10:00:00Z to 2026-10-01T11:00:00Z | Rationale: Goals of care",
    ]);
    expect(
      summarizeDecisionPayload("bereavement_risk_flag", {
        riskLevel: "high",
        rationaleText: "Isolated",
      }),
    ).toEqual(["Bereavement risk: High | Rationale: Isolated"]);
    expect(
      summarizeDecisionPayload("referral", {
        referralKind: "chaplaincy",
        referralTargetMdmId: U,
        rationaleText: "Requested",
      }),
    ).toEqual(["Referral: chaplaincy | Rationale: Requested"]);
    expect(summarizeDecisionPayload("team_note", { noteText: "Call   the\nfamily" })).toEqual([
      "Call the family",
    ]);
  });
  it("only known fields are read — a stray key never reaches the lines; garbage yields no lines", () => {
    const lines = summarizeDecisionPayload("team_note", { noteText: "ok", ssn: "123-45-6789" });
    expect(lines.join()).not.toContain("123-45");
    expect(summarizeDecisionPayload("team_note", null)).toEqual([]);
    expect(summarizeDecisionPayload("unknown_kind", { x: 1 })).toEqual([]);
    expect(summarizeDecisionPayload("care_plan_update", { mutations: "nope" })).toEqual([]);
  });
});

describe("caps", () => {
  it("caps a free-text field at 1000 chars with an ellipsis marker", () => {
    const out = capText("x".repeat(5000)) as string;
    expect(out.length).toBe(DECISION_TEXT_CAP + ELLIPSIS.length);
    expect(out.endsWith(ELLIPSIS)).toBe(true);
    expect(capText("short")).toBe("short");
    expect(capText("   ")).toBeUndefined();
  });
  it("caps the item count and says how many were not shown", () => {
    const mutations = Array.from({ length: DECISION_ITEM_CAP + 5 }, (_, i) => ({
      op: "problem_add",
      description: `p${i}`,
      problemKind: "related",
      icd10Code: null,
      snomedCode: null,
    }));
    const lines = summarizeDecisionPayload("care_plan_update", { mutations });
    expect(lines).toHaveLength(DECISION_ITEM_CAP + 1);
    expect(lines.at(-1)).toBe("(+5 more not shown)");
  });
});

describe("buildDecisionContent — Part 2 + lineage", () => {
  const rows = [
    {
      id: "d1",
      patientId: "pClear",
      decisionKind: "team_note",
      status: "emitted",
      recordedAt: new Date("2026-09-29T14:00:00Z"),
      supersededByDecisionId: null,
      payload: { noteText: "CLEAR-TEXT" },
    },
    {
      id: "d2",
      patientId: "pSud",
      decisionKind: "team_note",
      status: "emitted",
      recordedAt: "2026-09-29T14:05:00.000Z",
      supersededByDecisionId: null,
      payload: { noteText: "SUD-SECRET" },
    },
    {
      id: "d3",
      patientId: null,
      decisionKind: "team_note",
      status: "superseded",
      recordedAt: new Date("2026-09-29T14:10:00Z"),
      supersededByDecisionId: "d4",
      payload: { noteText: "MEETING-LEVEL" },
    },
  ] as const;
  const out = buildDecisionContent(rows, new Set(["pSud"]));
  it("a patient needing a release is metadata-only: no summary, no patient id, withheld", () => {
    expect(out[1]).toEqual({
      decisionId: "d2",
      decisionKind: "team_note",
      status: "emitted",
      recordedAt: "2026-09-29T14:05:00.000Z",
      supersededByDecisionId: null,
      patientId: null,
      withheld: true,
      summary: [],
    });
    expect(JSON.stringify(out[1])).not.toContain("SUD-SECRET");
    expect(JSON.stringify(out[1])).not.toContain("pSud");
  });
  it("clear patient and meeting-level decisions keep their text; superseded keeps the link", () => {
    expect(out[0]).toMatchObject({ patientId: "pClear", withheld: false, summary: ["CLEAR-TEXT"] });
    expect(out[2]).toMatchObject({
      patientId: null,
      withheld: false,
      status: "superseded",
      supersededByDecisionId: "d4",
      summary: ["MEETING-LEVEL"],
    });
  });
  it("fail-closed: a patient in the release set is withheld whatever the payload", () => {
    const all = buildDecisionContent(rows, new Set(["pClear", "pSud"]));
    expect(all.map((e) => e.withheld)).toEqual([true, true, false]);
  });
});
