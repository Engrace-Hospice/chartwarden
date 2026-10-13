// M36 WP 2.8 - the "no PHI in saved replies" lint. Deterministic, server-side; these are its corpus. The lint is a
// best-effort identifier screen, NOT a PHI detector: the "known misses" block pins what it deliberately does not catch.
import { describe, expect, it } from "vitest";
import { PHI_LINT_VERSION, lintTemplateText } from "../src/templates/phi-lint";

describe("lintTemplateText: rejects direct identifiers", () => {
  const rejected: ReadonlyArray<readonly [string, string, string]> = [
    ["SSN with dashes", "Her SSN is 123-45-6789 on file", "SSN"],
    ["SSN with spaces", "ssn 123 45 6789", "SSN"],
    ["US phone", "Call 415-555-0134 today", "PHONE"],
    ["US phone with parens", "Call (415) 555-0134 today", "PHONE"],
    ["phone with country code", "Call +1 415 555 0134", "PHONE"],
    ["email", "Write to jane.doe+hospice@example.com", "EMAIL"],
    ["slash date", "Visit on 03/14/2026", "DATE"],
    ["iso date", "Visit on 2026-03-14", "DATE"],
    ["written date", "Visit on March 14, 2026", "DATE"],
    ["written date, day first", "Visit on 14 March 2026", "DATE"],
    ["long digit run", "Account 88776655 is overdue", "LONG_NUMBER"],
    ["digit run split by spaces", "Account 8877 6655 is overdue", "LONG_NUMBER"],
    ["fullwidth digits", "Account ８８７７６６５５", "LONG_NUMBER"],
    ["zero-width characters inside digits", "Account 88​77​66​55", "LONG_NUMBER"],
    ["MRN label with value", "MRN: AB12", "IDENTIFIER_LABEL"],
    ["DOB label with value", "DOB 1/2/45", "IDENTIFIER_LABEL"],
    ["member id label", "member id # 77", "IDENTIFIER_LABEL"],
    ["Medicare beneficiary identifier", "MBI 1EG4-TE5-MK73", "MBI"],
    ["url", "See https://portal.example.org/p/12", "URL"],
    ["bare www url", "See www.example.org/chart", "URL"],
    ["ipv4", "Server 10.20.30.40", "IP_ADDRESS"],
    ["street address", "Deliver to 221 Baker Street", "STREET_ADDRESS"],
    ["honorific plus name", "Please tell Mrs. Alvarez I called", "HONORIFIC_NAME"],
    ["honorific plus name without a dot", "Please tell Mr Nguyen I called", "HONORIFIC_NAME"],
    ["merge placeholder", "Hello {{patient_name}}", "PLACEHOLDER"],
  ];
  it.each(rejected)("%s", (_label, text, code) => {
    expect(lintTemplateText(text)).toContain(code);
  });

  it("reports every distinct code once, sorted", () => {
    const codes = lintTemplateText("123-45-6789 and 415-555-0134 and a@b.co and 415-555-0134");
    expect(codes).toEqual([...new Set(codes)].sort());
    expect(codes).toEqual(expect.arrayContaining(["EMAIL", "PHONE", "SSN"]));
  });

  it("never returns the matched text", () => {
    for (const code of lintTemplateText("123-45-6789 jane@x.org")) {
      expect(code).not.toMatch(/\d{3}-|@/);
    }
  });
});

describe("lintTemplateText: accepts ordinary non-clinical replies", () => {
  const accepted: readonly string[] = [
    "Thanks, message received. I will follow up shortly.",
    "I am running a little behind and will arrive later than planned.",
    "If this is an emergency, call 911. For urgent needs, contact the on-call line.",
    "Can we move this visit to a different time? Reply with a time that works for you.",
    "Please complete your documentation by end of day - 2 items remain.",
    "The supply delivery arrives in 3 to 5 days.",
    "Dr. on call will review this today.",
    "Visit window is 9am - 11am; I will confirm within 30 minutes.",
    "Reference [time] and [reason] before sending.",
    "Order of 12 units is queued.",
  ];
  it.each(accepted)("%s", (text) => {
    expect(lintTemplateText(text)).toEqual([]);
  });
});

describe("lintTemplateText: known misses (documented limits, not guarantees)", () => {
  it("does not catch a bare first name, a diagnosis, a drug or spelled-out digits", () => {
    expect(lintTemplateText("Tell Maria her morphine dose changed")).toEqual([]);
    expect(lintTemplateText("Patient has end stage COPD")).toEqual([]);
    expect(lintTemplateText("one two three four five six seven")).toEqual([]);
  });
});

it("exposes a lint version so a stricter rule set can be rolled out and recorded", () => {
  expect(PHI_LINT_VERSION).toBeGreaterThanOrEqual(1);
});
