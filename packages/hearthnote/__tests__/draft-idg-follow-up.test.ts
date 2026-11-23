// packages/hearthnote/__tests__/draft-idg-follow-up.test.ts — S5b: the IDG follow-up's own section, drafted from the ONE M14 action item the author linked
// the visit to (design §3.9, VN-D64 to VN-D68). Synthetic ids and dates only: no SSN, MBI, or value copied from a real record.
//
// What these pin: the section drafts for all six disciplines of the template and no other, from the item's facts alone (the meeting's date, a fixed label
// for the decision KIND, the due date when there is one), in one sentence; with no link there is no section; every decision kind has its label; nothing
// of the item's title or body or the decision's payload can reach the text; the source's Part 2 flag fails closed; a malformed fact is an input error.
import { IDG_DECISION_KIND_LABELS } from "@chartwarden/narrative-vocab";
import { describe, expect, it } from "vitest";
import {
  DraftInputError,
  type DraftInputs,
  type DraftSection,
  compileDraft,
  draftSourceNeeds,
  draftedSectionIds,
} from "../src/index";
import {
  DEPS,
  baseInputs,
  deepFreeze,
  disciplinePlanSources,
  idgFollowUpSource,
  reverseKeys,
} from "./_draft-fixtures";

const DISCIPLINES = ["rn", "lpn", "msw", "chaplain", "md", "np"] as const;
type Discipline = (typeof DISCIPLINES)[number];

/** An IDG follow-up visit of the discipline with the action item linked (override `idgFollowUp` to change or remove it). */
function inputsFor(discipline: Discipline, over: Partial<DraftInputs> = {}): DraftInputs {
  const base = baseInputs();
  return {
    ...base,
    ...disciplinePlanSources(),
    ...idgFollowUpSource(),
    encounterType: "idg_followup",
    discipline,
    selection: {
      templateKey: `idg_followup:${discipline}`,
      vocabVersion: base.selection.vocabVersion,
      encounterType: "idg_followup",
      discipline,
      sections: [],
    },
    ...over,
  };
}

const sectionOf = (inputs: DraftInputs): DraftSection => {
  const found = compileDraft(inputs, DEPS).sections.find((s) => s.sectionId === "idg_followup");
  if (found === undefined) throw new Error("no idg_followup section");
  return found;
};

const WITH_DUE =
  "This visit follows up the team's decision of 2026-11-02: a referral; due 2026-11-20.";

describe("the IDG follow-up's own section (S5b)", () => {
  it.each(DISCIPLINES)("%s drafts one sentence from the linked action item", (discipline) => {
    const section = sectionOf(inputsFor(discipline));
    expect(section).toMatchObject({
      state: "drafted",
      text: WITH_DUE,
      sourceRefs: [{ kind: "idg_action_item", id: "idg-item-1" }],
      part2Derived: false,
    });
  });

  it("states no due date when the item has none", () => {
    const item = { ...idgFollowUpSource().idgFollowUp, dueOn: null } as NonNullable<
      DraftInputs["idgFollowUp"]
    >;
    expect(sectionOf(inputsFor("rn", { idgFollowUp: item }))).toMatchObject({
      state: "drafted",
      text: "This visit follows up the team's decision of 2026-11-02: a referral.",
    });
  });

  it("is empty with no linked action item, never filled with a default phrase", () => {
    for (const discipline of DISCIPLINES) {
      for (const idgFollowUp of [null, undefined]) {
        expect(sectionOf(inputsFor(discipline, { idgFollowUp })), discipline).toEqual({
          sectionId: "idg_followup",
          state: "empty",
          reason: "nothing_to_draft_from",
        });
      }
    }
  });

  it("is drafted for the six disciplines of the IDG follow-up template and for no other pair", () => {
    for (const discipline of DISCIPLINES) {
      expect(draftedSectionIds("idg_followup", discipline).has("idg_followup"), discipline).toBe(
        true,
      );
      expect(draftSourceNeeds("idg_followup", discipline).idgFollowUp, discipline).toBe(true);
    }
    for (const [type, discipline] of [
      ["routine_visit", "rn"],
      ["msw_followup", "msw"],
      ["chaplain_visit", "chaplain"],
      ["face_to_face", "md"],
      ["recert_visit", "rn"],
    ] as const) {
      expect(draftedSectionIds(type, discipline).has("idg_followup"), type).toBe(false);
      expect(draftSourceNeeds(type, discipline).idgFollowUp, type).toBe(false);
    }
  });

  it("gives every decision kind its fixed label, and names nothing but the kind", () => {
    for (const [kind, label] of Object.entries(IDG_DECISION_KIND_LABELS)) {
      const item = { ...idgFollowUpSource().idgFollowUp, decisionKind: kind } as NonNullable<
        DraftInputs["idgFollowUp"]
      >;
      expect(sectionOf(inputsFor("rn", { idgFollowUp: item })), kind).toMatchObject({
        state: "drafted",
        text: `This visit follows up the team's decision of 2026-11-02: ${label}; due 2026-11-20.`,
      });
    }
    expect(Object.keys(IDG_DECISION_KIND_LABELS)).toHaveLength(10);
  });

  it("can state nothing of the item's title or body or the decision's payload, even if a caller passes them", () => {
    const smuggled = {
      ...idgFollowUpSource().idgFollowUp,
      title: "Synthetic title SENTINEL-TITLE",
      bodyText: "Synthetic body SENTINEL-BODY",
      payload: { narrative: "Synthetic narrative SENTINEL-PAYLOAD" },
    } as unknown as NonNullable<DraftInputs["idgFollowUp"]>;
    const section = sectionOf(inputsFor("rn", { idgFollowUp: smuggled }));
    expect(section.state).toBe("drafted");
    expect(JSON.stringify(section)).not.toContain("SENTINEL");
    expect(section).toMatchObject({ text: WITH_DUE });
  });

  it("fails closed on Part 2: only the literal false is not Part 2, a flagged item makes the section Part 2", () => {
    for (const [sudRelated, part2] of [
      [false, false],
      [true, true],
      [null, true],
      [undefined, true],
    ] as const) {
      const item = { ...idgFollowUpSource().idgFollowUp, sudRelated } as NonNullable<
        DraftInputs["idgFollowUp"]
      >;
      expect(sectionOf(inputsFor("msw", { idgFollowUp: item })), String(sudRelated)).toMatchObject({
        part2Derived: part2,
      });
    }
  });

  it("refuses a decision kind the corpus has no label for, and a date that is not one", () => {
    const item = idgFollowUpSource().idgFollowUp as NonNullable<DraftInputs["idgFollowUp"]>;
    for (const bad of [
      { ...item, decisionKind: "something_new" },
      { ...item, meetingOn: "2026-13-45" },
      { ...item, meetingOn: "11/02/2026" },
      { ...item, dueOn: "tomorrow" },
      { ...item, id: "  " },
    ]) {
      expect(() => sectionOf(inputsFor("rn", { idgFollowUp: bad })), JSON.stringify(bad)).toThrow(
        DraftInputError,
      );
    }
  });

  it("the content hash follows the sentence, and never the order a caller built the input in", () => {
    const hashOf = (inputs: DraftInputs): string => {
      const section = sectionOf(inputs);
      if (section.state !== "drafted") throw new Error("not drafted");
      return section.contentHash;
    };
    const teamNote = {
      ...idgFollowUpSource().idgFollowUp,
      decisionKind: "team_note",
    } as NonNullable<DraftInputs["idgFollowUp"]>;
    expect(hashOf(inputsFor("lpn", reverseKeys(idgFollowUpSource())))).toBe(
      hashOf(inputsFor("lpn")),
    );
    expect(hashOf(inputsFor("lpn", { idgFollowUp: teamNote }))).not.toBe(hashOf(inputsFor("lpn")));
  });

  it("never mutates its inputs", () => {
    const inputs = deepFreeze(inputsFor("np"));
    expect(compileDraft(inputs, DEPS)).toEqual(compileDraft(inputs, DEPS));
  });

  it("is drafted beside the discipline's own sections, never instead of them", () => {
    const msw = compileDraft(inputsFor("msw"), DEPS).sections.filter((s) => s.state === "drafted");
    expect(msw.map((s) => s.sectionId).sort()).toEqual(["idg_followup", "interventions", "plan"]);
    const md = compileDraft(inputsFor("md"), DEPS).sections.filter((s) => s.state === "drafted");
    expect(md.map((s) => s.sectionId).sort()).toEqual(["idg_followup", "vitals_review"]);
  });
});
