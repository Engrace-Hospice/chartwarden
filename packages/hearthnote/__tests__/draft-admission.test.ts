// packages/hearthnote/__tests__/draft-admission.test.ts — S2b: the RN admission visit's draft (design §3.3, VN-D35 to VN-D38).
// Synthetic names and ids only: no SSN, MBI, or value copied from a real record.
//
// What these pin: which sections the admission visit drafts, the exact sentences (a fact that is on record: an order in effect, a
// caregiver as recorded, an acknowledgment on file; never "reconciled", never a directive the patient has or lacks, never an absence),
// the order inside each section, fail-closed Part 2, and that no other template reads the admission sources.
import { describe, expect, it } from "vitest";
import {
  DraftInputError,
  type DraftInputs,
  type DraftSection,
  compileDraft,
  draftedSectionIds,
  templateHasDraftedSection,
} from "../src/index";
import { DEPS, admissionSources, baseInputs, deepFreeze, reverseKeys } from "./_draft-fixtures";

/** The admission visit: every source supplied, nothing selected. Mutable copy per call. */
function admissionInputs(): DraftInputs {
  const base = baseInputs();
  return {
    ...base,
    encounterType: "admission_visit",
    discipline: "rn",
    selection: {
      templateKey: "admission_visit:rn",
      vocabVersion: base.selection.vocabVersion,
      encounterType: "admission_visit",
      discipline: "rn",
      sections: [],
    },
    ...admissionSources(),
  };
}

const section = (inputs: DraftInputs, id: string): DraftSection => {
  const found = compileDraft(inputs, DEPS).sections.find((s) => s.sectionId === id);
  if (found === undefined) throw new Error(`no section '${id}'`);
  return found;
};
const textOf = (inputs: DraftInputs, id: string): string => {
  const s = section(inputs, id);
  return s.state === "drafted" ? s.text : "";
};
const draftedIds = (inputs: DraftInputs): string[] =>
  compileDraft(inputs, DEPS)
    .sections.filter((s) => s.state === "drafted")
    .map((s) => s.sectionId);

const ADMISSION_DRAFTED = [
  "advance_directive",
  "baseline_symptoms",
  "caregiver_overview",
  "interventions",
  "med_reconciliation",
  "plan",
  "vitals_review",
];

describe("the sections the admission visit drafts (scope is read off the corpus tags)", () => {
  it("drafts its four own sections and the base sections the routine visit already sources", () => {
    expect([...draftedSectionIds("admission_visit", "rn")].sort()).toEqual(ADMISSION_DRAFTED);
    expect(templateHasDraftedSection("admission_visit", "rn")).toBe(true);
  });

  it("compiles every drafted section; assessment and symptom_management state nothing a second time", () => {
    expect(draftedIds(admissionInputs()).sort()).toEqual(ADMISSION_DRAFTED);
    // The PPS phrases are not tagged for the admission visit and the ESAS-r phrases feed `baseline_symptoms`.
    expect(section(admissionInputs(), "assessment").state).toBe("empty");
    expect(section(admissionInputs(), "symptom_management").state).toBe("empty");
  });

  // S5 (VN-D52) reverses VN-D38: the face-to-face visit by a physician or nurse practitioner now drafts `med_reconciliation`, from the orders in
  // effect and nothing else of the admission record (the caregivers and the advance directive are not sections of its template).
  it("the face-to-face visit drafts the orders in effect as the admission visit does, and nothing else of the admission record", () => {
    expect([...draftedSectionIds("face_to_face", "np")].sort()).toEqual([
      "med_reconciliation",
      "prognosis",
      "vitals_review",
    ]);
    const base = admissionInputs();
    const f2f: DraftInputs = {
      ...base,
      encounterType: "face_to_face",
      discipline: "np",
      selection: {
        ...base.selection,
        templateKey: "face_to_face:np",
        encounterType: "face_to_face",
        discipline: "np",
      },
    };
    expect(textOf(f2f, "med_reconciliation")).toBe(textOf(base, "med_reconciliation"));
  });

  it("the routine and recertification visits ignore the admission sources", () => {
    const base = admissionInputs();
    for (const [encounterType, key] of [
      ["routine_visit", "routine_visit:rn"],
      ["recert_visit", "recert_visit:rn"],
    ] as const) {
      const inputs: DraftInputs = {
        ...base,
        encounterType,
        selection: { ...base.selection, templateKey: key, encounterType },
      };
      const ids = compileDraft(inputs, DEPS).sections.map((s) => s.sectionId);
      for (const own of [
        "med_reconciliation",
        "advance_directive",
        "caregiver_overview",
        "baseline_symptoms",
      ]) {
        expect(ids, encounterType).not.toContain(own);
      }
    }
  });
});

describe("med_reconciliation: the orders in effect at the visit", () => {
  it("states each order by drug name, strength, form and route, as needed where it is, and nothing about reconciliation", () => {
    expect(textOf(admissionInputs(), "med_reconciliation")).toBe(
      "Active order at the visit, as needed: Morphine sulfate 20 mg/mL oral solution, oral. " +
        "Active order at the visit: Senna 8.6 mg tablet, oral.",
    );
  });

  it("orders by drug name then id, whatever order the records arrived in", () => {
    const inputs = admissionInputs();
    const reversed = {
      ...inputs,
      activeMedications: [...(inputs.activeMedications ?? [])].reverse(),
    };
    expect(textOf(reversed, "med_reconciliation")).toBe(textOf(inputs, "med_reconciliation"));
  });

  it("drafts nothing for a patient with no order in effect: an absence is never stated", () => {
    expect(
      section({ ...admissionInputs(), activeMedications: [] }, "med_reconciliation").state,
    ).toBe("empty");
    const { activeMedications: _omitted, ...without } = admissionInputs();
    expect(section(without, "med_reconciliation").state).toBe("empty");
  });

  it("refuses an order with no drug name or an unreadable field instead of drafting around it", () => {
    const bad = (over: Record<string, unknown>): DraftInputs => ({
      ...admissionInputs(),
      activeMedications: [
        { ...(admissionSources().activeMedications?.[0] ?? {}), ...over } as never,
      ],
    });
    expect(() => compileDraft(bad({ drugName: "  " }), DEPS)).toThrow(DraftInputError);
    expect(() => compileDraft(bad({ strength: "" }), DEPS)).toThrow(DraftInputError);
    expect(() => compileDraft(bad({ route: "\n" }), DEPS)).toThrow(DraftInputError);
  });
});

describe("advance_directive: the acknowledgment on file", () => {
  it("states that an acknowledgment was on file, and nothing about what the patient has or wants", () => {
    expect(textOf(admissionInputs(), "advance_directive")).toBe(
      "An advance directive acknowledgment was on file at the time of the visit.",
    );
  });

  it("drafts nothing when none was on file: the section is the clinician's to write", () => {
    expect(
      section({ ...admissionInputs(), advanceDirective: null }, "advance_directive").state,
    ).toBe("empty");
    const { advanceDirective: _omitted, ...without } = admissionInputs();
    expect(section(without, "advance_directive").state).toBe("empty");
  });
});

describe("caregiver_overview: the caregivers on record on the service date", () => {
  it("names the primary caregiver first, then the others by name, with the relationship in words and no contact detail", () => {
    expect(textOf(admissionInputs(), "caregiver_overview")).toBe(
      "Alex Rivera (spouse) is recorded as the primary caregiver. Sam Okafor (friend) is recorded as a caregiver.",
    );
  });

  it("reads every relationship the record can hold in plain words", () => {
    const words: Record<string, string> = {
      spouse: "spouse",
      child: "child",
      parent: "parent",
      sibling: "sibling",
      other_family: "other family member",
      friend: "friend",
      guardian: "guardian",
      paid_caregiver: "paid caregiver",
    };
    for (const [relationship, word] of Object.entries(words)) {
      const inputs: DraftInputs = {
        ...admissionInputs(),
        caregivers: [
          {
            id: "c",
            displayName: "Test Caregiver",
            relationship: relationship as never,
            isPrimary: false,
            sudRelated: false,
          },
        ],
      };
      expect(textOf(inputs, "caregiver_overview"), relationship).toBe(
        `Test Caregiver (${word}) is recorded as a caregiver.`,
      );
    }
  });

  it("drafts nothing when no caregiver is on record, and refuses a relationship it has no word for", () => {
    expect(section({ ...admissionInputs(), caregivers: [] }, "caregiver_overview").state).toBe(
      "empty",
    );
    const unknown: DraftInputs = {
      ...admissionInputs(),
      caregivers: [
        {
          id: "c",
          displayName: "Test Caregiver",
          relationship: "neighbor" as never,
          isPrimary: false,
          sudRelated: false,
        },
      ],
    };
    expect(() => compileDraft(unknown, DEPS)).toThrow(DraftInputError);
  });

  it("does not carry a caregiver's contact details into the draft", () => {
    const inputs: DraftInputs = {
      ...admissionInputs(),
      caregivers: [
        {
          id: "c",
          displayName: "Test Caregiver",
          relationship: "friend",
          isPrimary: true,
          sudRelated: false,
          // a producer that passes more than the contract names must not leak it into the text
          phone: "555-0100",
          email: "caregiver@example.test",
        } as never,
      ],
    };
    const text = textOf(inputs, "caregiver_overview");
    expect(text).not.toContain("555");
    expect(text).not.toContain("@");
  });
});

describe("baseline_symptoms: the ESAS-r readings as of the visit", () => {
  it("states each reading by symptom, with its change since the earlier reading when there is one", () => {
    const inputs: DraftInputs = {
      ...admissionInputs(),
      scaleReadings: [
        {
          id: "scale-esas-tiredness",
          scaleType: "esas_r",
          label: "tiredness",
          value: 5,
          recordedAt: "2026-11-18T14:12:00Z",
          previous: null,
          sudRelated: false,
        },
        {
          id: "scale-esas-pain",
          scaleType: "esas_r",
          label: "pain",
          value: 4,
          recordedAt: "2026-11-18T14:12:00Z",
          previous: { value: 6, recordedOn: "2026-11-10" },
          sudRelated: false,
        },
      ],
    };
    expect(textOf(inputs, "baseline_symptoms")).toBe(
      "ESAS-r pain 4, down from 6 on 2026-11-10. ESAS-r tiredness 5, no earlier reading recorded.",
    );
  });

  it("drafts nothing when there is no ESAS-r reading (a PPS reading is not a symptom baseline)", () => {
    const inputs: DraftInputs = {
      ...admissionInputs(),
      scaleReadings: baseInputs().scaleReadings.filter((r) => r.scaleType !== "esas_r"),
    };
    expect(section(inputs, "baseline_symptoms").state).toBe("empty");
  });
});

describe("Part 2 and determinism", () => {
  const part2 = (inputs: DraftInputs, id: string): boolean => {
    const s = section(inputs, id);
    if (s.state !== "drafted") throw new Error(`section '${id}' is not drafted`);
    return s.part2Derived;
  };

  it("is Part 2 derived when an order is SUD-related, and not otherwise", () => {
    const clean = admissionInputs();
    expect(part2(clean, "med_reconciliation")).toBe(false);
    const sud: DraftInputs = {
      ...clean,
      activeMedications: (clean.activeMedications ?? []).map((m, i) =>
        i === 0 ? { ...m, sudRelated: true } : m,
      ),
    };
    expect(part2(sud, "med_reconciliation")).toBe(true);
  });

  it("reads a missing flag fail closed: only the literal false proves a source is not SUD-related", () => {
    const clean = admissionInputs();
    const unflagged: DraftInputs = {
      ...clean,
      advanceDirective: { id: "consent-ad-1" },
      caregivers: (clean.caregivers ?? []).map(({ sudRelated: _s, ...rest }) => rest),
    };
    expect(part2(unflagged, "advance_directive")).toBe(true);
    expect(part2(unflagged, "caregiver_overview")).toBe(true);
  });

  it("is the same draft, byte for byte, whatever order the keys arrive in, and never mutates its inputs", () => {
    const frozen = deepFreeze(admissionInputs());
    const a = compileDraft(frozen, DEPS);
    const b = compileDraft(reverseKeys(admissionInputs()), DEPS);
    expect(b).toEqual(a);
  });

  it("moves a section's hash only with the section whose source changed", () => {
    const base = compileDraft(admissionInputs(), DEPS).sections;
    const changed = compileDraft({ ...admissionInputs(), advanceDirective: null }, DEPS).sections;
    const hashOf = (sections: readonly DraftSection[], id: string): string | undefined => {
      const s = sections.find((x) => x.sectionId === id);
      return s?.state === "drafted" ? s.contentHash : undefined;
    };
    for (const id of [
      "med_reconciliation",
      "caregiver_overview",
      "baseline_symptoms",
      "vitals_review",
    ]) {
      expect(hashOf(changed, id), id).toBe(hashOf(base, id));
    }
    expect(hashOf(changed, "advance_directive")).toBeUndefined();
  });
});
