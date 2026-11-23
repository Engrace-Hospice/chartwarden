import { describe, expect, it } from "vitest";
import {
  type MedicaidEraAccountEvidence,
  resolveMedicaidEraAttribution,
} from "../src/modules/25-remittance/domain/medicaid-era-trusted-review";
import { productionAccount, singleSet, sourceFor } from "./_m25-medicaid-era-fixtures";

const { raw, observation } = singleSet();
const resolve = (accounts: readonly MedicaidEraAccountEvidence[], source = sourceFor(raw)) =>
  resolveMedicaidEraAttribution({ source, observation, accounts });

describe("effective-date validation of enrollment evidence", () => {
  it.each([
    "N/A",
    "",
    "9999-99-99",
    "2026-13-45",
    "2026-02-30",
    "20261231",
    "2026-12-31T00:00:00Z",
  ])(
    "holds evidence whose effectiveTo is malformed (%j) instead of treating it as never expiring",
    (effectiveTo) => {
      expect(resolve([{ ...productionAccount, effectiveTo }])).toEqual({
        status: "held",
        reason: "SOURCE_EVIDENCE_STALE",
      });
    },
  );

  it.each(["2026-02-30", "N/A", "2026-1-1"])(
    "holds evidence whose effectiveFrom is not a calendar date (%j)",
    (effectiveFrom) => {
      expect(resolve([{ ...productionAccount, effectiveFrom }])).toEqual({
        status: "held",
        reason: "SOURCE_EVIDENCE_STALE",
      });
    },
  );

  it("still honours a well-formed effectiveTo", () => {
    expect(resolve([{ ...productionAccount, effectiveTo: "2026-11-21" }])).toEqual({
      status: "held",
      reason: "ENROLLMENT_NOT_ACTIVE",
    });
    expect(resolve([{ ...productionAccount, effectiveTo: "2026-11-22" }]).status).toBe("verified");
  });
});

describe("attribution is judged at receipt time", () => {
  // An ERA belongs to whoever held the account, with fresh evidence, when it was RECEIVED: evidence that merely lapsed
  // since (effectiveTo / evidenceFreshUntil passed) still attributes it, so a late recoupment stays reviewable. The
  // guard against an account re-pointed afterwards is verifiedAt <= receivedAt, which is coarse: a row re-verified IN
  // PLACE holds every artifact received before the re-verification (pinned below); only a history row verified at or
  // before receipt keeps an older artifact attributing.
  const oldSource = { ...sourceFor(raw), receivedAt: "2025-06-01T12:00:00.000Z" };
  const lapsedSince = {
    ...productionAccount,
    effectiveFrom: "2025-01-01",
    verifiedAt: "2025-05-01T00:00:00.000Z",
    evidenceFreshUntil: "2025-07-01T00:00:00.000Z",
  };

  it("verifies an old artifact whose evidence has lapsed since it was received", () => {
    expect(resolve([lapsedSince], oldSource).status).toBe("verified");
  });

  it("holds an artifact received after its evidence lapsed", () => {
    expect(
      resolve([lapsedSince], { ...oldSource, receivedAt: "2025-08-01T12:00:00.000Z" }),
    ).toEqual({ status: "held", reason: "SOURCE_EVIDENCE_STALE" });
  });

  it("holds an artifact received before the evidence was (re-)verified, which is the cost of re-verifying in place", () => {
    expect(
      resolve([{ ...lapsedSince, verifiedAt: "2025-06-02T00:00:00.000Z" }], oldSource),
    ).toEqual({ status: "held", reason: "SOURCE_EVIDENCE_STALE" });
  });
});

describe("one account shared by several provider entities", () => {
  const entityA: MedicaidEraAccountEvidence = {
    ...productionAccount,
    providerEntityId: "provider-synthetic-1",
    billingNpi: "1999999999",
  };
  const entityB: MedicaidEraAccountEvidence = {
    ...productionAccount,
    providerEntityId: "provider-synthetic-2",
    billingNpi: "1888888888",
    evidenceReference: "synthetic:evidence-2",
  };

  it("is disambiguated by the payee NPI the ERA names", () => {
    expect(resolve([entityA, entityB])).toMatchObject({
      status: "verified",
      providerEntityId: "provider-synthetic-1",
      evidenceReference: "synthetic:evidence-1",
    });
    expect(resolve([entityB, entityA])).toMatchObject({
      status: "verified",
      providerEntityId: "provider-synthetic-1",
    });
  });

  it("stays ambiguous when several entities carry the same billing NPI", () => {
    expect(resolve([entityA, { ...entityB, billingNpi: "1999999999" }])).toEqual({
      status: "held",
      reason: "SOURCE_ACCOUNT_AMBIGUOUS",
    });
  });

  it("reports a payee conflict, not ambiguity, when the payee NPI matches none of them", () => {
    expect(
      resolve([
        { ...entityA, billingNpi: "1777777777" },
        { ...entityB, billingNpi: "1666666666" },
      ]),
    ).toEqual({ status: "held", reason: "PAYEE_IDENTITY_CONFLICT" });
  });

  it("keeps evidence rows for one entity ambiguous when several cover the receipt date", () => {
    expect(resolve([entityA, entityA])).toEqual({
      status: "held",
      reason: "SOURCE_ACCOUNT_AMBIGUOUS",
    });
    expect(resolve([entityA, { ...entityA, effectiveFrom: "2026-06-01" }])).toEqual({
      status: "held",
      reason: "SOURCE_ACCOUNT_AMBIGUOUS",
    });
  });

  describe("re-enrollment history rows of one entity (same account, same billing NPI)", () => {
    const earlierEnrollment: MedicaidEraAccountEvidence = {
      ...entityA,
      effectiveFrom: "2025-01-01",
      effectiveTo: "2025-12-31",
      evidenceReference: "synthetic:evidence-earlier",
      verifiedAt: "2025-02-01T00:00:00.000Z",
      evidenceFreshUntil: "2026-02-01T00:00:00.000Z",
    };

    it("uses the row whose effective window covers the receipt date", () => {
      for (const accounts of [
        [earlierEnrollment, entityA],
        [entityA, earlierEnrollment],
      ]) {
        expect(resolve(accounts)).toMatchObject({
          status: "verified",
          providerEntityId: "provider-synthetic-1",
          evidenceReference: "synthetic:evidence-1",
        });
      }
    });

    it("attributes an artifact received during the earlier enrollment to the earlier row", () => {
      expect(
        resolve([earlierEnrollment, entityA], {
          ...sourceFor(raw),
          receivedAt: "2025-06-01T12:00:00.000Z",
        }),
      ).toMatchObject({ status: "verified", evidenceReference: "synthetic:evidence-earlier" });
    });

    it("stays ambiguous when no row covers the receipt date", () => {
      expect(resolve([earlierEnrollment, { ...entityA, effectiveFrom: "2027-01-01" }])).toEqual({
        status: "held",
        reason: "SOURCE_ACCOUNT_AMBIGUOUS",
      });
    });

    it.each(["N/A", "", "2026-02-30"])(
      "does not let a malformed window pick a row (%j)",
      (effectiveFrom) => {
        expect(resolve([earlierEnrollment, { ...entityA, effectiveFrom }])).toEqual({
          status: "held",
          reason: "SOURCE_ACCOUNT_AMBIGUOUS",
        });
      },
    );

    it("still holds the selected row when its own enrollment is not active", () => {
      expect(resolve([earlierEnrollment, { ...entityA, enrollment: "revoked" }])).toEqual({
        status: "held",
        reason: "ENROLLMENT_NOT_ACTIVE",
      });
    });
  });
});
