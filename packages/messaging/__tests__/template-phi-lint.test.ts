// M36 WP 2.8 - the "no PHI in saved replies" lint. Deterministic, server-side; these are its corpus. The lint is a
// best-effort identifier screen, NOT a PHI detector: the "known misses" block pins what it deliberately does not catch.
import { describe, expect, it } from "vitest";
import {
  PHI_LINT_VERSION,
  lintTemplateText,
  stripInvisibleCharacters,
} from "../src/templates/phi-lint";
import { PLATFORM_MESSAGE_TEMPLATES } from "../src/templates/template-seed";

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
    // Tranche B hardening: non-ASCII digits, separators between digits, look-alike letters, unspaced labels, bare hosts.
    [
      "Arabic-Indic digits",
      "Account \u0668\u0668\u0667\u0667\u0666\u0666\u0665\u0665",
      "LONG_NUMBER",
    ],
    [
      "Devanagari digits",
      "Account \u096E\u096E\u096D\u096D\u096C\u096C\u096B\u096B",
      "LONG_NUMBER",
    ],
    ["digits split by commas", "Account 8877,6655 is overdue", "LONG_NUMBER"],
    ["digits split by slashes", "Account 88/77/66/55 is overdue", "LONG_NUMBER"],
    ["digits split by mixed separators", "Account 8877 / 66 - 55", "LONG_NUMBER"],
    ["SSN split by commas", "ssn 123,45,6789", "SSN"],
    ["Cyrillic M in the honorific", "Please tell \u041Crs. Alvarez I called", "HONORIFIC_NAME"],
    ["Cyrillic letters in MRN", "\u041CRN: AB12", "IDENTIFIER_LABEL"],
    ["MRN with no separator", "MRN12345 is on file", "IDENTIFIER_LABEL"],
    ["bare domain with a path", "See example.com/p/abc", "URL"],
    ["bare host name", "See portal.example.org", "URL"],
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
  it("still does not catch a bare first name, a diagnosis, a drug or spelled-out digits", () => {
    expect(lintTemplateText("Tell Maria her morphine dose changed")).toEqual([]);
    expect(lintTemplateText("Patient has end stage COPD")).toEqual([]);
    expect(lintTemplateText("one two three four five six seven")).toEqual([]);
  });
});

describe("lintTemplateText: deliberate over-rejection (the price of collapsing separators)", () => {
  // Honest list: ordinary text that the hardened rules refuse. A user rewords it; a PHI leak is the worse error.
  it.each([
    ["a counted list that adds up to six digits", "Steps 1, 2, 3, 4, 5, 6", "LONG_NUMBER"],
    ["a file name that looks like a host", "Send it to notes.net", "URL"],
  ])("%s", (_label, text, code) => {
    expect(lintTemplateText(text)).toContain(code);
  });
});

it("exposes a lint version so a stricter rule set can be rolled out and recorded", () => {
  expect(PHI_LINT_VERSION).toBeGreaterThanOrEqual(1);
});

describe("lintTemplateText: second review round (probe corpus)", () => {
  const rejected: ReadonlyArray<readonly [string, string, string]> = [
    ["non-breaking hyphens between digit groups", "123‑456‑789", "LONG_NUMBER"],
    ["em dashes between digit groups", "Acct 123—456—7890", "LONG_NUMBER"],
    ["minus signs between digit groups", "123−456−789", "LONG_NUMBER"],
    ["underscores between digit groups", "123_456_7890", "LONG_NUMBER"],
    ["Arabic decimal and thousands separators", "123٫456٬789", "LONG_NUMBER"],
    ["combining grapheme joiner inside digits", "12͏34͏5678", "LONG_NUMBER"],
    ["variation selectors inside digits", "12️34️5678", "LONG_NUMBER"],
    ["Mongolian free variation selector inside digits", "12᠋34᠋5678", "LONG_NUMBER"],
    ["Arabic letter mark inside digits", "12؜345678", "LONG_NUMBER"],
    ["tag characters inside digits", "12\u{E0041}34\u{E0041}5678", "LONG_NUMBER"],
    ["zero-width space inside the MRN label", "M​RN 12345", "IDENTIFIER_LABEL"],
    ["combining joiner between MRN and its value", "MRN͏12345", "IDENTIFIER_LABEL"],
    ["fullwidth MRN label", "ＭＲＮ12345", "IDENTIFIER_LABEL"],
    ["MRN joined to its value by an underscore", "mrn_12345", "IDENTIFIER_LABEL"],
    ["MRN joined to its value by a hyphen", "MRN-12345", "IDENTIFIER_LABEL"],
    [
      "a per-day rate that reads as a host and path (documented over-rejection)",
      "Visit 2.5/day",
      "URL",
    ],
  ];
  it.each(rejected)("%s", (_label, text, code) => {
    expect(lintTemplateText(text)).toContain(code);
  });

  it("stripInvisibleCharacters removes every character the lint ignores", () => {
    const noisy = "a͏b️c᠋d\u{E0041}e؜f​g";
    expect(stripInvisibleCharacters(noisy)).toBe("abcdefg");
  });

  it("still misses a spelled-out address, as documented", () => {
    expect(lintTemplateText("write to bob at example dot com")).toEqual([]);
  });

  it("every platform seed template (title, body and required phrases) passes the lint", () => {
    for (const t of PLATFORM_MESSAGE_TEMPLATES) {
      expect(lintTemplateText(t.title), t.templateKey).toEqual([]);
      expect(lintTemplateText(t.body), t.templateKey).toEqual([]);
      for (const phrase of t.requiredPhrases) expect(lintTemplateText(phrase), phrase).toEqual([]);
    }
  });

  it("stays fast on adversarial input at the 2000 character cap (no catastrophic backtracking)", () => {
    for (const text of [
      "a.".repeat(1000),
      "a-".repeat(1000),
      "1 ".repeat(1000),
      `${"a".repeat(1999)}.`,
    ]) {
      const started = performance.now();
      lintTemplateText(text);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
});
