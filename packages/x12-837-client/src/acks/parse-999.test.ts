import { describe, expect, it } from "vitest";
import { X12FormatError } from "../eligibility/x12-envelope";
import { parse999 } from "./parse-999";

const ISA =
  "ISA*00*          *00*          *ZZ*STEDI          *ZZ*WARDENX01      *261009*1500*^*00501*000000777*0*T*:~";

function ack(body: readonly string[]): string {
  return [
    ISA,
    "GS*FA*STEDI*WARDENX01*20261009*1500*777*X*005010X231A1~",
    "ST*999*0001*005010X231A1~",
    ...body,
    "SE*0*0001~",
    "GE*1*777~",
    "IEA*1*000000777~",
  ].join("\n");
}

describe("parse999", () => {
  it("reads an accepted file", () => {
    const r = parse999(
      ack(["AK1*HC*106*005010X223A2~", "AK2*837*0106*005010X223A2~", "IK5*A~", "AK9*A*1*1*1~"]),
    );
    expect(r).toMatchObject({
      outcome: "accepted",
      interchangeControlNumber: "000000777",
      acknowledgedGroupControlNumber: "106",
      functionalGroupDate: "2026-10-09",
      interchangeDate: "2026-10-09",
      errors: [],
      transactionSets: [{ controlNumber: "0106", status: "A" }],
    });
  });

  it("reads a rejected file with segment and element errors, codes only", () => {
    const r = parse999(
      ack([
        "AK1*HC*106*005010X223A2~",
        "AK2*837*0106*005010X223A2~",
        "IK3*CLM*19**8~",
        "IK4*2*782*7*SECRET-VALUE~",
        "IK5*R*5~",
        "AK9*R*1*1*0~",
      ]),
    );
    expect(r.outcome).toBe("rejected");
    expect(r.errors).toEqual([
      { segment: "CLM", code: "8", description: "Segment has data element errors" },
      { segment: "CLM02", code: "7", description: "Invalid code value" },
      { segment: "IK5", code: "5", description: "One or more segments in error" },
    ]);
    expect(JSON.stringify(r)).not.toContain("SECRET-VALUE");
  });

  it.each([
    ["E", "partial"],
    ["P", "partial"],
    ["M", "rejected"],
    ["W", "rejected"],
    ["X", "rejected"],
  ] as const)("maps AK9 %s to %s", (code, outcome) => {
    const r = parse999(ack(["AK1*HC*106~", `AK9*${code}*1*1*0~`]));
    expect(r.outcome).toBe(outcome);
  });

  it("names an unknown code without guessing", () => {
    const r = parse999(ack(["AK1*HC*106~", "AK2*837*0106~", "IK3*CLM*1**99~", "AK9*R*1*1*0~"]));
    expect(r.errors[0]).toEqual({
      segment: "CLM",
      code: "99",
      description: "Unrecognized code",
    });
  });

  it("fails closed when AK9 is missing", () => {
    expect(() => parse999(ack(["AK1*HC*106~"]))).toThrow(X12FormatError);
  });

  it("fails closed when the payload is not X12, without echoing it", () => {
    expect(() => parse999("hello PHI")).toThrow(X12FormatError);
    try {
      parse999("hello PHI");
    } catch (e) {
      expect(String(e)).not.toContain("PHI");
    }
  });

  it("fails closed when the interchange is not a 999", () => {
    const notAck = [ISA, "GS*HC*A*B*20261009*1500*1*X*005010X223A2~", "ST*837*0001~", "SE*1*0001~"];
    expect(() => parse999(notAck.join("\n"))).toThrow(X12FormatError);
  });
});
