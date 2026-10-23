import { describe, expect, it } from "vitest";
import { envelopeErrorMessage } from "../error-message";

describe("envelopeErrorMessage (#596)", () => {
  it("returns the server's message from the standard envelope", () => {
    expect(envelopeErrorMessage({ error: { code: "TRIGGER_NO_COVERING_SHIFT", message: "no shift" } })).toBe("no shift");
  });
  it("withholds authorization refusals so friendly copy can win", () => {
    expect(envelopeErrorMessage({ error: { code: "FORBIDDEN", message: "policy x denied" } })).toBeNull();
    expect(envelopeErrorMessage({ error: { code: "UNAUTHORIZED", message: "no" } })).toBeNull();
    for (const code of ["STEP_UP_REQUIRED", "FHIR_SCOPE_DENIED", "SCOPE_OUTSIDE_MEMBERSHIP", "SESSION_EXPIRED", "NOT_FOUND", "CTI_VOID_FORBIDDEN"])
      expect(envelopeErrorMessage({ error: { code, message: "policy text" } })).toBeNull();
  });
  it("returns null for anything that is not the envelope", () => {
    for (const v of [null, undefined, "x", {}, { error: {} }, { error: { message: "" } }, { error: { message: 5 } }])
      expect(envelopeErrorMessage(v)).toBeNull();
  });
});
