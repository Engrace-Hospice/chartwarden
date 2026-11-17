// The shared patient-identifier screen: what it refuses, and what ordinary operator text it must leave alone.
// Every SSN-shaped value here has area 900 (never issued); the MBI is the synthetic one on compliance/synthetic-identifiers.json
// (the same value the M34 screen's tests use). No real-looking identifier appears anywhere.
import { describe, expect, it } from "vitest";
import {
  VALUE_SCREEN_MAX_CHARS,
  VALUE_SCREEN_MAX_DEPTH,
  VALUE_SCREEN_MAX_STRINGS,
  assertNoPatientIdentifier,
  assertNoPatientIdentifierInValue,
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
    // a bare number near a 3-3-3 value across a sentence break, a line break or more than one separator does not make it part
    // of a longer chain: only ONE separator that is not a line break continues a chain
    ["3-3-3 then a comma and a number", "SSN 900 123 456, 5 days"],
    ["3-3-3 then a full stop and a number", "SSN 900 123 456. 2 follow-ups"],
    ["a date on the line above", "2026-11-09\n900 123 456"],
    ["a date on the line below", "ssn 900 123 456\n2026-11-09"],
    ["a page number and a dash pair", "page 5 -- 900 123 456"],
    ["an amount and a full stop", "Paid 25. 900 123 456"],
    ["a list marker with a bracket", "12) 900 123 456"],
    ["a list marker with a full stop", "1. 900 123 456"],
    ["a carriage return before it", "total 12\r900 123 456"],
    // a separator run longer than ten is collapsed when it is whitespace
    ["eleven spaces", "900           12 3456"],
    ["a long run of mixed whitespace", "900 \t \t \t \t \t \t 12 3456"],
    ["a long whitespace run in 3-3-3", "900             123             456"],
    // digits that NFKD turns into digits without being decimal digits: read as digits, and as separators
    ["subscript separators", "900\u208212\u20823456"],
    ["superscript separators", "900\u00b212\u00b23456"],
    ["superscript digits as the digits", "\u2079\u2070\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076"],
    ["circled digits as separators", "900\u246012\u24603456"],
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
    ["a chain of four 3-digit groups with spaces", "serials 123 456 789 012"],
    ["a number after one separator keeps a chain", "ref 1,234,567,890"],
    ["a phone number with an extension", "reach 555 123 4567 ext 12"],
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

describe("the refusal text", () => {
  it("is static: it tells the operator to cite documents by title or ticket number, says ids and UUIDs can trip it, and never echoes the value", () => {
    const value = "900-12-3456";
    try {
      assertNoPatientIdentifier("evidence", `see ${value}`);
      expect.unreachable("should have refused");
    } catch (err) {
      const { message } = err as { message: string };
      expect(message).toMatch(/cite documents by their title or a ticket number/);
      expect(message).toMatch(/ids and UUIDs can also trip this check/);
      expect(message).not.toContain("900");
      expect(message).not.toContain("3456");
    }
  });
});

describe("a caller-supplied refusal text", () => {
  it("replaces the default in the message and in the detail, and is still a typed 422 for the same code", () => {
    try {
      assertNoPatientIdentifier(
        "displayName",
        "Acme 900-12-3456",
        "displayName is a name, not a record.",
      );
      expect.unreachable("should have refused");
    } catch (err) {
      const e = err as {
        code: string;
        statusCode: number;
        message: string;
        details: Array<{ field: string; message: string }>;
      };
      expect(e.code).toBe("EVIDENCE_LOOKS_LIKE_PHI");
      expect(e.statusCode).toBe(422);
      expect(e.message).toBe("displayName is a name, not a record.");
      expect(e.details).toEqual([
        {
          field: "displayName",
          code: "EVIDENCE_LOOKS_LIKE_PHI",
          message: "displayName is a name, not a record.",
        },
      ]);
    }
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

describe("assertNoPatientIdentifierInValue: a structured value is screened leaf by leaf, within bounds", () => {
  const refused = (value: unknown): { code?: string; statusCode?: number } => {
    try {
      assertNoPatientIdentifierInValue("value", value);
    } catch (err) {
      return err as { code?: string; statusCode?: number };
    }
    return {};
  };

  it("refuses an SSN-shaped string anywhere: top level, nested object, array, or as an object key", () => {
    for (const value of [
      "900-12-3456",
      { note: "call 900 12 3456 back" },
      { a: { b: [{ c: ["fine", "id 900-12-3456"] }] } },
      { "900-12-3456": true },
    ]) {
      expect(refused(value)).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
    }
  });

  it("lets ordinary values through: booleans, numbers, null, plain strings and nested config", () => {
    for (const value of [
      true,
      42,
      null,
      "enabled for the pilot",
      { rollout: [10, 20], label: "beta", on: false },
    ]) {
      expect(refused(value)).toEqual({});
    }
  });

  it("refuses a value that is too deep, has too many strings or is too long, rather than leaving it unscreened", () => {
    let deep: unknown = "x";
    for (let i = 0; i <= VALUE_SCREEN_MAX_DEPTH; i += 1) deep = { next: deep };
    const many = Array.from({ length: VALUE_SCREEN_MAX_STRINGS + 1 }, () => "a");
    const long = ["a".repeat(VALUE_SCREEN_MAX_CHARS + 1)];
    for (const value of [deep, many, long]) {
      expect(refused(value)).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
    }
  });

  it("the bound is generous enough for real configuration", () => {
    let nested: unknown = "leaf";
    for (let i = 0; i < VALUE_SCREEN_MAX_DEPTH - 1; i += 1) nested = { next: nested };
    expect(refused(nested)).toEqual({});
  });
});

// The screen drops combining marks and format characters before it judges, and it drops them BEFORE the NFKD as well as after:
// NFKD reorders a run of marks by combining class (quadratic in the run), so a string of marks in descending class order held the
// event loop for seconds although the marks are discarded anyway. The output must not change, and the work must stay linear.
describe("marks and format characters, before and after the NFKD", () => {
  const MARKS = ["ͅ", "̕", "̀", "̖", "̛", "̡", "ّ", "ً", "ְ", "̴"];
  /** `a` followed by many marks of each class, in descending class order: the worst case for the canonical reordering. */
  const markRun = (units: number, perMark = 99): string =>
    `a${MARKS.map((m) => m.repeat(perMark)).join("")}`.slice(0, units);

  it.each([
    ["a combining acute after each digit", "9́0́0́1́2́3́4́5́6́"],
    [
      "a run of descending-class marks after each digit",
      `9${markRun(40).slice(1)}0${markRun(40).slice(1)}0${markRun(40).slice(1)}-12-3456`,
    ],
    ["marks between the groups", "900ͅ-̕12̀-̖3456"],
    ["a zero-width joiner and marks together", "900‍́-12​́-3456"],
    ["Arabic-Indic digits with marks", "٩٠٠ً-١٢ً-٣٤٥٦"],
    ["full-width digits with marks", "９００́-１２-３４５６"],
    ["superscript separators with marks", "900́²12́²3456"],
  ])("still refuses an SSN with %s", (_label, text) => {
    expect(looksLikeSsn(text)).toBe(true);
    expect(looksLikePatientIdentifier(text)).toBe(true);
  });

  it("still refuses an MBI with marks and zero-width characters between its characters", () => {
    expect(looksLikeMbi("1́E​Ǵ4TE5ͅMK‍73")).toBe(true);
  });

  it("leaves ordinary text with marks alone", () => {
    expect(looksLikePatientIdentifier("café résumé näive 12 of 45")).toBe(false);
    expect(looksLikePatientIdentifier(markRun(2000))).toBe(false);
  });

  it("a 20,000-unit string of marks in descending class order is screened in well under a second (it took 2.6 s)", () => {
    const text = markRun(20_000, 2000);
    const started = performance.now();

    const verdict = looksLikePatientIdentifier(text);
    expect(() => assertNoPatientIdentifier("note", text)).not.toThrow();

    expect(verdict).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

// The marks-first `normalise` against the function it replaced. The old function is kept here, inline (the regexes are unchanged;
// only `normalise` differs: git show 831349919:packages/shared/src/text/patient-identifier.ts), so that "the verdicts are the same"
// stays something a test proves rather than a comment claims. `normalise` itself is not exported, so the equality is asserted on
// the verdicts the module gives, which are the only thing a caller sees.
describe("the marks-first normalise gives the verdicts the previous function gave", () => {
  const ND = "\\p{Nd}";
  const SEP = "[^\\p{L}\\p{N}]";
  const SEP_NOT_LINE = "[^\\p{L}\\p{N}\\r\\n]";
  const GAP = `${SEP}{0,10}`;
  const GAP1 = `${SEP}{1,10}`;
  const SSN_GROUPED = new RegExp(`(?<!${ND})${ND}{3}${GAP}${ND}{2}${GAP}${ND}{4}(?!${ND})`, "u");
  const SSN_THREES = new RegExp(
    `(?<!${ND}${SEP_NOT_LINE}?)${ND}{3}${GAP1}${ND}{3}${GAP1}${ND}{3}(?!${SEP_NOT_LINE}?${ND})`,
    "u",
  );
  const SSN_SPACED = new RegExp(`(?<!${ND})${ND}(?:${GAP1}${ND}){8}(?!${ND})`, "u");
  const MBI_LETTER = "[AC-HJKMNP-RT-Y]";
  const MBI_LETTER_OR_DIGIT = "[AC-HJKMNP-RT-Y0-9]";
  const MBI_WINDOW = new RegExp(
    `[1-9]${MBI_LETTER}${MBI_LETTER_OR_DIGIT}[0-9]${MBI_LETTER}${MBI_LETTER_OR_DIGIT}[0-9]${MBI_LETTER}${MBI_LETTER}[0-9]{2}`,
    "i",
  );
  const OTHER_NUMBER = /\p{No}/gu;
  const oldNormalise = (text: string): string =>
    text
      .normalize("NFKD")
      .replace(/[\p{M}\p{Cf}]/gu, "")
      .replace(/[^\S\r\n]+/gu, " ");
  const oldLooksLikeSsn = (text: string): boolean =>
    [oldNormalise(text), oldNormalise(text.replace(OTHER_NUMBER, " "))].some(
      (folded) => SSN_GROUPED.test(folded) || SSN_THREES.test(folded) || SSN_SPACED.test(folded),
    );
  const oldLooksLikeMbi = (text: string): boolean =>
    MBI_WINDOW.test(oldNormalise(text).replace(/[^A-Za-z0-9]/g, ""));

  const codePoints = (from: number, count: number): string[] =>
    Array.from({ length: count }, (_, i) => String.fromCodePoint(from + i));
  // a digit of nine scripts: ASCII, full-width, Arabic-Indic (two sets), Devanagari, math bold, and superscripts
  const DIGITS: string[][] = [
    codePoints(0x30, 10),
    codePoints(0xff10, 10),
    codePoints(0x660, 10),
    codePoints(0x6f0, 10),
    codePoints(0x966, 10),
    codePoints(0x1d7ce, 10),
    Array.from("⁰¹²³⁴⁵⁶⁷⁸⁹"),
  ];
  // a letter of the MBI window: ASCII, full-width, math bold, and a lower-case form
  const letterForms = (letter: string): string[] => {
    const offset = letter.charCodeAt(0) - 0x41;
    return [
      letter,
      letter.toLowerCase(),
      String.fromCodePoint(0xff21 + offset),
      String.fromCodePoint(0x1d400 + offset),
    ];
  };
  // combining marks in DESCENDING class order (the worst case for the reordering), plus single marks of other kinds
  const MARKS = ["ͅ", "̴", "̖", "̛", "́", "̀", "⃐", "゙"];
  // what sits between two characters: separators, marks, zero-width and bidi format characters, or nothing
  const PADS = [
    "",
    "",
    " ",
    "-",
    "/",
    ".",
    "|",
    "́",
    "ͅ",
    "̴",
    "⃐",
    "゙",
    "️",
    "​",
    "‌",
    "‍",
    "⁠",
    "﻿",
    "‮",
    "̴́ͅ",
    " ́-",
    "­",
    " ",
    "´",
    "¨",
    "˘",
    "¯",
  ];
  // text around a value: ordinary words, ligatures, Hangul, astral, precomposed and compatibility characters
  const NOISE = [
    "ticket ",
    "ﬁ",
    "가각힣",
    "😀",
    "𝐀",
    "Å",
    "é",
    "ǆ",
    "ﷺ",
    "㎏",
    "x",
    "12",
    " of ",
    "\n",
    "ẛ̣",
    "⒈",
    "´5",
    "5´",
    "¨7",
    " 4",
    "9 ",
  ];

  let state = 987654321;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const pickFrom = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const pad = (): string => {
    if (next() < 0.15) {
      const run = Math.floor(next() * 30);
      return Array.from({ length: run }, (_, i) => MARKS[i % MARKS.length]).join("");
    }
    return pickFrom(PADS);
  };
  const around = (core: string): string =>
    `${next() < 0.5 ? "" : pickFrom(NOISE)}${core}${next() < 0.5 ? "" : pickFrom(NOISE)}`;
  /** A value's characters with padding between them, grouped like an SSN (3-2-4 or 3-3-3, or digit by digit). */
  const ssnSkeleton = (): string => {
    const digits = pickFrom(DIGITS);
    const text = Array.from({ length: 9 }, (_, i) => (i === 0 ? "9" : String(i % 10)));
    const rendered = text.map((d) => (d === "9" && next() < 0.5 ? "9" : (digits[Number(d)] ?? d)));
    const shape = pickFrom([[3, 2, 4], [3, 3, 3], [1, 1, 1, 1, 1, 1, 1, 1, 1], [9]]);
    let at = 0;
    return around(
      shape
        .map((size) => {
          const group = rendered.slice(at, at + size).join(pad());
          at += size;
          return group;
        })
        .join(pad() + pickFrom(["-", " ", "/", ".", "", "–"]) + pad()),
    );
  };
  const mbiSkeleton = (): string => {
    const digit = () => pickFrom(pickFrom(DIGITS.slice(0, 2)));
    const letter = (l: string) => pickFrom(letterForms(l));
    const characters = [
      digit(),
      letter("E"),
      letter("G"),
      digit(),
      letter("T"),
      letter("E"),
      digit(),
      letter("M"),
      letter("K"),
      digit(),
      digit(),
    ];
    return around(characters.map((c) => `${c}${pad()}`).join(""));
  };
  const mixedSkeleton = (): string =>
    [ssnSkeleton(), mbiSkeleton(), around(pickFrom(NOISE)), ssnSkeleton()]
      .slice(0, 1 + Math.floor(next() * 4))
      .join(pickFrom([" ", "\n", ", ", ""]));

  it("agrees with the previous function on 4,500 well-formed strings (SSN and MBI skeletons, padded with marks and zero-width characters)", () => {
    const strings = [
      ...Array.from({ length: 1500 }, ssnSkeleton),
      ...Array.from({ length: 1500 }, mbiSkeleton),
      ...Array.from({ length: 1500 }, mixedSkeleton),
    ];
    let ssnHits = 0;
    let mbiHits = 0;

    for (const text of strings) {
      const label = JSON.stringify(text);
      expect(looksLikeSsn(text), `SSN verdict of ${label}`).toBe(oldLooksLikeSsn(text));
      expect(looksLikeMbi(text), `MBI verdict of ${label}`).toBe(oldLooksLikeMbi(text));
      expect(looksLikePatientIdentifier(text), `verdict of ${label}`).toBe(
        oldLooksLikeSsn(text) || oldLooksLikeMbi(text),
      );
      if (looksLikeSsn(text)) ssnHits += 1;
      if (looksLikeMbi(text)) mbiHits += 1;
    }

    // not vacuous: plenty of strings of each kind are refused, and plenty are not
    expect(ssnHits).toBeGreaterThan(500);
    expect(mbiHits).toBeGreaterThan(300);
    expect(strings.length - ssnHits).toBeGreaterThan(500);
    expect(strings.length - mbiHits).toBeGreaterThan(500);
  });

  // The ONE difference: an ILL-FORMED string, a lone high surrogate and a lone low surrogate with only marks between them. The
  // first drop joins the halves before the NFKD, so the pair is decomposed as the character it spells (here a letter that folds to
  // ASCII), where the previous function joined them after the NFKD. Not an evasion: the character typed whole gives the new verdict.
  it("differs only for a split surrogate pair with marks between the halves: the documented difference", () => {
    const mbi = "1EG4\ud801́\udfa5TE5\ud801́\udfa5MK73";
    const ssn = "900\ud833́\udcd612\ud833́\udcd63456";
    const mbiWhole = "1EG4\u{107a5}TE5\u{107a5}MK73";
    const ssnWhole = "900\u{1ccd6}12\u{1ccd6}3456";

    expect([oldLooksLikeMbi(mbi), looksLikeMbi(mbi)]).toEqual([true, false]);
    expect([oldLooksLikeSsn(ssn), looksLikeSsn(ssn)]).toEqual([true, false]);
    // the same characters typed whole: the new verdict for the split pair is the verdict for the whole one
    expect(looksLikeMbi(mbi)).toBe(looksLikeMbi(mbiWhole));
    expect(looksLikeSsn(ssn)).toBe(looksLikeSsn(ssnWhole));
  });
});
