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

  it("does not read accepted when a set was not accepted", () => {
    const r = parse999(ack(["AK1*HC*106~", "AK2*837*0106~", "IK5*R*5~", "AK9*A*1*1*1~"]));
    expect(r.outcome).toBe("partial");
  });

  it("does not read accepted when fewer sets were accepted than received", () => {
    expect(parse999(ack(["AK1*HC*106~", "AK9*A*2*2*1~"])).outcome).toBe("partial");
  });

  it("takes the worst verdict across several groups", () => {
    const r = parse999(ack(["AK1*HC*106~", "AK9*A*1*1*1~", "AK1*HC*107~", "AK9*R*1*1*0~"]));
    expect(r.outcome).toBe("rejected");
  });

  it("reads the 004010 AK3/AK4/AK5 names", () => {
    const r = parse999(
      ack([
        "AK1*HC*106~",
        "AK2*837*0106~",
        "AK3*CLM*19**8~",
        "AK4*2*782*7*X~",
        "AK5*R*5~",
        "AK9*R*1*1*0~",
      ]),
    );
    expect(r.errors.map((e) => e.segment)).toEqual(["CLM", "CLM02", "AK5"]);
  });

  it("reads several acknowledged sets, each with its own status", () => {
    const r = parse999(
      ack(["AK1*HC*106~", "AK2*837*0001~", "IK5*A~", "AK2*837*0002~", "IK5*R*5~", "AK9*P*2*2*1~"]),
    );
    expect(r.transactionSets).toEqual([
      { controlNumber: "0001", status: "A" },
      { controlNumber: "0002", status: "R" },
    ]);
  });

  it("keeps only the position of a composite IK4-01", () => {
    const r = parse999(ack(["AK1*HC*106~", "IK3*CLM*19**8~", "IK4*2:1*782*7~", "AK9*R*1*1*0~"]));
    expect(r.errors[1]?.segment).toBe("CLM02");
  });

  it("never echoes free text sent in a segment-id or status position", () => {
    const r = parse999(
      ack([
        "AK1*HC*106~",
        "AK2*837*0106~",
        "IK3*Jane Doe 1EG4*19**1~",
        "IK5*Jane Doe~",
        "AK9*R*1*1*0~",
      ]),
    );
    expect(JSON.stringify(r)).not.toMatch(/Jane|Doe|1EG4/);
  });

  it("fails closed on an empty AK1-02", () => {
    expect(() => parse999(ack(["AK1*HC~", "AK9*A*1*1*1~"]))).toThrow(X12FormatError);
  });

  it.each([
    ["no sets present", ["AK1*HC*1~", "AK9*A*1*1*1~"]],
    ["fewer sets present than included", ["AK1*HC*1~", "AK2*837*0001~", "IK5*A~", "AK9*A*2*2*2~"]],
    ["zero counts", ["AK1*HC*1~", "AK9*A*0*0*0~"]],
    ["missing counts", ["AK1*HC*1~", "AK9*A~"]],
    ["a non-numeric accepted count", ["AK1*HC*1~", "AK2*837*0001~", "IK5*A~", "AK9*A*1*1*abc~"]],
  ])("never reads accepted with %s", (_n, body) => {
    expect(parse999(ack(body)).outcome).toBe("partial");
  });

  it("drops free text from an element position, a code and a control number", () => {
    const r = parse999(
      ack([
        "AK1*HC*106~",
        "AK2*837*Jane Doe~",
        "IK3*CLM*19**8~",
        "IK4*John Smith:1*782*Jane Doe~",
        "AK9*R*1*1*0~",
      ]),
    );
    expect(JSON.stringify(r)).not.toMatch(/Jane|Doe|John|Smith/);
    expect(r.errors[1]).toMatchObject({ segment: "CLM00", code: "UNKNOWN" });
  });

  it("never returns a non-string description for an inherited-property code", () => {
    const r = parse999(ack(["AK1*HC*106~", "AK2*837*0106~", "IK5*R*toString~", "AK9*R*1*1*0~"]));
    expect(r.errors.every((e) => typeof e.description === "string")).toBe(true);
    expect(r.errors[0]?.description).toBe("Unrecognized code");
  });
});
