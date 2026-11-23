import type { MedicaidPayerProgramClassification } from "@chartwarden/mdm";
import { describe, expect, it } from "vitest";
import { qualifyMedicaidProgramClassification } from "../src/modules/24-billing-medicaid/medicaid-payer-classification";

const classification = (
  overrides: Partial<MedicaidPayerProgramClassification> = {},
): MedicaidPayerProgramClassification => ({
  id: "class-1",
  canonicalPayerId: "payer-1",
  stateCode: "OR",
  classification: "oregon_ffs",
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  verificationStatus: "verified",
  sourceKind: "state_registry",
  sourceReference: "registry:synthetic-source",
  supersedesId: null,
  ...overrides,
});

describe("M40 payer program classification qualification", () => {
  it("accepts a single verified, date-covering Oregon FFS classification", () => {
    expect(
      qualifyMedicaidProgramClassification(
        [classification()],
        "ffs_open_card",
        "payer-1",
        "OR",
        "2026-02-01",
        "2026-02-28",
      ).qualified,
    ).toBe(true);
  });

  it("rejects FFS/CCO contradictions and unknown, expired or conflicting evidence", () => {
    expect(
      qualifyMedicaidProgramClassification(
        [classification()],
        "managed_care",
        "payer-1",
        "OR",
        "2026-02-01",
        "2026-02-28",
      ),
    ).toEqual({ qualified: false, reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_MISMATCH" });
    expect(
      qualifyMedicaidProgramClassification(
        [],
        "ffs_open_card",
        "payer-1",
        "OR",
        "2026-02-01",
        "2026-02-28",
      ),
    ).toEqual({ qualified: false, reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_MISSING" });
    expect(
      qualifyMedicaidProgramClassification(
        [classification({ verificationStatus: "unverified" })],
        "ffs_open_card",
        "payer-1",
        "OR",
        "2026-02-01",
        "2026-02-28",
      ),
    ).toEqual({ qualified: false, reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_UNVERIFIED" });
    expect(
      qualifyMedicaidProgramClassification(
        [classification({ effectiveTo: "2026-01-31" })],
        "ffs_open_card",
        "payer-1",
        "OR",
        "2026-02-01",
        "2026-02-28",
      ),
    ).toEqual({ qualified: false, reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_EXPIRED" });
    expect(
      qualifyMedicaidProgramClassification(
        [classification(), classification({ id: "class-2", classification: "medicaid_cco" })],
        "ffs_open_card",
        "payer-1",
        "OR",
        "2026-02-01",
        "2026-02-28",
      ),
    ).toEqual({ qualified: false, reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_AMBIGUOUS" });
  });

  it("requires the full service interval and an exact state/payer-scoped reader result", () => {
    const partial = classification({ effectiveTo: "2026-02-10" });
    expect(
      qualifyMedicaidProgramClassification(
        [partial],
        "ffs_open_card",
        "payer-1",
        "OR",
        "2026-02-01",
        "2026-02-28",
      ).qualified,
    ).toBe(false);
    expect(
      qualifyMedicaidProgramClassification(
        [classification({ stateCode: "WA" })],
        "ffs_open_card",
        "payer-1",
        "OR",
        "2026-02-01",
        "2026-02-28",
      ).qualified,
    ).toBe(false);
  });

  it("uses the explicitly superseding record and never accepts Oregon FFS outside Oregon", () => {
    const replacement = classification({
      id: "class-2",
      classification: "medicaid_cco",
      supersedesId: "class-1",
    });
    expect(
      qualifyMedicaidProgramClassification(
        [classification(), replacement],
        "managed_care",
        "payer-1",
        "OR",
        "2026-02-01",
        "2026-02-28",
      ),
    ).toEqual({ qualified: true, classification: replacement });
    expect(
      qualifyMedicaidProgramClassification(
        [classification({ stateCode: "WA" })],
        "ffs_open_card",
        "payer-1",
        "WA",
        "2026-02-01",
        "2026-02-28",
      ),
    ).toEqual({ qualified: false, reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_MISMATCH" });
  });

  it("rejects a window that a contradictory verified row starts inside", () => {
    // A covers the whole window, but B (verified CCO) takes over on 2026-02-15: the window straddles two programs.
    const ffs = classification({ id: "class-ffs" });
    const cco = classification({
      id: "class-cco",
      classification: "medicaid_cco",
      effectiveFrom: "2026-02-15",
    });
    expect(
      qualifyMedicaidProgramClassification(
        [ffs, cco],
        "ffs_open_card",
        "payer-1",
        "OR",
        "2026-02-01",
        "2026-02-28",
      ),
    ).toEqual({ qualified: false, reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_AMBIGUOUS" });
    // A window that ends before the second row starts is still clean.
    expect(
      qualifyMedicaidProgramClassification(
        [ffs, cco],
        "ffs_open_card",
        "payer-1",
        "OR",
        "2026-02-01",
        "2026-02-14",
      ).qualified,
    ).toBe(true);
  });

  it("ignores overlapping rows that are not verified evidence", () => {
    const ffs = classification({ id: "class-ffs" });
    for (const verificationStatus of ["unverified", "rejected", "revoked", "superseded"] as const) {
      expect(
        qualifyMedicaidProgramClassification(
          [
            ffs,
            classification({
              id: "class-other",
              classification: "medicaid_cco",
              effectiveFrom: "2026-02-15",
              verificationStatus,
            }),
          ],
          "ffs_open_card",
          "payer-1",
          "OR",
          "2026-02-01",
          "2026-02-28",
        ).qualified,
      ).toBe(true);
    }
  });
});
