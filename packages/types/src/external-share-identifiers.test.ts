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
  ["DOB is needed", "labelled_identifier"],
  ["D.O.B. unknown", "labelled_identifier"],
  ["DOS 10/22 for the claim", "labelled_identifier"],
  ["account number needed", "labelled_identifier"],
  ["patient id please", "labelled_identifier"],
  ["born 4/12/1950", "date_numeric"],
  ["04-12-50", "date_numeric"],
  ["1950-04-12", "date_iso"],
  ["April 12, 1950", "date_named"],
  ["12 April 1950", "date_named"],
  ["Sept 3rd 1948", "date_named"],
  ["call 555-123-4567", "phone"],
  ["(555) 123-4567", "phone"],
  ["+1 555 123 4567", "phone"],
  ["555.123.4567", "phone"],
  ["send to ann.lee@example.com", "email"],
  ["lives at 123 Main Street", "street_address"],
  ["45 Oak Hill Road", "street_address"],
  ["9 Sunset Blvd.", "street_address"],
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

  it("is honest about what it does not catch: a name and an indirect identifier pass", () => {
    expect(containsPartnerIdentifier("Mary Johnson in room 214 is out of Eliquis")).toBe(false);
    expect(containsPartnerIdentifier("the lady whose daughter lives in Boise")).toBe(false);
  });

  it("never throws or returns the text", () => {
    for (const t of ["", " ", "\n", "💊", "x".repeat(10_000)]) {
      expect(() => findPartnerIdentifierKinds(t)).not.toThrow();
    }
    expect(JSON.stringify(findPartnerIdentifierKinds("SSN 123-45-6789"))).not.toContain("123");
  });
});
