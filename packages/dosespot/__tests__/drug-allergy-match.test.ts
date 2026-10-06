// GAP-036 follow-up — the pure drug-allergy matcher: brand->generic normalization, drug->class and
// class->member resolution, documented cross-reactivity, and the legacy name-token fallback.
import { describe, expect, it } from "vitest";
import {
  DRUG_CLASSES,
  matchDrugToAllergy,
  normalizeToGenerics,
} from "../src/allergy/drug-allergy-match";

const kind = (drug: string, allergy: string) => matchDrugToAllergy(drug, allergy)?.kind ?? null;
const cls = (drug: string, allergy: string) => matchDrugToAllergy(drug, allergy)?.classId ?? null;

describe("normalizeToGenerics", () => {
  it.each([
    ["MS Contin 30 mg ER tablet", ["morphine"]],
    ["Roxanol", ["morphine"]],
    ["Dilaudid", ["hydromorphone"]],
    ["Duragesic 25 mcg/hr patch", ["fentanyl"]],
    ["Haldol", ["haloperidol"]],
    ["Ativan", ["lorazepam"]],
    ["Zofran ODT", ["ondansetron"]],
    ["Morphine Sulfate 20 mg/mL", ["morphine"]],
    ["Percocet", ["acetaminophen", "oxycodone"]],
  ])("%s", (input, expected) => {
    expect([...normalizeToGenerics(input)].sort()).toEqual(expected);
  });
  it("returns nothing for text with no known drug", () => {
    expect(normalizeToGenerics("NKDA").size).toBe(0);
  });
});

describe("matchDrugToAllergy — direct generic and brand/generic pairs", () => {
  it("same generic", () => expect(kind("Morphine", "morphine")).toBe("generic"));
  it("brand ordered, generic recorded", () =>
    expect(kind("MS Contin", "Morphine")).toBe("generic"));
  it("generic ordered, brand recorded", () =>
    expect(kind("Lorazepam", "Ativan - sedation")).toBe("generic"));
  it("salt/strength decoration never hides the drug", () =>
    expect(kind("Morphine Sulfate 20 mg/mL", "Morphine (hives)")).toBe("generic"));
  it("different drug of a non-cross-reactive class is clear", () => {
    expect(matchDrugToAllergy("Fentanyl", "morphine")).toBeNull();
    expect(matchDrugToAllergy("Haloperidol", "morphine")).toBeNull();
  });
});

describe("matchDrugToAllergy — class allergies", () => {
  it.each([
    ["Morphine", "opioids", "opioid"],
    ["Hydromorphone", "Opiate allergy", "opioid"],
    ["Fentanyl patch", "narcotics", "opioid"],
    ["Oxycodone", "OPIOIDS - nausea", "opioid"],
    ["Amoxicillin", "penicillins", "penicillin"],
    ["Augmentin", "PCN allergy", "penicillin"],
    ["Cephalexin", "cephalosporins", "cephalosporin"],
    ["Ceftriaxone", "beta-lactam antibiotics", "beta_lactam"],
    ["Bactrim DS", "sulfa drugs", "sulfonamide_antibiotic"],
    ["Sulfamethoxazole", "sulfonamides", "sulfonamide_antibiotic"],
    ["Ibuprofen", "NSAIDs", "nsaid"],
    ["Atorvastatin", "statins", "statin"],
    ["Lorazepam", "benzodiazepines", "benzodiazepine"],
    ["Midazolam", "benzos", "benzodiazepine"],
  ])("%s vs %s", (drug, allergy, expectedClass) => {
    const m = matchDrugToAllergy(drug, allergy);
    expect(m?.kind).toBe("class");
    expect(m?.classId).toBe(expectedClass);
  });
  it("a class allergy does not block an unrelated class", () => {
    expect(matchDrugToAllergy("Haloperidol", "opioids")).toBeNull();
    expect(matchDrugToAllergy("Ondansetron", "penicillins")).toBeNull();
  });
  it("'sulfa' does not match a sulfate salt", () => {
    expect(matchDrugToAllergy("Morphine Sulfate", "sulfa")).toBeNull();
  });
});

describe("matchDrugToAllergy — documented cross-reactivity", () => {
  it("penicillin allergy flags cephalosporins", () => {
    expect(kind("Cefazolin", "penicillin")).toBe("cross_reactive");
    expect(cls("Cefazolin", "penicillin")).toBe("cephalosporin");
  });
  it("cephalosporin allergy flags penicillins", () => {
    expect(kind("Amoxicillin", "cefdinir")).toBe("cross_reactive");
  });
  it("an allergy to one NSAID flags the rest of the NSAIDs", () => {
    expect(kind("Ketorolac", "aspirin")).toBe("class_member");
    expect(cls("Ketorolac", "ibuprofen")).toBe("nsaid");
  });
  it("an allergy to one opioid does NOT flag other opioids (rotation is routine)", () => {
    expect(matchDrugToAllergy("Hydromorphone", "morphine")).toBeNull();
  });
  it("an allergy to one statin does not flag the class", () => {
    expect(matchDrugToAllergy("Simvastatin", "atorvastatin")).toBeNull();
  });
});

describe("matchDrugToAllergy — fallback and non-allergies", () => {
  it("falls back to a shared name token for a drug outside the map", () => {
    expect(kind("Zzzorbex 5 mg", "zzzorbex rash")).toBe("name");
  });
  it.each(["NKDA", "no known drug allergies", "latex", "shellfish"])("%s does not match", (a) => {
    expect(matchDrugToAllergy("Morphine", a)).toBeNull();
  });
  it("blank text matches nothing", () => {
    expect(matchDrugToAllergy("Morphine", "  ")).toBeNull();
    expect(matchDrugToAllergy("", "morphine")).toBeNull();
  });
});

describe("DRUG_CLASSES data integrity", () => {
  it("every class has a label and every parent exists", () => {
    for (const [id, c] of Object.entries(DRUG_CLASSES)) {
      expect(c.label.length, id).toBeGreaterThan(0);
      for (const p of c.parents ?? []) expect(DRUG_CLASSES[p], `${id} parent ${p}`).toBeDefined();
    }
  });
});
