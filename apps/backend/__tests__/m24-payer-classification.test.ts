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

describe("a superseder only retires its predecessor once it has been in force", () => {
  // X is verified and open since January; X' points at it and ends on 2026-03-31.
  const original = classification({ id: "class-x" });
  const superseder = (
    verificationStatus: MedicaidPayerProgramClassification["verificationStatus"],
    overrides: Partial<MedicaidPayerProgramClassification> = {},
  ) =>
    classification({
      id: "class-x-prime",
      effectiveTo: "2026-03-31",
      supersedesId: original.id,
      verificationStatus,
      ...overrides,
    });
  const qualify = (
    rows: readonly MedicaidPayerProgramClassification[],
    serviceFrom: string,
    serviceTo: string,
  ) =>
    qualifyMedicaidProgramClassification(
      rows,
      "ffs_open_card",
      "payer-1",
      "OR",
      serviceFrom,
      serviceTo,
    );
  const FEBRUARY = ["2026-02-01", "2026-02-28"] as const;
  const AUGUST = ["2026-08-01", "2026-08-31"] as const;

  it.each(["unverified", "rejected"] as const)(
    "keeps the verified row current when its %s superseder never took effect",
    (status) => {
      for (const [from, to] of [FEBRUARY, AUGUST]) {
        expect(qualify([original, superseder(status)], from, to)).toEqual({
          qualified: true,
          classification: original,
        });
      }
    },
  );

  it("keeps the verified row current when a pending proposal starts later and runs open", () => {
    const pending = superseder("unverified", {
      classification: "medicaid_cco",
      effectiveFrom: "2026-04-01",
      effectiveTo: null,
    });
    for (const [from, to] of [FEBRUARY, AUGUST]) {
      expect(qualify([original, pending], from, to)).toEqual({
        qualified: true,
        classification: original,
      });
    }
  });

  it("lets a verified, end-dated superseder retire its predecessor", () => {
    expect(qualify([original, superseder("verified")], ...AUGUST)).toEqual({
      qualified: false,
      reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_EXPIRED",
    });
  });

  it("keeps a revoked superseder's predecessor retired: it was once in force, so fail closed", () => {
    for (const [from, to] of [FEBRUARY, AUGUST]) {
      expect(qualify([original, superseder("revoked")], from, to).qualified).toBe(false);
    }
  });

  it("keeps the chain intact when the superseder was itself superseded", () => {
    const successor = classification({
      id: "class-x-second",
      effectiveFrom: "2026-04-01",
      supersedesId: "class-x-prime",
    });
    expect(qualify([original, superseder("superseded"), successor], ...AUGUST)).toEqual({
      qualified: true,
      classification: successor,
    });
  });
});
