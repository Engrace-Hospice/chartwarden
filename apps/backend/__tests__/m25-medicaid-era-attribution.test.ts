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
  // Intended: an ERA belongs to whoever held the account, with fresh evidence, when it was RECEIVED. Re-inspecting it
  // after the evidence has since lapsed must still attribute it (a late recoupment stays reviewable); a later
  // re-verification (verifiedAt after receipt) is the guard against an account that was re-pointed afterwards.
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

  it("holds an artifact when the evidence was only verified after the artifact was received", () => {
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

  it("keeps duplicate evidence rows for one entity ambiguous", () => {
    expect(resolve([entityA, entityA])).toEqual({
      status: "held",
      reason: "SOURCE_ACCOUNT_AMBIGUOUS",
    });
  });
});
