// packages/hearthnote/__tests__/draft-recert.test.ts — S2: the recertification visit (and the F2F visit's prognosis) draft
// (design §3.3, VN-D31 to VN-D34). Synthetic names and ids only: no SSN, MBI, or value copied from a real record.
//
// What these pin: which sections each template drafts, the exact sentences (numbers and dates restated from structured fields,
// never a prognosis, an eligibility conclusion or a life expectancy), the as-of rules for the module-6 facts, fail-closed
// Part 2, and that a confirmation hash moves only with the section whose source changed.
import { describe, expect, it } from "vitest";
import {
  DraftInputError,
  type DraftInputs,
  type DraftSection,
  type DraftedSection,
  compileDraft,
  draftedSectionIds,
  templateHasDraftedSection,
} from "../src/index";
import { DEPS, baseInputs, deepFreeze, recertSources, reverseKeys } from "./_draft-fixtures";

/** The recertification visit: every source supplied, nothing selected. Mutable copy per call. */
function recertInputs(): DraftInputs {
  const base = baseInputs();
  return {
    ...base,
    encounterType: "recert_visit",
    discipline: "rn",
    selection: {
      templateKey: "recert_visit:rn",
      vocabVersion: base.selection.vocabVersion,
      encounterType: "recert_visit",
      discipline: "rn",
      sections: [],
    },
    ...recertSources(),
  };
}

/** The F2F visit by a nurse practitioner: the same sources, the F2F template. */
function f2fInputs(): DraftInputs {
  const base = recertInputs();
  return {
    ...base,
    encounterType: "face_to_face",
    discipline: "np",
    selection: {
      templateKey: "face_to_face:np",
      vocabVersion: base.selection.vocabVersion,
      encounterType: "face_to_face",
      discipline: "np",
      sections: [],
    },
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

const RECERT_DRAFTED = [
  "esas",
  "interventions",
  "plan",
  "pps",
  "prognosis",
  "recert_summary",
  "vitals_review",
];

describe("the sections each template drafts (scope is read off the corpus tags)", () => {
  it("the recertification visit drafts its four own sections and the base sections S1 already sources", () => {
    expect([...draftedSectionIds("recert_visit", "rn")].sort()).toEqual(RECERT_DRAFTED);
  });

  it("the face-to-face visit drafts prognosis and nothing else, for a physician and a nurse practitioner alike", () => {
    expect([...draftedSectionIds("face_to_face", "np")]).toEqual(["prognosis"]);
    expect([...draftedSectionIds("face_to_face", "md")]).toEqual(["prognosis"]);
    expect(templateHasDraftedSection("face_to_face", "np")).toBe(true);
  });

  it("the admission visit still drafts nothing (VN-D31: its sections follow in a later slice)", () => {
    expect(templateHasDraftedSection("admission_visit", "rn")).toBe(false);
    const admission = { ...recertInputs(), encounterType: "admission_visit" } as DraftInputs;
    expect(
      draftedIds({
        ...admission,
        selection: {
          ...admission.selection,
          templateKey: "admission_visit:rn",
          encounterType: "admission_visit",
        },
      }),
    ).toEqual([]);
  });

  it("compiles every drafted recertification section, and the base sections it does not source stay empty", () => {
    expect(draftedIds(recertInputs()).sort()).toEqual(RECERT_DRAFTED);
    // PPS and ESAS-r feed `pps` and `esas` here, so `assessment` and `symptom_management` never state them a second time.
    expect(section(recertInputs(), "assessment").state).toBe("empty");
    expect(section(recertInputs(), "symptom_management").state).toBe("empty");
  });
});

describe("the recertification sections' sentences", () => {
  it("pps and esas restate the reading and its change since the previous visit, as S1 words them", () => {
    expect(textOf(recertInputs(), "pps")).toBe("PPS 50%, down from 60% on 2026-11-10.");
    expect(textOf(recertInputs(), "esas")).toBe(
      "ESAS-r pain 4, down from 6 on 2026-11-10. ESAS-r tiredness 5, no earlier reading recorded.",
    );
  });

  it("pps compares with the benefit period's first reading when there is no reading before the last visit", () => {
    const inputs = recertInputs();
    const scaleReadings = inputs.scaleReadings.map((r) =>
      r.scaleType === "pps" ? { ...r, previous: null } : r,
    );
    expect(textOf({ ...inputs, scaleReadings }, "pps")).toBe(
      "PPS 50%, down from 80% on 2026-10-16.",
    );
  });

  it("prognosis sets the decline evidence beside the face-to-face facts: numbers and dates, no conclusion", () => {
    expect(textOf(recertInputs(), "prognosis")).toBe(
      "PPS 50%, down from 80% on 2026-10-16, the first reading of this benefit period. " +
        "Weight 118.5 lb on 2026-11-18, down 8.8% from 130 lb on 2026-10-16. " +
        "Face-to-face encounter performed by a hospice nurse practitioner on 2026-10-03, attested on 2026-10-05.",
    );
  });

  it("recert_summary states the benefit period, the level of care on the visit date and the signed certification", () => {
    expect(textOf(recertInputs(), "recert_summary")).toBe(
      "Benefit period 3, 60-day period from 2026-10-15 to 2026-12-13; day 35 on the date of this visit. " +
        "Level of care on the date of this visit: routine home care. " +
        "Certification of terminal illness for this benefit period signed on 2026-10-14.",
    );
  });

  it("the face-to-face prognosis carries the decline evidence but no period, certification or F2F sentence", () => {
    expect(textOf(f2fInputs(), "prognosis")).toBe(
      "PPS 50%, down from 80% on 2026-10-16, the first reading of this benefit period. " +
        "Weight 118.5 lb on 2026-11-18, down 8.8% from 130 lb on 2026-10-16.",
    );
    expect(draftedIds(f2fInputs())).toEqual(["prognosis"]);
  });

  it("never states a prognosis, an eligibility conclusion or a life expectancy", () => {
    const all = ["pps", "esas", "prognosis", "recert_summary"]
      .map((id) => textOf(recertInputs(), id))
      .join(" ")
      .toLowerCase()
      // "Certification of terminal illness" names the signed document, not a conclusion about this patient.
      .replace("certification of terminal illness", "");
    for (const word of [
      "terminal",
      "eligib",
      "six months",
      "6 months",
      "life expectancy",
      "declin",
      "qualif",
    ]) {
      expect(all).not.toContain(word);
    }
  });
});

describe("weight", () => {
  const baseWeight = recertInputs().weight as NonNullable<DraftInputs["weight"]>;
  const withWeight = (weight: unknown): DraftInputs =>
    ({ ...recertInputs(), weight }) as unknown as DraftInputs;
  const against130 = { value: "130", recordedOn: "2026-10-16" };

  it("the only weight of the period reads as such", () => {
    expect(textOf(withWeight({ ...baseWeight, baseline: null }), "prognosis")).toContain(
      "Weight 118.5 lb on 2026-11-18, the only weight recorded in this benefit period.",
    );
  });

  it("up, down and unchanged are arithmetic on the two values, with the change as a percentage to one decimal", () => {
    expect(
      textOf(withWeight({ ...baseWeight, value: "140", baseline: against130 }), "prognosis"),
    ).toContain("Weight 140 lb on 2026-11-18, up 7.7% from 130 lb on 2026-10-16.");
    expect(
      textOf(withWeight({ ...baseWeight, value: 130, baseline: against130 }), "prognosis"),
    ).toContain("Weight 130 lb on 2026-11-18, unchanged from 130 lb on 2026-10-16.");
  });

  it("a weight recorded after the visit time is not drafted", () => {
    const late = { ...baseWeight, recordedAt: "2026-11-18T15:00:00Z" };
    expect(textOf(withWeight(late), "prognosis")).not.toContain("Weight");
  });

  it("refuses a malformed weight instead of drafting around it", () => {
    for (const bad of [
      { ...baseWeight, unit: "stone" },
      { ...baseWeight, value: "abc" },
      { ...baseWeight, value: "0" },
      { ...baseWeight, value: "-5" },
      { ...baseWeight, baseline: { value: "0", recordedOn: "2026-10-16" } },
      { ...baseWeight, recordedOn: "2026-02-30" },
    ]) {
      expect(() => compileDraft(withWeight(bad), DEPS), JSON.stringify(bad)).toThrow(
        DraftInputError,
      );
    }
  });
});

describe("the module-6 facts are read as of the visit date (VN-D11)", () => {
  const f2f = recertInputs().benefitPeriod?.faceToFace;
  const withPeriod = (patch: Record<string, unknown>): DraftInputs => {
    const inputs = recertInputs();
    return {
      ...inputs,
      benefitPeriod: { ...inputs.benefitPeriod, ...patch },
    } as unknown as DraftInputs;
  };

  it("a face-to-face attested after the visit date is not drafted", () => {
    const after = withPeriod({ faceToFace: { ...f2f, attestedOn: "2026-11-19" } });
    expect(textOf(after, "prognosis")).not.toContain("Face-to-face");
    const same = withPeriod({ faceToFace: { ...f2f, attestedOn: "2026-11-18" } });
    expect(textOf(same, "prognosis")).toContain("Face-to-face");
  });

  it("a certification signed after the visit date is not drafted", () => {
    const after = withPeriod({
      certification: { id: "cti-3", signedOn: "2026-11-19", sudRelated: false },
    });
    expect(textOf(after, "recert_summary")).not.toContain("Certification");
    expect(textOf(withPeriod({ certification: null }), "recert_summary")).not.toContain(
      "Certification",
    );
  });

  it("a physician's face-to-face reads as a physician's", () => {
    const md = withPeriod({ faceToFace: { ...f2f, performerRole: "hospice_md" } });
    expect(textOf(md, "prognosis")).toContain("performed by a hospice physician on 2026-10-03");
  });

  it("names each level of care in words", () => {
    const words: Record<string, string> = {
      routine_home_care: "routine home care",
      continuous_home_care: "continuous home care",
      inpatient_respite_care: "inpatient respite care",
      general_inpatient_care: "general inpatient care",
    };
    for (const [code, text] of Object.entries(words)) {
      expect(textOf(withPeriod({ levelOfCare: code }), "recert_summary")).toContain(
        `Level of care on the date of this visit: ${text}.`,
      );
    }
  });

  it("a level of care that cannot be determined for the visit date leaves its sentence out and keeps the rest", () => {
    const text = textOf(withPeriod({ levelOfCare: null }), "recert_summary");
    expect(text).not.toContain("Level of care");
    expect(text).toContain("Benefit period 3, 60-day period from 2026-10-15 to 2026-12-13; day 35");
    expect(text).toContain("Certification of terminal illness");
  });

  it("a ninety-day period says 90, and the day of the period counts from 1 on the start date", () => {
    const ninety = withPeriod({
      periodKind: "ninety_day",
      startDate: "2026-11-18",
      endDate: "2027-02-15",
    });
    expect(textOf(ninety, "recert_summary")).toContain(
      "Benefit period 3, 90-day period from 2026-11-18 to 2027-02-15; day 1 on the date of this visit.",
    );
  });

  it("refuses a period that does not contain the service date, or a malformed one", () => {
    for (const bad of [
      { startDate: "2026-11-19", endDate: "2027-01-17" },
      { startDate: "2026-09-01", endDate: "2026-11-17" },
      { periodKind: "forty_day" },
      { levelOfCare: "respite" },
      { sequence: 0 },
      { startDate: "2026-02-30" },
      { faceToFace: { ...f2f, performerRole: "hospice_rn" } },
    ]) {
      expect(() => compileDraft(withPeriod(bad), DEPS), JSON.stringify(bad)).toThrow(
        DraftInputError,
      );
    }
  });
});

describe("Part 2 and the confirmation hash", () => {
  it("fails closed: a source that does not say it is not SUD-related makes its section Part 2 derived", () => {
    const inputs = recertInputs();
    const { sudRelated: _omit, ...weight } = inputs.weight as NonNullable<DraftInputs["weight"]>;
    const unflagged = { ...inputs, weight };
    expect((section(unflagged, "prognosis") as DraftedSection).part2Derived).toBe(true);
    // ...and only the sections that weight feeds.
    expect((section(unflagged, "pps") as DraftedSection).part2Derived).toBe(false);
    expect((section(inputs, "prognosis") as DraftedSection).part2Derived).toBe(false);
  });

  it("records every source kind in the section's refs, in order, for the audit trail", () => {
    const prognosis = section(recertInputs(), "prognosis") as DraftedSection;
    expect(prognosis.sourceRefs).toEqual([
      { kind: "scale_reading", id: "scale-pps-2" },
      { kind: "weight_reading", id: "weight-2" },
      { kind: "face_to_face", id: "f2f-1" },
    ]);
    const summary = section(recertInputs(), "recert_summary") as DraftedSection;
    expect(summary.sourceRefs).toEqual([
      { kind: "benefit_period", id: "period-3" },
      { kind: "certification", id: "cti-3" },
    ]);
  });

  it("a changed weight moves the prognosis hash and no other section's", () => {
    const before = compileDraft(recertInputs(), DEPS);
    const changed = recertInputs();
    const weight = { ...(changed.weight as NonNullable<DraftInputs["weight"]>), value: "119" };
    const after = compileDraft({ ...changed, weight }, DEPS);
    for (const s of before.sections) {
      const other = after.sections.find((x) => x.sectionId === s.sectionId);
      if (s.state !== "drafted" || other?.state !== "drafted") continue;
      if (s.sectionId === "prognosis") expect(other.contentHash).not.toBe(s.contentHash);
      else expect(other.contentHash, s.sectionId).toBe(s.contentHash);
    }
  });

  it("is independent of the order the readings arrive in and of key order, and never mutates its input", () => {
    const a = compileDraft(deepFreeze(recertInputs()), DEPS);
    const inputs = recertInputs();
    const shuffled = reverseKeys({ ...inputs, scaleReadings: [...inputs.scaleReadings].reverse() });
    expect(compileDraft(shuffled, DEPS)).toEqual(a);
  });
});

describe("the routine visit ignores the S2 sources", () => {
  it("is unchanged by a weight and a benefit period", () => {
    const { weight, benefitPeriod } = recertInputs();
    expect(compileDraft({ ...baseInputs(), weight, benefitPeriod }, DEPS)).toEqual(
      compileDraft(baseInputs(), DEPS),
    );
  });
});
