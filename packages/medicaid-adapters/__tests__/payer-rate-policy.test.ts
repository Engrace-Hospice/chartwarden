import { describe, expect, it } from "vitest";
import { type PayerRatePolicyFact, resolvePayerRatePolicy } from "../src/payer-rate-policy";

const lookup = {
  organizationId: "org",
  providerEntityId: "provider",
  canonicalPayerId: "payer-cco",
  programKind: "managed_care" as const,
  serviceState: "OR",
  localityCode: "CBSA-OR-1",
  serviceCategory: "RHC" as const,
  unitBasis: "per_day" as const,
  bucketFrom: 1,
  bucketTo: 60,
  serviceFrom: "2026-01-01",
  serviceTo: "2026-01-31",
  qualityReportingRequired: false,
  providerQualityReportingStatus: null,
  providerQualityReportingVerified: false,
  chargeCeilingRequired: false,
};
const rate: PayerRatePolicyFact = {
  id: "rate-1",
  organizationId: "org",
  providerEntityId: "provider",
  canonicalPayerId: "payer-cco",
  programKind: "managed_care",
  serviceState: "OR",
  localityCode: "CBSA-OR-1",
  serviceCategory: "RHC",
  unitBasis: "per_day",
  bucketFrom: 1,
  bucketTo: 60,
  rateCents: 10000,
  chargeCeilingCents: null,
  qualityReportingStatus: "meets",
  sourceKind: "cco_contract",
  verificationStatus: "verified",
  effectiveFrom: "2026-01-01",
  effectiveTo: "2026-12-31",
  sourceDocumentRef: "doc:synthetic-contract",
  verifiedAt: "2025-12-01T00:00:00Z",
  verifiedByMembershipId: "reviewer",
  recordedByMembershipId: "recorder",
};

describe("resolvePayerRatePolicy", () => {
  it("returns only an exact verified payer/provider/geography/unit/period match", () => {
    expect(resolvePayerRatePolicy(lookup, [rate])).toMatchObject({ status: "qualified", rate });
  });

  it("keeps FFS and managed-care rates isolated and requires exact geography and unit", () => {
    expect(
      resolvePayerRatePolicy({ ...lookup, canonicalPayerId: "another-payer" }, [rate]).status,
    ).toBe("missing");
    expect(resolvePayerRatePolicy({ ...lookup, localityCode: "" }, [rate]).status).toBe("missing");
    expect(resolvePayerRatePolicy({ ...lookup, localityCode: "   " }, [rate]).status).toBe(
      "missing",
    );
    expect(resolvePayerRatePolicy({ ...lookup, unitBasis: "per_hour" }, [rate]).status).toBe(
      "missing",
    );
    expect(resolvePayerRatePolicy({ ...lookup, programKind: "oregon_ffs" }, [rate]).status).toBe(
      "missing",
    );
  });

  it("requires verified source evidence, independent reviewer, and the complete date window", () => {
    expect(
      resolvePayerRatePolicy(lookup, [{ ...rate, verificationStatus: "unverified" }]).status,
    ).toBe("unverified");
    expect(
      resolvePayerRatePolicy(lookup, [{ ...rate, verifiedByMembershipId: "recorder" }]).status,
    ).toBe("unverified");
    expect(resolvePayerRatePolicy(lookup, [{ ...rate, effectiveTo: "2026-01-15" }]).status).toBe(
      "missing",
    );
  });

  it.each(["rejected", "expired", "revoked", "superseded"] as const)(
    "ignores a %s row that overlaps the verified row instead of calling it ambiguous",
    (verificationStatus) => {
      const terminal = { ...rate, id: "rate-old", verificationStatus };
      expect(resolvePayerRatePolicy(lookup, [terminal, rate])).toMatchObject({
        status: "qualified",
        rate,
      });
      expect(resolvePayerRatePolicy(lookup, [rate, terminal])).toMatchObject({
        status: "qualified",
        rate,
      });
    },
  );

  it("still reports a lone terminal row as unverified, never as missing or qualified", () => {
    for (const verificationStatus of ["rejected", "expired", "revoked", "superseded"] as const) {
      expect(resolvePayerRatePolicy(lookup, [{ ...rate, verificationStatus }])).toMatchObject({
        status: "unverified",
        rate: null,
      });
    }
  });

  it("stays ambiguous for two live rows, and for a pending row beside a verified one", () => {
    expect(
      resolvePayerRatePolicy(lookup, [
        rate,
        { ...rate, id: "rate-new", verificationStatus: "pending" },
      ]).status,
    ).toBe("ambiguous");
    expect(
      resolvePayerRatePolicy(lookup, [
        rate,
        { ...rate, id: "rate-new", verificationStatus: "superseded" },
        { ...rate, id: "rate-dup" },
      ]).status,
    ).toBe("ambiguous");
  });

  it("rejects duplicate conflicts and missing required policy inputs", () => {
    expect(resolvePayerRatePolicy(lookup, [rate, { ...rate, id: "rate-2" }]).status).toBe(
      "ambiguous",
    );
    expect(resolvePayerRatePolicy({ ...lookup, chargeCeilingRequired: true }, [rate]).status).toBe(
      "unsupported",
    );
    expect(
      resolvePayerRatePolicy({ ...lookup, qualityReportingRequired: true }, [rate]).status,
    ).toBe("unsupported");
    expect(
      resolvePayerRatePolicy(
        {
          ...lookup,
          qualityReportingRequired: true,
          providerQualityReportingStatus: "does_not_meet",
          providerQualityReportingVerified: true,
        },
        [rate],
      ).status,
    ).toBe("unsupported");
    expect(
      resolvePayerRatePolicy(
        {
          ...lookup,
          qualityReportingRequired: true,
          providerQualityReportingStatus: "meets",
          providerQualityReportingVerified: true,
        },
        [rate],
      ).status,
    ).toBe("qualified");
  });
});
