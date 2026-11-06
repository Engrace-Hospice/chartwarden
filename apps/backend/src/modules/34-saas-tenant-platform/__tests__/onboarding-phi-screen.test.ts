// The wizard's free text (evidence notes, reasons, blocker text) is an ops-typed field in a tenant's audit trail: it must
// never carry a patient identifier. Best-effort screen, safe side on false positives.
// Values below are synthetic: SSNs use area 666/9xx (never issued), the MBI is on the synthetic registry.
import { describe, expect, it } from "vitest";
import { looksLikePatientIdentifier, looksLikeSsn } from "../onboarding/phi-screen";

describe("looksLikeSsn", () => {
  it.each([
    ["dashed", "customer read out 900-12-3456 on the call"],
    ["undashed", "id 900123456 on the form"],
    ["spaced", "ssn 666 12 3456"],
    ["dotted", "666.12.3456"],
    ["full-width digits", "９００-１２-３４５６"],
    ["at the very start and end", "900-12-3456"],
  ])("flags an SSN-shaped value (%s)", (_label, text) => {
    expect(looksLikeSsn(text)).toBe(true);
  });

  it.each([
    ["a document reference", "signed order form on file, DOC-1042"],
    ["a date", "confirmed on 2026-11-05 by phone"],
    ["a phone number", "reached the administrator on (555) 123-4567"],
    ["a dashed phone number", "call 555-123-4567"],
    ["a ten digit run", "ticket 1234567890"],
    ["a short number", "two locations, 12 users"],
    ["empty", ""],
  ])("does not flag %s", (_label, text) => {
    expect(looksLikeSsn(text)).toBe(false);
  });
});

describe("looksLikePatientIdentifier", () => {
  it("flags an MBI in any of its written forms", () => {
    for (const text of [
      "beneficiary 1EG4TE5MK73 was checked",
      "beneficiary 1EG4-TE5-MK73 was checked",
      "beneficiary 1eg4 te5 mk73 was checked",
    ]) {
      expect(looksLikePatientIdentifier(text)).toBe(true);
    }
  });

  it("flags an SSN", () => {
    expect(looksLikePatientIdentifier("see 900-12-3456")).toBe(true);
  });

  it("passes ordinary evidence text", () => {
    expect(
      looksLikePatientIdentifier(
        "Provider entity and NPI verified against NPPES; order form countersigned 2026-11-05 (DOC-1042).",
      ),
    ).toBe(false);
  });
});
