// The shared patient-identifier screen: what it refuses, and what ordinary operator text it must leave alone.
// Every SSN-shaped value here has area 900 (never issued); the MBI is the synthetic one on compliance/synthetic-identifiers.json
// (the same value the M34 screen's tests use). No real-looking identifier appears anywhere.
import { describe, expect, it } from "vitest";
import {
  assertNoPatientIdentifier,
  looksLikeMbi,
  looksLikePatientIdentifier,
  looksLikeSsn,
} from "../src/text/patient-identifier";

describe("looksLikeSsn: separators the first rule missed", () => {
  it.each([
    ["dashed", "900-12-3456"],
    ["spaced", "900 12 3456"],
    ["spaces around dashes", "900 - 12 - 3456"],
    ["two spaces", "900  12  3456"],
    ["en dash", "900\u201312\u20133456"],
    ["non-breaking hyphen U+2011", "900\u201112\u20113456"],
    ["slash", "900/12/3456"],
    ["underscore", "900_12_3456"],
    ["dots", "900.12.3456"],
    ["mixed separators", "900 / 12 _ 3456"],
    ["no separator", "id 900123456 on the form"],
    ["digit by digit, spaces", "9 0 0 1 2 3 4 5 6"],
    ["digit by digit, dashes", "9-0-0-1-2-3-4-5-6"],
    ["digit by digit, double spaces", "9  0  0  1  2  3  4  5  6"],
    ["full-width digits", "９００-１２-３４５６"],
    ["zero-width padding", "900\u200b-12\u200b-3456"],
    ["bidi override padding", "900\u202e 12\u202e 3456"],
    ["inside a sentence", "the customer read out 900 - 12 - 3456 over the phone"],
    // symbols and every other non-letter, non-number character between the groups
    ["pipes in a table cell", "| 900 | 12 | 3456 |"],
    ["pipes", "900|12|3456"],
    ["plus", "900+12+3456"],
    ["equals", "900=12=3456"],
    ["tilde", "900~12~3456"],
    ["dollar", "900$12$3456"],
    ["caret", "900^12^3456"],
    ["tabs", "900\t12\t3456"],
    ["newlines", "900\n12\n3456"],
    ["a control character", "900\u000012\u00003456"],
    ["a long run of separators", "900 --- - 12 - 3456"],
    ["emoji separators", "900\u{1F600}12\u{1F600}3456"],
    // nine digits grouped in threes, standing alone
    ["3-3-3 spaces", "900 123 456"],
    ["3-3-3 dashes", "900-123-456"],
    ["3-3-3 in a sentence", "the number was 900 123 456, confirmed"],
    // digits of another script (Arabic-Indic): they are not folded by NFKD
    ["Arabic-Indic digits", "\u0669\u0660\u0660-\u0661\u0662-\u0663\u0664\u0665\u0666"],
    [
      "Arabic-Indic digits, spaced",
      "\u0669 \u0660 \u0660 \u0661 \u0662 \u0663 \u0664 \u0665 \u0666",
    ],
  ])("flags %s", (_label, text) => {
    expect(looksLikeSsn(text)).toBe(true);
    expect(looksLikePatientIdentifier(text)).toBe(true);
  });

  it.each([
    ["an ISO date", "confirmed on 2026-11-09 by phone"],
    ["a US date", "signed 11/09/2026"],
    ["a date range", "term 2026-11-09 - 2027-11-08"],
    ["a timestamp", "logged at 2026-11-09T12:30:45Z"],
    ["an amount with cents", "refund of $1,234,567.89 approved"],
    ["a large amount with a longer chain of groups", "volume 1,234,567,890 units"],
    ["a dotted four-group address", "from 192.168.001.020"],
    ["a thirteen digit run", "ref 9001234567890"],
    ["a dashed phone number", "call 555-123-4567"],
    ["a parenthesised phone number", "reached them on (555) 123-4567"],
    ["a spaced phone number with country code", "+1 555 123 4567"],
    ["a ten digit number", "ticket 1234567890"],
    ["a short number", "two locations, 12 users"],
    ["a version", "build 2.10.15"],
    ["a document reference", "signed order form on file, DOC-1042"],
    ["a list of small numbers", "counts 1 2 3 4 5 6 7 8"],
    ["digits split by letters", "ticket 123 of 45 and 6789"],
    ["an IP address", "from 192.168.1.20"],
    ["empty", ""],
  ])("does not flag %s", (_label, text) => {
    expect(looksLikeSsn(text)).toBe(false);
  });
});

// The screen errs toward refusing. These are NOT patient identifiers but are refused on purpose (documented in the file header):
// the operator cites the ticket or document by name instead.
describe("known false positives (refused on purpose)", () => {
  it.each([
    ["a ZIP+4", "office at 78701-1234"],
    ["a nine-digit number with a decimal point", "rate 12345.6789"],
    ["a dotted version shaped 3.2.4", "build 100.10.1000"],
    ["nine single digits in a list", "steps 1, 2, 3, 4, 5, 6, 7, 8, 9"],
    ["a standalone number grouped in threes", "volume 123,456,789 units"],
    ["a nine-digit ticket number", "ticket 123456789"],
  ])("refuses %s", (_label, text) => {
    expect(looksLikeSsn(text)).toBe(true);
  });
});

describe("looksLikeMbi", () => {
  it.each(["beneficiary 1EG4TE5MK73", "beneficiary 1EG4-TE5-MK73", "beneficiary 1eg4 te5 mk73"])(
    "flags %s",
    (text) => {
      expect(looksLikeMbi(text)).toBe(true);
    },
  );
  it("does not flag ordinary words", () => {
    expect(looksLikeMbi("NPPES record matches the legal name")).toBe(false);
  });
});

describe("assertNoPatientIdentifier", () => {
  it("throws the typed 422 for every separator form, never echoing the value", () => {
    for (const text of [
      "900 - 12 - 3456",
      "900\u201312\u20133456",
      "9 0 0 1 2 3 4 5 6",
      "900\u200b-12\u200b-3456",
    ]) {
      try {
        assertNoPatientIdentifier("evidence", text);
        expect.unreachable(`should have refused ${JSON.stringify(text)}`);
      } catch (err) {
        const e = err as { code: string; statusCode: number; message: string; details: unknown };
        expect(e.code).toBe("EVIDENCE_LOOKS_LIKE_PHI");
        expect(e.statusCode).toBe(422);
        expect(e.message).not.toContain("900");
        expect(JSON.stringify(e.details)).not.toContain("3456");
      }
    }
  });

  it("lets ordinary operator text through", () => {
    for (const text of [
      "NPPES record matches the legal name; CCN contact called back",
      "granted for the pilot, ticket DOC-1042, review on 2026-11-09",
      "refund of $1,234,567.89 approved",
    ]) {
      expect(() => assertNoPatientIdentifier("reason", text)).not.toThrow();
    }
  });
});
