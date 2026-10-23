import { describe, expect, it } from "vitest";
import {
  PARTNER_IDENTIFIER_KINDS,
  containsPartnerIdentifier,
  findPartnerIdentifierKinds,
} from "./external-share-identifiers";

const POSITIVE: ReadonlyArray<readonly [string, string]> = [
  ["SSN 123-45-6789 on file", "ssn"],
  ["her number is 123 45 6789", "ssn"],
  ["9 digits 123456789", "long_number"],
  ["acct 99887766", "long_number"],
  ["MRN: A12345", "labelled_identifier"],
  ["mrn A12345", "labelled_identifier"],
  ["MRN123 please confirm", "labelled_identifier"],
  ["DOB:4/12/1950", "labelled_identifier"],
  ["dob4/12/50", "labelled_identifier"],
  ["DOB is needed", "labelled_identifier"],
  ["D.O.B. unknown", "labelled_identifier"],
  ["DOS 10/22 for the claim", "labelled_identifier"],
  ["account number needed", "labelled_identifier"],
  ["patient id please", "labelled_identifier"],
  ["ＭＲＮ: A1 on the chart", "labelled_identifier"],
  ["born 4/12/1950", "date_numeric"],
  ["04-12-50", "date_numeric"],
  ["1950-04-12", "date_iso"],
  ["1887-03-12", "date_iso"],
  ["1950/04/12", "date_iso"],
  ["April 12, 1950", "date_named"],
  ["12 April 1950", "date_named"],
  ["12 March 1887", "date_named"],
  ["Sept 3rd 1948", "date_named"],
  ["call 555-123-4567", "phone"],
  ["(555) 123-4567", "phone"],
  ["+1 555 123 4567", "phone"],
  ["555.123.4567", "phone"],
  ["send to ann.lee@example.com", "email"],
  ["lives at 123 Main Street", "street_address"],
  ["45 Oak Hill Road", "street_address"],
  ["9 Sunset Blvd.", "street_address"],
  // spaced, dashed and split digit runs (the collapsed view)
  ["1 2 3 4 5 6", "long_number"],
  ["123-456-789", "long_number"],
  ["12 34 56", "long_number"],
  ["id 12\n34\n56", "long_number"],
  ["1 - 2 - 3 - 4 - 5 - 6", "long_number"],
  // evasions: format characters, fullwidth digits, other scripts' digits
  ["1​2​3​4​5​6", "long_number"],
  ["12­34­56", "long_number"],
  ["１２３４５６", "long_number"],
  ["١٢٣٤٥٦", "long_number"],
  ["१२३४५६", "long_number"],
  ["ann​@example.com", "email"],
];

const NEGATIVE: readonly string[] = [
  "5 mg",
  "give 2 tabs",
  "2 tabs by mouth twice daily",
  "room 214",
  "at 10:30 and again at 14:30",
  "BP 120/80, pulse 88",
  "O2 sat 94% on 2 L",
  "pain 5/10",
  "1000 mL NS over 4 hours",
  "q4h prn",
  "see you 10/23",
  "Dr. Lee called about the refill",
  "1 mm ST elevation noted",
  "2 tabs per Dr. Smith",
  "lot 12345 expires soon",
  "Tylenol 500 mg x 2",
  "hospice since 2026",
  "10-12 mg range",
  "weight 70.5 kg",
  "ext 2145",
  "ordered 3 units on 10/23",
  "1/2 tab in the morning",
  "250-1000 mg",
  "refill ready for pickup tomorrow",
  "the delivery van is on the way",
  "Is the 30-day supply ready?",
  "May I confirm the order?",
  "March delivery is on hold",
  // vitals and labs: a letter, slash, colon, comma or decimal point always sits between the numbers
  "HR 88, BP 120/80, RR 18, T 98.6, SpO2 94%",
  "INR 2.5, K 4.1, Na 140, Cr 1.2, WBC 11.2, Hgb 9.8",
  "glucose 142 mg/dL, A1c 7.2%",
  "weight 150 lb, height 68 in, BMI 22.8",
  "eGFR 45 and platelets 210",
  "Na 140 K 4.1 Cl 102 CO2 24",
  // small numbers separated by spaces stay under six digits in total
  "take 2 3 times daily",
  "titrate 5 10 15 mg",
  "1 2 3 4 5",
  "bed 12 room 214",
  // words that merely contain a label
  "dose adjusted to 10 mg",
  "dosing schedule attached",
  "start dobutamine drip",
  "mRNA vaccine given",
  "the doberman barked",
];

describe("findPartnerIdentifierKinds", () => {
  it.each(POSITIVE)("withholds %j (%s)", (text, kind) => {
    expect(findPartnerIdentifierKinds(text)).toContain(kind);
    expect(containsPartnerIdentifier(text)).toBe(true);
  });

  it.each(NEGATIVE)("passes ordinary clinical shorthand %j", (text) => {
    expect(findPartnerIdentifierKinds(text)).toEqual([]);
    expect(containsPartnerIdentifier(text)).toBe(false);
  });

  it("has a positive fixture for every kind it claims to cover", () => {
    const covered = new Set(POSITIVE.map(([, kind]) => kind));
    for (const kind of PARTNER_IDENTIFIER_KINDS) expect(covered.has(kind), kind).toBe(true);
  });

  it("keeps the false-positive rate on the negative fixture table at zero", () => {
    const flagged = NEGATIVE.filter((t) => containsPartnerIdentifier(t));
    expect(flagged).toEqual([]);
  });

  it("documents its known false-positive cost: a six-digit number and an unlabelled run of number groups ARE withheld", () => {
    expect(containsPartnerIdentifier("order 123456 shipped")).toBe(true);
    expect(containsPartnerIdentifier("120 80 76 98")).toBe(true);
  });

  it("is honest about what it does not catch: a name and an indirect identifier pass", () => {
    expect(containsPartnerIdentifier("Mary Johnson in room 214 is out of Eliquis")).toBe(false);
    expect(containsPartnerIdentifier("the lady whose daughter lives in Boise")).toBe(false);
    expect(containsPartnerIdentifier("one two three four five six")).toBe(false);
  });

  it("never throws or returns the text", () => {
    for (const t of ["", " ", "\n", "💊", "x".repeat(10_000), "​".repeat(50)]) {
      expect(() => findPartnerIdentifierKinds(t)).not.toThrow();
    }
    expect(JSON.stringify(findPartnerIdentifierKinds("SSN 123-45-6789"))).not.toContain("123");
  });
});

describe("performance on hostile input (linear, no catastrophic backtracking)", () => {
  const BOUND_MS = 500;
  const timed = (text: string): number => {
    const started = performance.now();
    findPartnerIdentifierKinds(text);
    return performance.now() - started;
  };

  it.each([
    ["8000 of one repeated character", "a".repeat(8000)],
    ["8000 'a' then an @ with no domain", `${"a".repeat(8000)}@`],
    ["many @ signs", "@".repeat(8000)],
    ["alternating a@ pairs", "a@".repeat(4000)],
    ["a long local part and a long dotted domain", `${"a".repeat(4000)}@${"b.".repeat(2000)}`],
    ["8000 spaces", " ".repeat(8000)],
    ["spaced single digits", "1 ".repeat(4000)],
    ["dashed single digits", "1-".repeat(4000)],
    ["8000 digits", "1".repeat(8000)],
    ["street-like words", "12 abc def ghi jkl ".repeat(400)],
    ["8000 zero-width characters", "​".repeat(8000)],
    ["mixed script digits", "١٢".repeat(4000)],
  ])("%s finishes fast", (_name, text) => {
    expect(timed(text)).toBeLessThan(BOUND_MS);
  });
});
