import { describe, expect, it } from "vitest";
import {
  HopeInvalidAnswerValueError,
  normalizeHopeAnswerValue,
} from "../src/modules/10-hope/hope-answer-service";
import { PatchAnswersSchema, parse } from "../src/modules/10-hope/routes/hope-typebox";

function item(overrides: Record<string, unknown>) {
  return {
    itemCode: "A0700",
    cmsItemTypeCode: "Text",
    fixedRecordLength: null,
    ...overrides,
  } as never;
}

function option(valueCode: string) {
  return { valueCode } as never;
}

describe("normalizeHopeAnswerValue", () => {
  it("accepts A0700 Medicaid-number text and CMS special values as text, not dates", () => {
    const a0700 = item({ itemCode: "A0700", cmsItemTypeCode: "Text", fixedRecordLength: 14 });
    const options = [option("Text"), option("+"), option("N"), option("^")];

    expect(normalizeHopeAnswerValue({ item: a0700, options, inputValue: "+" })).toBe("+");
    expect(normalizeHopeAnswerValue({ item: a0700, options, inputValue: "N" })).toBe("N");
    expect(normalizeHopeAnswerValue({ item: a0700, options, inputValue: "Text" })).toBe("Text");
    expect(normalizeHopeAnswerValue({ item: a0700, options, inputValue: "MDCD123456" })).toBe(
      "MDCD123456",
    );
    expect(() =>
      normalizeHopeAnswerValue({ item: a0700, options, inputValue: "123456789012345" }),
    ).toThrow(HopeInvalidAnswerValueError);
  });

  it("still rejects non-ISO values for items with a CMS date placeholder", () => {
    const z0350 = item({ itemCode: "Z0350", cmsItemTypeCode: "Date" });
    const options = [option("YYYYMMDD")];

    expect(() =>
      normalizeHopeAnswerValue({ item: z0350, options, inputValue: "09/09/2026" }),
    ).toThrow(HopeInvalidAnswerValueError);
    expect(normalizeHopeAnswerValue({ item: z0350, options, inputValue: "2026-09-09" })).toBe(
      "2026-09-09",
    );
    expect(normalizeHopeAnswerValue({ item: z0350, options, inputValue: "20260909" })).toBe(
      "2026-09-09",
    );
    expect(normalizeHopeAnswerValue({ item: z0350, options, inputValue: "YYYYMMDD" })).toBe(
      "YYYYMMDD",
    );
  });

  describe("date items accept only real calendar dates", () => {
    const z0350 = item({ itemCode: "Z0350", cmsItemTypeCode: "Date" });
    const options = [option("YYYYMMDD")];
    const normalize = (inputValue: unknown) =>
      normalizeHopeAnswerValue({ item: z0350, options, inputValue });

    it.each([
      ["a Feb 30 in dashed form", "2026-02-30"],
      ["a Feb 30 in compact form", "20260230"],
      ["month 13", "2026-13-01"],
      ["day 00", "2026-06-00"],
      ["Apr 31", "2026-04-31"],
      ["a Feb 29 in a non-leap year", "2026-02-29"],
      ["a Feb 29 in a century that is not a leap year", "1900-02-29"],
    ])("refuses %s (%s)", (_label, value) => {
      expect(() => normalize(value)).toThrow(HopeInvalidAnswerValueError);
    });

    it.each([
      ["a valid leap day", "2028-02-29", "2028-02-29"],
      ["a leap day in a 400-year century", "2000-02-29", "2000-02-29"],
      ["the last day of a 31-day month", "2026-01-31", "2026-01-31"],
      ["a compact valid leap day", "20280229", "2028-02-29"],
    ])("accepts %s", (_label, value, expected) => {
      expect(normalize(value)).toBe(expected);
    });
  });
});

describe("a refused coded answer never echoes what the caller sent", () => {
  // The 422 envelope is replayed from the idempotency cache for 24 hours: a clinician's pasted note must not be in it.
  it("names the item code, not the value", () => {
    const a1400a = item({ itemCode: "A1400A", cmsItemTypeCode: "Code" });
    const note = "pt reports chest pain at 3am, wife Jane at bedside";

    const refusal = (() => {
      try {
        normalizeHopeAnswerValue({
          item: a1400a,
          options: [option("0"), option("1")],
          inputValue: note,
        });
      } catch (error) {
        return error as HopeInvalidAnswerValueError;
      }
      throw new Error("expected a refusal");
    })();

    expect(refusal).toBeInstanceOf(HopeInvalidAnswerValueError);
    expect(JSON.stringify(refusal)).not.toContain("chest pain");
    expect(refusal.message).not.toContain("chest pain");
    expect(JSON.stringify((refusal as { details?: unknown }).details)).toContain("A1400A");
    expect(JSON.stringify((refusal as { details?: unknown }).details)).not.toContain("Jane");
  });
});

describe("PatchAnswersSchema bounds a string answer", () => {
  const patch = (value: unknown) => ({
    ifVersion: 1,
    changes: [{ itemCode: "A0500C", action: "set", value }],
  });

  it("accepts the longest legitimate text item (A0500C, 18 characters) and the 64-character cap", () => {
    expect(() => parse(PatchAnswersSchema, patch("x".repeat(18)))).not.toThrow();
    expect(() => parse(PatchAnswersSchema, patch("x".repeat(64)))).not.toThrow();
  });

  it("refuses a longer string, without echoing it", () => {
    const pasted = "free text that should never be a coded answer ".repeat(5);

    let failure: unknown;
    try {
      parse(PatchAnswersSchema, patch(pasted));
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ statusCode: 422 });
    expect(JSON.stringify(failure)).not.toContain("free text");
  });
});
