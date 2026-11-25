import { LATE_ENTRY_REASON_MIN_CHARS } from "@chartwarden/types";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { TEXT_MINIMUMS } from "../src/modules/08-encounters/lifecycle/validation";
import {
  AttestationSchema,
  FinalizeEncounterSchema,
} from "../src/modules/08-encounters/routes/encounters-typebox";

describe("the late-entry reason minimum is the one shared with the composer", () => {
  it("is the service guard's minimum", () => {
    expect(TEXT_MINIMUMS.lateEntryReason).toBe(LATE_ENTRY_REASON_MIN_CHARS);
  });

  it.each([
    ["finalize", FinalizeEncounterSchema],
    ["sign attestation", AttestationSchema],
  ])("the %s body refuses one character short and takes the minimum", (_name, schema) => {
    const body = (length: number) => ({
      lateEntryReason: "x".repeat(length),
      attestationConfirmed: true,
    });
    expect(Value.Check(schema, body(LATE_ENTRY_REASON_MIN_CHARS - 1))).toBe(false);
    expect(Value.Check(schema, body(LATE_ENTRY_REASON_MIN_CHARS))).toBe(true);
  });
});
