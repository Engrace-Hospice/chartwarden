import { describe, expect, it } from "vitest";
import {
  HopeInvalidAnswerValueError,
  normalizeHopeAnswerValue,
} from "../src/modules/10-hope/hope-answer-service";

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
});
