import { describe, expect, it } from "vitest";
import { assertDdeInDoubtResolutionConfirmed } from "./dde-queue-service";

describe("DDE uncertain-attempt reconciliation confirmation", () => {
  it("does not add a confirmation requirement to ordinary manual recording", () => {
    expect(() => assertDdeInDoubtResolutionConfirmed(false, undefined)).not.toThrow();
  });

  it.each([undefined, false])(
    "refuses to resolve an uncertain attempt without confirmation (%s)",
    (value) => {
      expect(() => assertDdeInDoubtResolutionConfirmed(true, value)).toThrow(
        "request validation failed",
      );
    },
  );

  it("accepts only an explicit confirmation that the transaction was found in DDE", () => {
    expect(() => assertDdeInDoubtResolutionConfirmed(true, true)).not.toThrow();
  });
});
