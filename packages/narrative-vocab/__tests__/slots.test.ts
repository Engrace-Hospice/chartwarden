// Slot-value and exclusive-statement validation for the narrative corpus (WF09 step 1).
//
// Before this, a `${slot}` accepted any string or number: a clinician could record oxygen at "79 L/min via
// nasal cannula", "requires 14 assistance with transfers", or "pain well controlled" and "pain limiting
// function" in the same note. The phrase bytes are D11-pinned (a signed note must re-read identically), so
// the fix constrains the VALUES, never the phrases — `shipped phrases are byte-stable` below is what makes
// that claim checkable.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { VOCABULARY, entrySlots, getVocabEntry, validateSelectionTree } from "../src/index";

type Tree = Parameters<typeof validateSelectionTree>[0];
const draft = (sections: Tree) => validateSelectionTree(sections, { requireComplete: false });
const complete = (sections: Tree) => validateSelectionTree(sections, { requireComplete: true });
const one = (code: string, params?: Record<string, string | number>): Tree => [
  { sectionId: "assessment", entries: [{ code, ...(params ? { params } : {}) }] },
];

describe("numeric slots", () => {
  it("rejects an oxygen flow no nasal cannula delivers", () => {
    const issues = draft(one("nv.resp.dyspnea", { o2_lpm: 79 }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "SLOT_INVALID",
      sectionId: "assessment",
      entryCode: "nv.resp.dyspnea",
      slot: "o2_lpm",
    });
    expect(issues[0]?.message).toMatch(/0\.5.*6/);
  });

  it("accepts in-range numbers and numeric strings (the composer sends strings)", () => {
    expect(draft(one("nv.resp.dyspnea", { o2_lpm: 2 }))).toEqual([]);
    expect(draft(one("nv.resp.dyspnea", { o2_lpm: "2.5" }))).toEqual([]);
    expect(draft(one("nv.sym.pain_controlled", { pain_score: "4" }))).toEqual([]);
  });

  it("rejects a pain score outside 0–10 or with a fraction", () => {
    for (const bad of [11, -1, "4.5", "abc", Number.NaN]) {
      expect(draft(one("nv.sym.pain_controlled", { pain_score: bad }))).toHaveLength(1);
    }
    expect(draft(one("nv.sym.pain_controlled", { pain_score: 0 }))).toEqual([]);
    expect(draft(one("nv.sym.pain_controlled", { pain_score: 10 }))).toEqual([]);
  });
});

describe("choice slots", () => {
  it("rejects a transfer-assistance level that is a bare number", () => {
    expect(draft(one("nv.msk.limited", { assist_level: "14" }))).toHaveLength(1);
    expect(draft(one("nv.msk.limited", { assist_level: "moderate" }))).toEqual([]);
  });

  it("requires an edema grade from the clinical scale, and keeps the seeded '2+' legal", () => {
    expect(draft(one("nv.cv.edema", { edema_grade: "3" }))).toHaveLength(1);
    for (const ok of ["trace", "1+", "2+", "3+", "4+"]) {
      expect(draft(one("nv.cv.edema", { edema_grade: ok }))).toEqual([]);
    }
  });

  it("requires a distance with its unit", () => {
    expect(draft(one("nv.sym.dyspnea_impact", { ambulation_distance: "20" }))).toHaveLength(1);
    expect(draft(one("nv.sym.dyspnea_impact", { ambulation_distance: "25 feet" }))).toEqual([]);
  });
});

describe("incomplete and free-text slots", () => {
  it("lets a draft carry an empty slot but refuses it at finalize", () => {
    const tree = one("nv.cv.edema", { edema_grade: "" });
    expect(draft(tree)).toEqual([]);
    expect(complete(tree)).toEqual([
      expect.objectContaining({ code: "SLOT_INCOMPLETE", slot: "edema_grade" }),
    ]);
    expect(complete(one("nv.cv.edema"))).toHaveLength(1);
  });

  it("treats an entry with no slots as always complete", () => {
    expect(complete(one("nv.cv.stable"))).toEqual([]);
  });

  it("bounds a free-text slot and requires it non-blank at finalize", () => {
    const tree = (v: string) => one("nv.gi.intact", { last_bm: v });
    expect(draft(tree("yesterday"))).toEqual([]);
    expect(draft(tree("x".repeat(201)))).toHaveLength(1);
    expect(complete(tree("   "))).toHaveLength(1);
  });

  it("ignores an unknown code (assembly owns UNKNOWN_VOCAB_CODE)", () => {
    expect(complete(one("nv.nope"))).toEqual([]);
  });
});

describe("mutually exclusive statements", () => {
  it("refuses 'pain controlled' and 'pain limiting function' in one note, across sections", () => {
    const issues = draft([
      {
        sectionId: "symptom_management",
        entries: [{ code: "nv.sym.pain_controlled", params: { pain_score: 5 } }],
      },
      {
        sectionId: "assessment",
        entries: [{ code: "nv.sym.pain_uncontrolled", params: { pain_score: 6 } }],
      },
    ]);
    expect(issues).toEqual([
      expect.objectContaining({
        code: "EXCLUSIVE_CONFLICT",
        sectionId: "assessment",
        entryCode: "nv.sym.pain_uncontrolled",
      }),
    ]);
  });

  it("covers respiratory, neurological and skin contradictions too", () => {
    for (const [a, b] of [
      ["nv.resp.unlabored", "nv.resp.dyspnea"],
      ["nv.neuro.alert", "nv.neuro.decline"],
      ["nv.integ.intact", "nv.integ.wound"],
    ] as const) {
      const issues = draft([{ sectionId: "assessment", entries: [{ code: a }, { code: b }] }]);
      expect(issues.map((i) => i.code)).toEqual(["EXCLUSIVE_CONFLICT"]);
    }
  });

  it("allows compatible statements and a repeated identical code", () => {
    expect(
      draft([
        {
          sectionId: "assessment",
          entries: [{ code: "nv.cv.stable" }, { code: "nv.resp.dyspnea", params: { o2_lpm: 2 } }],
        },
        { sectionId: "plan", entries: [{ code: "nv.cv.stable" }] },
      ]),
    ).toEqual([]);
  });
});

describe("corpus metadata integrity", () => {
  it("entrySlots lists a phrase's slots minus the two the assembly context fills", () => {
    expect(entrySlots(getVocabEntry("nv.cv.edema")!)).toEqual(["edema_grade"]);
    expect(entrySlots(getVocabEntry("nv.cv.stable")!)).toEqual([]);
  });

  it("every slotSpecs key is a real slot of its phrase", () => {
    for (const e of VOCABULARY) {
      for (const slot of Object.keys(e.slotSpecs ?? {})) {
        expect(entrySlots(e), `${e.code} declares a spec for '${slot}'`).toContain(slot);
      }
    }
  });

  it("exclusive groups hold at least two entries of one category", () => {
    const groups = new Map<string, string[]>();
    for (const e of VOCABULARY) {
      if (e.exclusiveGroup) {
        groups.set(e.exclusiveGroup, [...(groups.get(e.exclusiveGroup) ?? []), e.category]);
      }
    }
    expect(groups.size).toBeGreaterThan(0);
    for (const [group, categories] of groups) {
      expect(categories.length, group).toBeGreaterThanOrEqual(2);
      expect(new Set(categories).size, group).toBe(1);
    }
  });

  // D11: a signed note is re-read years later against the corpus that wrote it. This pins the bytes of every
  // phrase shipped in narrative-vocab@2026.06.0. Adding an entry is fine; changing one of these is not —
  // ship a NEW code (and retire the old from menus) in a new release instead.
  const SHIPPED_2026_06: Readonly<Record<string, string>> = {
    "nv.cv.stable": "044f4fce237179ce",
    "nv.cv.edema": "027a69a915274344",
    "nv.resp.unlabored": "db6d6d380d31847d",
    "nv.resp.dyspnea": "c720f04418c94fff",
    "nv.neuro.alert": "905301fa284911ad",
    "nv.neuro.decline": "ccfce7df36d6e196",
    "nv.gi.intact": "3d898580e92f1b34",
    "nv.gu.continent": "e2676ef6d7793be4",
    "nv.integ.intact": "c549c2b4992fc62a",
    "nv.integ.wound": "50af4e3006286266",
    "nv.msk.limited": "ffa5518d7db90d99",
    "nv.sym.pain_controlled": "1522d048d6401a33",
    "nv.sym.pain_uncontrolled": "3c4a778eff544df1",
    "nv.sym.dyspnea_impact": "385cad8194c73668",
    "nv.cp.medrec": "0f2a54fd7c51d9d2",
    "nv.cp.caregiver_taught": "e9587bc722a0b406",
    "nv.cp.goals_progress": "5ca1b718caf53f11",
    "nv.ps.coping": "e575289d779eb667",
    "nv.ps.family_dynamics": "798be7150dba135c",
    "nv.sp.assessment": "1406d0dd66c2788e",
    "nv.sp.support": "8167f7ce7f3987b8",
    "nv.adl.personal_care": "6c40e4d2d5a88b3b",
    "nv.att.f2f": "2b79852803fdcee2",
  };

  it("shipped phrases are byte-stable (D11)", () => {
    for (const [code, hash] of Object.entries(SHIPPED_2026_06)) {
      const phrase = getVocabEntry(code)?.phrase;
      expect(phrase, `${code} was removed from the corpus`).toBeDefined();
      const actual = createHash("sha256")
        .update(phrase as string)
        .digest("hex")
        .slice(0, 16);
      expect(actual, `${code}'s phrase changed — ship a new code instead`).toBe(hash);
    }
  });
});
