// F-237 — the deterministic DocLens SUD flagger (M22 §7.4 W4 / D8, 42 CFR Part 2). Pure: Docling-shaped
// text blocks in, indicators (page, category, rule, block box) out.
import { detectSudIndicators, dominantSudCategory } from "@wardenx/intake-extraction";
import { describe, expect, it } from "vitest";

const BOX = [10, 20, 300, 34] as const;
const page = (n: number, ...lines: string[]) => ({
  page: n,
  blocks: lines.map((text, i) => ({ text, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as const })),
});
const rules = (lines: string[]) =>
  detectSudIndicators([page(1, ...lines)]).map((i) => `${i.category}:${i.ruleId}`);

describe("F-237 SUD flagger — what it flags", () => {
  it("flags MAT medications on a med list, with the block's page and box", () => {
    const found = detectSudIndicators([
      { page: 2, blocks: [{ text: "Suboxone 8 mg/2 mg SL daily", bbox: BOX }] },
    ]);
    expect(found).toEqual([
      { page: 2, category: "medication", ruleId: "med:buprenorphine", term: "Suboxone", bbox: BOX },
    ]);
  });

  it.each([
    ["Methadone 10 mg PO q8h for pain", "medication:med:methadone"],
    ["Vivitrol 380 mg IM monthly", "medication:med:naltrexone"],
    ["Antabuse 250 mg daily", "medication:med:aud-pharmacotherapy"],
    ["Dx: F11.20 Opioid dependence, uncomplicated", "diagnosis:dx:icd10-f1x"],
    ["Alcohol use disorder, severe", "diagnosis:dx:use-disorder"],
    ["Hx of alcoholic cirrhosis", "diagnosis:dx:alcoholism"],
    ["Admitted for alcohol withdrawal", "diagnosis:dx:withdrawal"],
    ["PMH: COPD, OUD on MAT", "diagnosis:dx:abbreviation"],
    ["Former IV drug use", "social_history:sh:injection-use"],
    ["Remote heroin use", "social_history:sh:illicit"],
    ["Attends Alcoholics Anonymous weekly", "social_history:sh:recovery"],
    ["Enrolled in an opioid treatment program", "treatment_setting:tx:mat"],
    ["Discharged from Riverside Detox Center", "treatment_setting:tx:program"],
  ])("%s → %s", (line, expected) => {
    expect(rules([line])).toContain(expected);
  });

  it("excludes tobacco (F17) — 42 CFR §2.11 excludes tobacco from SUD", () => {
    expect(rules(["F17.210 Nicotine dependence, cigarettes"])).toEqual([]);
  });

  it("does not flag common hospice opioids or a bare F-code", () => {
    expect(
      rules(["Fentanyl 25 mcg/hr patch q72h", "Morphine 5 mg PO q4h PRN", "Room F10"]),
    ).toEqual([]);
  });

  it("negation suppresses diagnosis/social wording, but never a medication", () => {
    expect(rules(["Social: denies alcohol abuse or IV drug use"])).toEqual([]);
    expect(rules(["No history of drug abuse"])).toEqual([]);
    expect(rules(["No changes: continue methadone 5 mg"])).toEqual(["medication:med:methadone"]);
  });

  it("is case-sensitive for abbreviations (a lower-case 'mat' or 'sud' is not MAT / SUD)", () => {
    expect(rules(["Patient sits on a mat", "sud-den onset"])).toEqual([]);
  });

  it("one indicator per rule per block, across pages", () => {
    const found = detectSudIndicators([
      page(1, "methadone 5 mg; methadone 10 mg"),
      page(3, "Buprenorphine patch"),
    ]);
    expect(found.map((i) => [i.page, i.ruleId])).toEqual([
      [1, "med:methadone"],
      [3, "med:buprenorphine"],
    ]);
  });

  it("dominantSudCategory picks the most frequent category", () => {
    const found = detectSudIndicators([
      page(1, "Opioid use disorder", "F11.20", "Methadone 30 mg daily"),
    ]);
    expect(dominantSudCategory(found)).toBe("diagnosis");
  });
});
