import { describe, expect, it } from "vitest";
import { Hets270BuildError, type Hets270Request, MBI_PATTERN, build270 } from "./build-270";
import { tokenizeInterchange } from "./x12-envelope";

// Synthetic MBI in the CMS format (the Companion Guide's own example value).
const MBI = "1EG4TE5MK73";

const base: Hets270Request = {
  submitterId: "A123456",
  provider: { npi: "1234567893", organizationName: "Engrace Hospice, LLC" },
  subscriber: {
    mbi: MBI,
    lastName: "O'Connor-Smith",
    firstName: "José",
    dateOfBirth: "1940-04-01",
  },
  serviceDates: { from: "2026-10-01", to: "2026-10-06" },
  controlNumber: 5014,
  traceNumber: "chk-0001",
  usage: "T",
  now: new Date("2026-10-06T07:34:11Z"),
};

describe("build270", () => {
  it("builds the Companion Guide Appendix A shape with STC 30 + 45", () => {
    const x12 = build270(base);
    const { segments, delimiters } = tokenizeInterchange(x12);
    expect(delimiters).toEqual({ element: "*", component: "|", repetition: "^", segment: "~" });
    const ids = segments.map((s) => s[0]);
    expect(ids).toEqual([
      "ISA",
      "GS",
      "ST",
      "BHT",
      "HL",
      "NM1",
      "HL",
      "NM1",
      "HL",
      "TRN",
      "NM1",
      "DMG",
      "DTP",
      "EQ",
      "SE",
      "GE",
      "IEA",
    ]);
    // ISA is the fixed-width 106-character header.
    expect(x12.indexOf("~")).toBe(105);
    expect(x12).toContain("GS*HS*A123456*CMS*20261006*0734*5014*X*005010X279A1~");
    expect(x12).toContain("NM1*PR*2*CMS*****PI*CMS~");
    expect(x12).toContain("NM1*1P*2*ENGRACE HOSPICE LLC*****XX*1234567893~");
    expect(x12).toContain(`NM1*IL*1*O'CONNOR-SMITH*JOSE****MI*${MBI}~`);
    expect(x12).toContain("DMG*D8*19400401~");
    expect(x12).toContain("DTP*291*RD8*20261001-20261006~");
    expect(x12).toContain("EQ*30^45~");
    expect(x12).toContain("TRN*1*chk-0001*9A123456");
    // SE01 counts ST..SE inclusive: 13 body segments + SE.
    expect(x12).toContain("SE*13*0001~");
    expect(x12).toContain("IEA*1*000005014~");
  });

  it("uses DTP D8 for a single date and omits DMG when DOB is unknown (CG Table 9 alternate 2)", () => {
    const x12 = build270({
      ...base,
      subscriber: { ...base.subscriber, dateOfBirth: null },
      serviceDates: { from: "2026-10-06", to: "2026-10-06" },
    });
    expect(x12).toContain("DTP*291*D8*20261006~");
    expect(x12).not.toContain("DMG*");
  });

  it.each([
    ["subscriber.mbi", { subscriber: { ...base.subscriber, mbi: "123456789A" } }],
    ["subscriber.mbi", { subscriber: { ...base.subscriber, mbi: "1SG4TE5MK73" } }],
    ["provider.npi", { provider: { ...base.provider, npi: "12345" } }],
    ["submitterId", { submitterId: "bad id!" }],
    ["subscriber.lastName", { subscriber: { ...base.subscriber, lastName: "***" } }],
    ["serviceDates", { serviceDates: { from: "2026-10-06", to: "2026-10-01" } }],
    ["controlNumber", { controlNumber: 0 }],
  ])("rejects a bad %s without echoing the value", (field, patch) => {
    let error: unknown;
    try {
      build270({ ...base, ...(patch as Partial<Hets270Request>) });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Hets270BuildError);
    expect((error as Hets270BuildError).field).toBe(field);
    expect((error as Error).message).not.toContain("123456789A");
  });

  it("MBI_PATTERN follows the CMS 11-character format", () => {
    expect(MBI_PATTERN.test(MBI)).toBe(true);
    expect(MBI_PATTERN.test("0EG4TE5MK73")).toBe(false); // position 1 is 1-9
    expect(MBI_PATTERN.test("1EG4TE5MKZ3")).toBe(false); // position 10 numeric
    expect(MBI_PATTERN.test("1IG4TE5MK73")).toBe(false); // I is excluded
  });
});
