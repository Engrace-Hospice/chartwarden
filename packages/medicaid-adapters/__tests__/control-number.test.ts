import { describe, expect, it } from "vitest";
import {
  deriveMedicaidControlNumber,
  isValidMedicaidControlNumber,
  parseMedicaidControlNumber,
} from "../src/control-number";

const baseInput = {
  ccn: "381588",
  serviceState: "OR",
  serviceFrom: "2026-06-01",
  claimId: "09abcdef-1234-4567-8901-abcdefabcdef",
  attemptIndex: 0,
};

describe("deriveMedicaidControlNumber", () => {
  it("is deterministic and state-namespaced and within varchar(32)", () => {
    const cn = deriveMedicaidControlNumber(baseInput);
    expect(cn).toBe(deriveMedicaidControlNumber(baseInput));
    expect(cn.startsWith("381588-OR-260601-")).toBe(true);
    expect(cn.length).toBeLessThanOrEqual(32);
    expect(isValidMedicaidControlNumber(cn)).toBe(true);
  });

  it("round-trips through parse", () => {
    const cn = deriveMedicaidControlNumber(baseInput);
    const parsed = parseMedicaidControlNumber(cn);
    expect(parsed).not.toBeNull();
    expect(parsed!.ccn).toBe("381588");
    expect(parsed!.serviceState).toBe("OR");
    expect(parsed!.yymmdd).toBe("260601");
    expect(parsed!.attemptIndex).toBe(0);
  });

  it("varies by attempt index", () => {
    const a = deriveMedicaidControlNumber({ ...baseInput, attemptIndex: 0 });
    const b = deriveMedicaidControlNumber({ ...baseInput, attemptIndex: 1 });
    expect(a).not.toBe(b);
  });

  it("rejects a malformed ccn / state / date / attempt", () => {
    expect(() => deriveMedicaidControlNumber({ ...baseInput, ccn: "X" })).toThrow(RangeError);
    expect(() => deriveMedicaidControlNumber({ ...baseInput, serviceState: "OREGON" })).toThrow(RangeError);
    expect(() => deriveMedicaidControlNumber({ ...baseInput, serviceFrom: "06/01/26" })).toThrow(RangeError);
    expect(() => deriveMedicaidControlNumber({ ...baseInput, attemptIndex: -1 })).toThrow(RangeError);
  });

  it("parse returns null on a non-conforming string", () => {
    expect(parseMedicaidControlNumber("not-a-control-number")).toBeNull();
    expect(isValidMedicaidControlNumber("not-a-control-number")).toBe(false);
  });
});
