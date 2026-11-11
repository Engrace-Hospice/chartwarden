import {
  deriveMedicaidTobFromAdmission,
  deriveMedicaidTobFromFacts,
  isMedicaidCadenceBearingClaim,
} from "@chartwarden/medicaid-adapters";
import { describe, expect, it } from "vitest";

describe("deriveMedicaidTobFromFacts", () => {
  it.each([
    [false, true, "811"],
    [false, false, "812"],
    [true, false, "813"],
    [true, true, "814"],
  ] as const)(
    "derives the normal Medicaid cadence (prior=%s, discharged=%s => %s)",
    (hasPriorClaimForAdmission, patientDischarged, expected) => {
      expect(deriveMedicaidTobFromFacts({ hasPriorClaimForAdmission, patientDischarged })).toBe(
        expected,
      );
    },
  );
});

describe("isMedicaidCadenceBearingClaim", () => {
  it("preserves cadence when an accepted 817 marks its 812 predecessor REPLACED", () => {
    expect(isMedicaidCadenceBearingClaim({ tob: "812", state: "REPLACED" })).toBe(true);
    expect(
      deriveMedicaidTobFromAdmission({
        hasPriorClaimForAdmission: true,
        dischargedAt: null,
        serviceTo: "2026-07-31",
      }),
    ).toBe("813");
  });

  it.each(["VOIDED", "ACK_REJECTED", "ABANDONED"])(
    "does not carry cadence from a %s original",
    (state) => {
      expect(isMedicaidCadenceBearingClaim({ tob: "812", state })).toBe(false);
    },
  );
});

describe("deriveMedicaidTobFromAdmission", () => {
  it("keeps an active or LOC-assignment-pending admission on an interim TOB", () => {
    expect(
      deriveMedicaidTobFromAdmission({
        hasPriorClaimForAdmission: false,
        dischargedAt: null,
        serviceTo: "2026-06-30",
      }),
    ).toBe("812");
    expect(
      deriveMedicaidTobFromAdmission({
        hasPriorClaimForAdmission: true,
        dischargedAt: null,
        serviceTo: "2026-06-30",
      }),
    ).toBe("813");
  });

  it("does not use a discharge after the claim through-date to select a final TOB", () => {
    expect(
      deriveMedicaidTobFromAdmission({
        hasPriorClaimForAdmission: true,
        dischargedAt: "2026-07-01",
        serviceTo: "2026-06-30",
      }),
    ).toBe("813");
  });
});
