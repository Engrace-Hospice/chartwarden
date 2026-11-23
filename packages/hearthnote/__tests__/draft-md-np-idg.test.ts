import { ENCOUNTER_DISCIPLINE_RULES } from "@chartwarden/types";
// packages/hearthnote/__tests__/draft-md-np-idg.test.ts — S5: the physician's and nurse practitioner's face-to-face visit and the IDG follow-up
// of every discipline (design §3.7, VN-D52 to VN-D56). Synthetic names and ids only: no SSN, MBI, or value copied from a real record.
//
// What these pin: a physician or nurse practitioner drafts the recorded vitals and (face-to-face) the orders in effect and the S2 decline evidence,
// and never a care-plan goal or intervention, a scale reading, a medication change, an assessment or an attestation (their note is their own
// judgement); the IDG follow-up drafts as the discipline's own visit does; its own section is empty unless the author linked an action item (S5b, which
// draft-idg-follow-up.test.ts pins); fail-closed Part 2.
import { describe, expect, it } from "vitest";
import {
  type DraftInputs,
  type DraftSection,
  compileDraft,
  draftSourceNeeds,
  draftedSectionIds,
  readsActiveOrders,
} from "../src/index";
import {
  DEPS,
  admissionSources,
  baseInputs,
  deepFreeze,
  disciplinePlanSources,
  recertSources,
} from "./_draft-fixtures";

type Type = DraftInputs["encounterType"];
type Discipline = DraftInputs["discipline"];

/** A visit of the pair with EVERY source supplied and nothing selected: what the compiler would draft if the corpus allowed it. */
function inputsFor(type: Type, discipline: Discipline): DraftInputs {
  const base = baseInputs();
  return {
    ...base,
    ...recertSources(),
    ...admissionSources(),
    ...disciplinePlanSources(),
    encounterType: type,
    discipline,
    selection: {
      templateKey: `${type}:${discipline}`,
      vocabVersion: base.selection.vocabVersion,
      encounterType: type,
      discipline,
      sections: [],
    },
  };
}

const sectionOf = (inputs: DraftInputs, id: string): DraftSection => {
  const found = compileDraft(inputs, DEPS).sections.find((s) => s.sectionId === id);
  if (found === undefined) throw new Error(`no section '${id}'`);
  return found;
};
const textOf = (inputs: DraftInputs, id: string): string => {
  const s = sectionOf(inputs, id);
  return s.state === "drafted" ? s.text : "";
};
const draftedIds = (inputs: DraftInputs): string[] =>
  compileDraft(inputs, DEPS)
    .sections.filter((s) => s.state === "drafted")
    .map((s) => s.sectionId)
    .sort();

describe("the face-to-face visit by a physician or nurse practitioner (VN-D52, VN-D53)", () => {
  it.each(["md", "np"] as const)(
    "%s drafts the vitals, the orders in effect and the decline evidence, and nothing the clinician judges",
    (discipline) => {
      const inputs = inputsFor("face_to_face", discipline);
      expect(draftedIds(inputs)).toEqual(["med_reconciliation", "prognosis", "vitals_review"]);
      // The care plan, the scales and the medication changes are all supplied and none is drafted.
      for (const id of [
        "assessment",
        "symptom_management",
        "interventions",
        "plan",
        "chief_concern",
        "f2f_attestation",
      ]) {
        expect(sectionOf(inputs, id).state, id).toBe("empty");
      }
    },
  );

  it("states the recorded vitals as the routine visit does, with the same wording", () => {
    const f2f = textOf(inputsFor("face_to_face", "md"), "vitals_review");
    expect(f2f).not.toBe("");
    expect(f2f).toBe(textOf(inputsFor("routine_visit", "rn"), "vitals_review"));
  });

  it("states the orders in effect as the admission visit does, and nothing about reconciliation or verification", () => {
    const f2f = textOf(inputsFor("face_to_face", "np"), "med_reconciliation");
    expect(f2f).toBe(textOf(inputsFor("admission_visit", "rn"), "med_reconciliation"));
    expect(f2f).toBe(
      "Active order at the visit, as needed: Morphine sulfate 20 mg/mL oral solution, oral. " +
        "Active order at the visit: Senna 8.6 mg tablet, oral.",
    );
    expect(f2f.toLowerCase()).not.toMatch(/reconcil|verified|reviewed|appropriate/);
  });

  it("leaves the S2 decline evidence as it was (S5 adds no word to the prognosis section)", () => {
    const before = textOf(inputsFor("face_to_face", "md"), "prognosis");
    expect(before).not.toBe("");
    // The same section, compiled with every S5 source taken away, is the same text: nothing S5 reads feeds it.
    const stripped: DraftInputs = {
      ...inputsFor("face_to_face", "md"),
      vitals: null,
      activeMedications: [],
    };
    expect(textOf(stripped, "prognosis")).toBe(before);
  });

  it("drafts nothing from an empty source, rather than a sentence about an absence", () => {
    const none: DraftInputs = {
      ...inputsFor("face_to_face", "md"),
      vitals: null,
      activeMedications: [],
    };
    expect(sectionOf(none, "vitals_review").state).toBe("empty");
    expect(sectionOf(none, "med_reconciliation").state).toBe("empty");
  });

  it("needs the vitals and the scales (the decline evidence) from the source reads, and not the care plan, the medication changes or a discipline plan; the orders are the admission record's, asked by `readsActiveOrders`", () => {
    expect(readsActiveOrders("face_to_face")).toBe(true);
    expect(draftSourceNeeds("face_to_face", "md")).toEqual({
      carePlan: false,
      vitals: true,
      medicationChanges: false,
      scales: true,
      disciplinePlan: false,
      idgFollowUp: false,
    });
  });

  it("marks the orders section Part 2 derived when an order is SUD-related, and the vitals never", () => {
    const clean = inputsFor("face_to_face", "md");
    const part2 = (inputs: DraftInputs, id: string): boolean => {
      const s = sectionOf(inputs, id);
      if (s.state !== "drafted") throw new Error(`${id} is not drafted`);
      return s.part2Derived;
    };
    expect(part2(clean, "med_reconciliation")).toBe(false);
    const sud: DraftInputs = {
      ...clean,
      activeMedications: (clean.activeMedications ?? []).map((m, i) =>
        i === 0 ? { ...m, sudRelated: true } : m,
      ),
    };
    expect(part2(sud, "med_reconciliation")).toBe(true);
    expect(part2(sud, "vitals_review")).toBe(false);
  });

  it("treats an order with no Part 2 flag as Part 2 derived (fail closed), for the face-to-face visit as for the admission visit", () => {
    for (const [type, discipline] of [
      ["face_to_face", "md"],
      ["face_to_face", "np"],
      ["admission_visit", "rn"],
    ] as const) {
      const clean = inputsFor(type, discipline);
      const unflagged: DraftInputs = {
        ...clean,
        activeMedications: (clean.activeMedications ?? []).map((m) => {
          const { sudRelated: _flag, ...rest } = m;
          return rest as never;
        }),
      };
      const s = sectionOf(unflagged, "med_reconciliation");
      if (s.state !== "drafted") throw new Error(`${type}:${discipline} is not drafted`);
      expect(s.part2Derived, `${type}:${discipline}`).toBe(true);
    }
  });

  it("only the admission visit and the face-to-face visit read the orders in effect", () => {
    const readers = (Object.keys(ENCOUNTER_DISCIPLINE_RULES) as Type[]).filter((type) =>
      readsActiveOrders(type),
    );
    expect(readers.sort()).toEqual(["admission_visit", "face_to_face"]);
  });

  it("is deterministic and does not touch its inputs", () => {
    const inputs = deepFreeze(inputsFor("face_to_face", "md"));
    expect(compileDraft(inputs, DEPS)).toEqual(compileDraft(inputs, DEPS));
  });
});

describe("the IDG follow-up drafts as the discipline's own visit does (VN-D52)", () => {
  it.each(["md", "np"] as const)(
    "%s drafts the recorded vitals and nothing else of what the visit records (S5b: and the linked IDG decision, which draft-idg-follow-up.test.ts pins)",
    (discipline) => {
      const inputs = inputsFor("idg_followup", discipline);
      expect(draftedIds(inputs)).toEqual(["vitals_review"]);
      expect(textOf(inputs, "vitals_review")).toBe(
        textOf(inputsFor("routine_visit", "rn"), "vitals_review"),
      );
      expect(draftSourceNeeds("idg_followup", discipline)).toEqual({
        carePlan: false,
        vitals: true,
        medicationChanges: false,
        scales: false,
        disciplinePlan: false,
        idgFollowUp: true,
      });
    },
  );

  it("an RN drafts the five sections the routine visit does, with the routine visit's words", () => {
    const idg = inputsFor("idg_followup", "rn");
    const routine = inputsFor("routine_visit", "rn");
    expect(draftedIds(routine)).toHaveLength(5);
    expect(draftedIds(idg)).toEqual(draftedIds(routine));
    for (const id of draftedIds(routine)) expect(textOf(idg, id), id).toBe(textOf(routine, id));
  });

  it("an LPN drafts the three sections an LPN visit does and never the PPS or ESAS-r sections", () => {
    const idg = inputsFor("idg_followup", "lpn");
    expect(draftedIds(idg)).toEqual(["interventions", "plan", "vitals_review"]);
    expect(sectionOf(idg, "assessment").state).toBe("empty");
    expect(sectionOf(idg, "symptom_management").state).toBe("empty");
  });

  it("a social worker drafts the plan of care as the follow-up visit does, from the discipline's own plan and not the care plan", () => {
    const idg = inputsFor("idg_followup", "msw");
    const followup = inputsFor("msw_followup", "msw");
    expect(draftedIds(idg)).toEqual(["interventions", "plan"]);
    for (const id of ["interventions", "plan"]) {
      expect(textOf(idg, id), id).toBe(textOf(followup, id));
      expect(textOf(idg, id), id).toContain("Plan-of-care");
    }
    expect(draftSourceNeeds("idg_followup", "msw")).toEqual({
      carePlan: false,
      vitals: false,
      medicationChanges: false,
      scales: false,
      disciplinePlan: true,
      idgFollowUp: true,
    });
  });

  it("a chaplain drafts the goals of the plan and nothing else, never the spiritual section", () => {
    const idg = inputsFor("idg_followup", "chaplain");
    expect(draftedIds(idg)).toEqual(["plan"]);
    expect(textOf(idg, "plan")).toBe(textOf(inputsFor("chaplain_visit", "chaplain"), "plan"));
    expect(sectionOf(idg, "spiritual").state).toBe("empty");
  });

  it("drafts nothing in the IDG decision follow-up section without a linked action item, whatever any other source carries (VN-D54)", () => {
    for (const discipline of ["rn", "lpn", "msw", "chaplain", "md", "np"] as const) {
      expect(
        sectionOf(inputsFor("idg_followup", discipline), "idg_followup").state,
        discipline,
      ).toBe("empty");
      expect(draftedSectionIds("idg_followup", discipline).has("idg_followup")).toBe(true);
    }
  });

  it("the telephonic visit of a physician or nurse practitioner stays empty with every source supplied", () => {
    for (const discipline of ["md", "np"] as const) {
      const draft = compileDraft(inputsFor("telephonic", discipline), DEPS);
      expect(draft.sections.map((s) => s.state)).toEqual(draft.sections.map(() => "empty"));
    }
  });
});
