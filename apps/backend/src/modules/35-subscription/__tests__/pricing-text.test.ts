// Slice 2 (tenant pricing) — the screen every operator-typed pricing field passes through (reason, order-form reference, a plan's name and
// description): control characters, NUL, length bounds, and SSN / MBI-shaped text. The identifiers come from the repo's synthetic list
// (compliance/synthetic-identifiers.json), never from a real record.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  REASON_MAX,
  REASON_MIN,
  normalizeOptionalRef,
  normalizeReason,
  normalizeRequiredText,
} from "../pricing/text";

const synthetic = JSON.parse(
  readFileSync(join(__dirname, "../../../../../../compliance/synthetic-identifiers.json"), "utf8"),
) as { ssn: string[]; mbi: string[] };

const caught = (fn: () => unknown): ChartWardenError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ChartWardenError) return error;
    throw error;
  }
  throw new Error("expected the screen to refuse, but it accepted");
};

/** The screen refuses with a 422 whose message and details never contain the value. */
function expectRefusedWithoutEcho(fn: () => unknown, value: string, code: string): void {
  const error = caught(fn);
  expect(error.statusCode).toBe(422);
  expect(error.code).toBe(code);
  expect(JSON.stringify([error.message, error.details])).not.toContain(value);
}

describe("the synthetic identifier list is what these tests run on", () => {
  it("has SSNs and MBIs to try", () => {
    expect(synthetic.ssn.length).toBeGreaterThan(5);
    expect(synthetic.mbi.length).toBeGreaterThan(5);
  });
});

describe("normalizeReason refuses a patient identifier", () => {
  it("refuses every synthetic SSN as written, space-, dot- and un-separated, inside a sentence, without echoing it", () => {
    for (const ssn of synthetic.ssn) {
      const [a, b, c] = ssn.split("-") as [string, string, string];
      for (const written of [ssn, `${a} ${b} ${c}`, `${a}.${b}.${c}`, `${a}${b}${c}`]) {
        expectRefusedWithoutEcho(
          () => normalizeReason(`the customer read out ${written} on the call`),
          written,
          "REASON_LOOKS_LIKE_PHI",
        );
      }
    }
  });

  it("refuses every synthetic MBI as written, lower case, dashed, spaced and with a zero-width space inside", () => {
    for (const mbi of synthetic.mbi) {
      const dashed = `${mbi.slice(0, 4)}-${mbi.slice(4, 7)}-${mbi.slice(7)}`;
      const spaced = `${mbi.slice(0, 4)} ${mbi.slice(4, 7)} ${mbi.slice(7)}`;
      const zeroWidth = `${mbi.slice(0, 5)}​${mbi.slice(5)}`;
      for (const written of [mbi, mbi.toLowerCase(), dashed, spaced, zeroWidth]) {
        expectRefusedWithoutEcho(
          () => normalizeReason(`beneficiary ${written} was discussed`),
          written,
          "REASON_LOOKS_LIKE_PHI",
        );
      }
    }
  });

  it("refuses a full-width (NFKD-foldable) SSN", () => {
    expect(() => normalizeReason("customer said １２３－４５－６７８９ aloud")).toThrow(
      /patient identifier/,
    );
  });

  it("accepts text that merely resembles one: an 8-digit or 10-digit run, an MBI with a letter the CMS never issues", () => {
    expect(normalizeReason("ticket 12345678 resolved by phone")).toBe(
      "ticket 12345678 resolved by phone",
    );
    expect(normalizeReason("order form 1234567890 signed")).toBe("order form 1234567890 signed");
    // S is a letter an MBI never uses
    expect(normalizeReason("reference 1SG4TE5MK72 on file")).toBe("reference 1SG4TE5MK72 on file");
  });
});

describe("normalizeReason: NUL, control characters and length", () => {
  it("refuses NUL (Postgres text cannot hold it), without a partial acceptance", () => {
    expectRefusedWithoutEcho(
      () => normalizeReason("signed order\u0000 form for the customer"),
      "signed order\u0000 form",
      "REASON_INVALID",
    );
  });

  it("strips other control characters before it measures the length", () => {
    expect(normalizeReason("signed\u0007 order\u001b form")).toBe("signed order form");
    // seven visible characters once the control character is gone: too short
    expect(caught(() => normalizeReason("a\u0007bcdefg")).code).toBe("REASON_REQUIRED");
  });

  it("accepts exactly the minimum and the maximum, refuses one short and one over", () => {
    expect(normalizeReason("x".repeat(REASON_MIN))).toHaveLength(REASON_MIN);
    expect(normalizeReason("x".repeat(REASON_MAX))).toHaveLength(REASON_MAX);
    expect(caught(() => normalizeReason("x".repeat(REASON_MIN - 1))).code).toBe("REASON_REQUIRED");
    expect(caught(() => normalizeReason("x".repeat(REASON_MAX + 1))).code).toBe("REASON_REQUIRED");
  });

  it("collapses whitespace and trims, and measures what is left", () => {
    expect(normalizeReason("   a   b   c   d   e   f   ")).toBe("a b c d e f");
    expect(caught(() => normalizeReason("      a b c       ")).code).toBe("REASON_REQUIRED");
  });

  it("a non-string is not a reason", () => {
    for (const bad of [undefined, null, 42, {}, ["a reason of enough length"]]) {
      expect(caught(() => normalizeReason(bad)).code).toBe("REASON_REQUIRED");
    }
  });
});

describe("normalizeOptionalRef and normalizeRequiredText (order-form reference, plan name and description)", () => {
  it("refuses a synthetic SSN or MBI in an order-form reference, a plan name or a description, naming the field and not echoing the value", () => {
    const ssn = synthetic.ssn[0] as string;
    const mbi = synthetic.mbi[0] as string;
    for (const [field, call] of [
      ["orderFormRef", (v: string) => normalizeOptionalRef("orderFormRef", v, 500)],
      ["description", (v: string) => normalizeOptionalRef("description", v, 1000)],
      ["name", (v: string) => normalizeRequiredText("name", v, 120)],
    ] as const) {
      for (const value of [`OF ${ssn}`, `plan ${mbi}`]) {
        const error = caught(() => call(value));
        expect(error.statusCode, field).toBe(422);
        expect(error.details, field).toEqual([expect.objectContaining({ field })]);
        expect(JSON.stringify([error.message, error.details])).not.toContain(value);
      }
    }
  });

  it("refuses NUL and text over the bound; blank is null for an optional field and an error for a required one", () => {
    expect(caught(() => normalizeOptionalRef("orderFormRef", "OF\u00002026", 500)).code).toBe(
      "REF_INVALID",
    );
    expect(caught(() => normalizeOptionalRef("orderFormRef", "x".repeat(11), 10)).code).toBe(
      "REF_INVALID",
    );
    expect(normalizeOptionalRef("orderFormRef", "x".repeat(10), 10)).toBe("x".repeat(10));
    expect(normalizeOptionalRef("description", "   ", 1000)).toBeNull();
    expect(normalizeOptionalRef("description", null, 1000)).toBeNull();
    expect(caught(() => normalizeRequiredText("name", "   ", 120)).code).toBe("TEXT_REQUIRED");
    expect(caught(() => normalizeRequiredText("name", undefined, 120)).code).toBe("TEXT_REQUIRED");
    expect(normalizeRequiredText("name", "  Hospice   standard ", 120)).toBe("Hospice standard");
  });
});
