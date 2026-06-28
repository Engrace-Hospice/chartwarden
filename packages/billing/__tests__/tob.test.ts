// @wardenx/billing — M23 Type-of-Bill derivation (spec §1.1, D4 / D14) pure-domain tests.
//
// Assembly is server-authoritative: the server derives the UB-04 hospice TOB from three cadence facts —
// (a) whether a prior non-voided claim exists for the admission, (b) whether the patient is discharged
// on/before the through-date, and (c) whether the claim is a replacement (817) / void (818) of a prior
// accepted claim. A replacement/void OVERRIDES the interim cadence entirely. The four normal frequency
// codes follow the prior-claim × discharged truth table:
//   811 = admission-through-discharge (no prior, discharged); 812 = first interim (no prior, not discharged);
//   813 = continuing interim (prior, not discharged);          814 = last interim (prior, discharged).
// Pure + total: every combination resolves to exactly one TOB. No DB/Fastify/BullMQ.
import { describe, expect, it } from "vitest";
import { deriveTypeOfBill, type ClaimAdjustmentKind, type TobDerivationInput } from "@wardenx/billing";

describe("deriveTypeOfBill — normal interim cadence (adjustment: none)", () => {
  it("811 — admission-through-discharge: no prior claim AND discharged", () => {
    expect(
      deriveTypeOfBill({ hasPriorClaimForAdmission: false, patientDischarged: true, adjustment: "none" }),
    ).toBe("811");
  });

  it("812 — first interim: no prior claim AND not yet discharged", () => {
    expect(
      deriveTypeOfBill({ hasPriorClaimForAdmission: false, patientDischarged: false, adjustment: "none" }),
    ).toBe("812");
  });

  it("813 — continuing interim: a prior claim exists AND not yet discharged", () => {
    expect(
      deriveTypeOfBill({ hasPriorClaimForAdmission: true, patientDischarged: false, adjustment: "none" }),
    ).toBe("813");
  });

  it("814 — last interim before discharge: a prior claim exists AND discharged", () => {
    expect(
      deriveTypeOfBill({ hasPriorClaimForAdmission: true, patientDischarged: true, adjustment: "none" }),
    ).toBe("814");
  });
});

describe("deriveTypeOfBill — replacement / void override the cadence (D14)", () => {
  it("817 — a replacement, regardless of prior-claim / discharge state", () => {
    const combos: ReadonlyArray<readonly [boolean, boolean]> = [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ];
    for (const [prior, discharged] of combos) {
      expect(
        deriveTypeOfBill({
          hasPriorClaimForAdmission: prior,
          patientDischarged: discharged,
          adjustment: "replacement",
        }),
      ).toBe("817");
    }
  });

  it("818 — a void, regardless of prior-claim / discharge state", () => {
    const combos: ReadonlyArray<readonly [boolean, boolean]> = [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ];
    for (const [prior, discharged] of combos) {
      expect(
        deriveTypeOfBill({
          hasPriorClaimForAdmission: prior,
          patientDischarged: discharged,
          adjustment: "void",
        }),
      ).toBe("818");
    }
  });

  it("a replacement on a discharged admission with a prior claim is 817 (NOT 814)", () => {
    expect(
      deriveTypeOfBill({ hasPriorClaimForAdmission: true, patientDischarged: true, adjustment: "replacement" }),
    ).toBe("817");
  });

  it("a void on a fresh admission is 818 (NOT 812)", () => {
    expect(
      deriveTypeOfBill({ hasPriorClaimForAdmission: false, patientDischarged: false, adjustment: "void" }),
    ).toBe("818");
  });
});

describe("deriveTypeOfBill — full truth table is total + deterministic", () => {
  // Exhaustively enumerate all 2 × 2 × 3 = 12 input combinations; assert each maps to exactly one TOB.
  const expected: Record<string, string> = {
    "false|false|none": "812",
    "false|true|none": "811",
    "true|false|none": "813",
    "true|true|none": "814",
    "false|false|replacement": "817",
    "false|true|replacement": "817",
    "true|false|replacement": "817",
    "true|true|replacement": "817",
    "false|false|void": "818",
    "false|true|void": "818",
    "true|false|void": "818",
    "true|true|void": "818",
  };

  const adjustments: readonly ClaimAdjustmentKind[] = ["none", "replacement", "void"];
  for (const prior of [false, true]) {
    for (const discharged of [false, true]) {
      for (const adjustment of adjustments) {
        const key = `${prior}|${discharged}|${adjustment}`;
        it(`${key} → ${expected[key]}`, () => {
          const inp: TobDerivationInput = {
            hasPriorClaimForAdmission: prior,
            patientDischarged: discharged,
            adjustment,
          };
          expect(deriveTypeOfBill(inp)).toBe(expected[key]);
        });
      }
    }
  }
});
