// @chartwarden/billing — discharge claim codes (CMS Pub. 100-04 Ch. 11 §30.3, Transmittal 2410 / CR 7677).
import {
  type ClaimDischargeFact,
  type DischargeClaimCodes,
  deriveDischargeClaimCodes,
  dischargeCodeConflicts,
} from "@chartwarden/billing";
import { describe, expect, it } from "vitest";

const SERVICE_TO = "2026-03-31";
const derive = (discharge: ClaimDischargeFact | null) =>
  deriveDischargeClaimCodes({ serviceTo: SERVICE_TO, discharge });

describe("deriveDischargeClaimCodes", () => {
  it("30 still a patient when there is no discharge", () => {
    expect(derive(null)).toEqual({
      patientStatus: "30",
      conditionCodes: [],
      occurrenceCodes: [],
      unresolved: null,
    });
  });

  it("30 still a patient when the discharge falls after the Through date", () => {
    expect(
      derive({ kind: "death", effectiveDate: "2026-04-01", placeOfDeath: "home" }).patientStatus,
    ).toBe("30");
  });

  it("codes a discharge ON the Through date (inclusive)", () => {
    expect(derive({ kind: "no_longer_terminal", effectiveDate: SERVICE_TO }).patientStatus).toBe(
      "01",
    );
  });

  it.each([
    ["home", "40"],
    ["facility", "41"],
    ["unknown", "42"],
  ] as const)("death at %s → %s + occurrence 55 with the date of death", (place, status) => {
    expect(
      derive({
        kind: "death",
        effectiveDate: "2026-03-20",
        deathDate: "2026-03-19",
        placeOfDeath: place,
      }),
    ).toEqual({
      patientStatus: status,
      conditionCodes: [],
      occurrenceCodes: [{ code: "55", date: "2026-03-19" }],
      unresolved: null,
    });
  });

  it("death with no recorded place is unresolved (never guessed)", () => {
    expect(derive({ kind: "death", effectiveDate: "2026-03-20", placeOfDeath: null })).toEqual({
      patientStatus: null,
      conditionCodes: [],
      occurrenceCodes: [],
      unresolved: "place_of_death_missing",
    });
  });

  it("occurrence 55 falls back to the discharge date when no death date is on file", () => {
    expect(
      derive({ kind: "death", effectiveDate: "2026-03-20", placeOfDeath: "unknown" })
        .occurrenceCodes,
    ).toEqual([{ code: "55", date: "2026-03-20" }]);
  });

  it.each([
    ["home", "50"],
    ["facility", "51"],
  ] as const)("transfer to a hospice caring at %s → %s, no other indicator", (setting, status) => {
    expect(
      derive({ kind: "transfer", effectiveDate: "2026-03-10", receivingCareSetting: setting }),
    ).toEqual({ patientStatus: status, conditionCodes: [], occurrenceCodes: [], unresolved: null });
  });

  it("transfer with no recorded receiving setting is unresolved", () => {
    expect(
      derive({ kind: "transfer", effectiveDate: "2026-03-10", receivingCareSetting: null })
        .unresolved,
    ).toBe("transfer_setting_missing");
  });

  it("revocation → occurrence 42 dated the revocation", () => {
    expect(derive({ kind: "revocation", effectiveDate: "2026-03-05" })).toEqual({
      patientStatus: "01",
      conditionCodes: [],
      occurrenceCodes: [{ code: "42", date: "2026-03-05" }],
      unresolved: null,
    });
  });

  it("moved out of the service area → condition 52, no occurrence 42", () => {
    expect(derive({ kind: "moved_out_of_service_area", effectiveDate: "2026-03-05" })).toEqual({
      patientStatus: "01",
      conditionCodes: ["52"],
      occurrenceCodes: [],
      unresolved: null,
    });
  });

  it("for cause → condition H2, no occurrence 42", () => {
    expect(derive({ kind: "for_cause", effectiveDate: "2026-03-05" })).toEqual({
      patientStatus: "01",
      conditionCodes: ["H2"],
      occurrenceCodes: [],
      unresolved: null,
    });
  });

  it("no longer terminally ill → no other indicator", () => {
    expect(derive({ kind: "no_longer_terminal", effectiveDate: "2026-03-05" })).toEqual({
      patientStatus: "01",
      conditionCodes: [],
      occurrenceCodes: [],
      unresolved: null,
    });
  });

  it.each(["other", "something_new"])("'%s' is not a codable discharge reason", (kind) => {
    expect(derive({ kind, effectiveDate: "2026-03-05" }).unresolved).toBe(
      "discharge_reason_not_codable",
    );
  });

  it("every resolved derivation passes the CR 7677 edits", () => {
    const facts: ClaimDischargeFact[] = [
      { kind: "death", effectiveDate: "2026-03-05", placeOfDeath: "home" },
      { kind: "transfer", effectiveDate: "2026-03-05", receivingCareSetting: "facility" },
      { kind: "revocation", effectiveDate: "2026-03-05" },
      { kind: "moved_out_of_service_area", effectiveDate: "2026-03-05" },
      { kind: "for_cause", effectiveDate: "2026-03-05" },
      { kind: "no_longer_terminal", effectiveDate: "2026-03-05" },
    ];
    for (const f of [null, ...facts]) expect(dischargeCodeConflicts(derive(f))).toEqual([]);
  });
});

describe("dischargeCodeConflicts (CR 7677 return-to-provider edits)", () => {
  const codes = (over: Partial<DischargeClaimCodes>): DischargeClaimCodes => ({
    patientStatus: "01",
    conditionCodes: [],
    occurrenceCodes: [],
    unresolved: null,
    ...over,
  });

  it("52 with H2", () => {
    expect(dischargeCodeConflicts(codes({ conditionCodes: ["52", "H2"] }))).toContain(
      "condition codes 52 and H2 cannot both be reported",
    );
  });
  it("52 or H2 with status 30", () => {
    expect(
      dischargeCodeConflicts(codes({ patientStatus: "30", conditionCodes: ["H2"] })),
    ).toHaveLength(1);
  });
  it("52 or H2 with occurrence 42", () => {
    expect(
      dischargeCodeConflicts(
        codes({ conditionCodes: ["52"], occurrenceCodes: [{ code: "42", date: "2026-03-01" }] }),
      ),
    ).toContain("condition code 52/H2 cannot be reported with occurrence code 42");
  });
  it("occurrence 42 on a transfer", () => {
    expect(
      dischargeCodeConflicts(
        codes({ patientStatus: "50", occurrenceCodes: [{ code: "42", date: "2026-03-01" }] }),
      ),
    ).toHaveLength(1);
  });
  it("expired status without 55, and 55 without an expired status", () => {
    expect(dischargeCodeConflicts(codes({ patientStatus: "41" }))).toHaveLength(1);
    expect(
      dischargeCodeConflicts(codes({ occurrenceCodes: [{ code: "55", date: "2026-03-01" }] })),
    ).toHaveLength(1);
  });
});
