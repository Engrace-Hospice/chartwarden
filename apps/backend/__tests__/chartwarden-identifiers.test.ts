// Independent literal oracles for the wardenx -> chartwarden rename of exchanged identifiers and rule ids.
// Every expected value is spelled out here, never imported from the code under test.
import { describe, expect, it } from "vitest";
import { mrnAssigningAuthorityFor } from "../src/modules/05-patient/seams/hl7-orm-demographics";
import { HOPE_V1_00_1_VALIDATION_RULES } from "../src/modules/10-hope/spec/v1_00_1/validation";
import { operationOutcome } from "../src/modules/28-fhir/routes/operation-outcome";

describe("chartwarden identifiers", () => {
  it("names the HOPE record-consistency rule chartwarden-* and keeps no wardenx rule id", () => {
    const ids = HOPE_V1_00_1_VALIDATION_RULES.map((r) => r.id);
    expect(ids).toContain("chartwarden-hope-record-consistency");
    expect(ids).not.toContain("wardenx-hope-record-consistency");
  });

  it("emits the CHARTWARDEN-<orgId> HL7 MRN assigning authority", () => {
    expect(mrnAssigningAuthorityFor("11111111-1111-4111-8111-111111111111")).toBe(
      "CHARTWARDEN-11111111-1111-4111-8111-111111111111",
    );
  });

  it("tags an OperationOutcome with the chartwarden error-code system", () => {
    const out = operationOutcome("error", "forbidden", "no", "BAA_NOT_IN_FORCE");
    expect(out.issue[0]?.details?.coding).toEqual([
      { system: "https://chartwarden.com/fhir/error-code", code: "BAA_NOT_IN_FORCE" },
    ]);
  });
});
