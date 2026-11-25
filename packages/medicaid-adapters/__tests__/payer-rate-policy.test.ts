import { describe, expect, it } from "vitest";
import {
  type PayerRatePolicyFact,
  resolvePayerRatePolicy,
  resolvePayerRatePolicySegments,
} from "../src/payer-rate-policy";

const lookup = {
  organizationId: "org",
  providerEntityId: "provider",
  canonicalPayerId: "payer-cco",
  programKind: "managed_care" as const,
  serviceState: "OR",
  localityCode: "CONTRACT-LOCALITY-1",
  serviceCategory: "RHC" as const,
  unitBasis: "per_day" as const,
  electionDayNumber: null,
  serviceFrom: "2026-01-01",
  serviceTo: "2026-01-31",
  assessedAt: "2026-02-01T00:00:00.000Z",
  qualityReporting: {
    applicability: "required" as const,
    providerStatus: "meets" as const,
    evidenceReference: "evidence:quality-status",
    evidenceVersion: 2,
    verifiedAt: "2025-12-01T00:00:00.000Z",
    effectiveFrom: "2025-01-01",
    effectiveTo: null,
  },
};
const rate: PayerRatePolicyFact = {
  id: "rate-1",
  organizationId: "org",
  providerEntityId: "provider",
  canonicalPayerId: "payer-cco",
  programKind: "managed_care",
  serviceState: "OR",
  localityCode: "CONTRACT-LOCALITY-1",
  serviceCategory: "RHC",
  unitBasis: "per_day",
  bucketFrom: null,
  bucketTo: null,
  rateCents: 10000,
  chargeCeilingCents: null,
  pricingMethod: "per_day",
  quantityConversionMethod: "daily_units",
  minimumDurationMethod: "not_applicable",
  minimumClinicalMinutes: null,
  methodologyVersion: 1,
  roundingMode: "not_applicable",
  roundingBoundary: "not_applicable",
  chargeCeilingMethod: "none",
  chargeCeilingBoundary: "not_applicable",
  qualityReportingApplicability: "required",
  qualityReportingStatus: "meets",
  sourceKind: "cco_contract",
  verificationStatus: "verified",
  effectiveFrom: "2026-01-01",
  effectiveTo: "2026-12-31",
  sourceDocumentRef: "doc:synthetic-contract",
  verifiedAt: "2025-12-01T00:00:00Z",
  verifiedByMembershipId: "reviewer",
  recordedByMembershipId: "recorder",
  createdAt: "2025-12-01T00:00:00Z",
  supersedesId: null,
  version: 1,
};

describe("resolvePayerRatePolicy", () => {
  it("returns only an exact verified payer/provider/geography/unit/period match", () => {
    expect(resolvePayerRatePolicy(lookup, [rate])).toMatchObject({ status: "qualified", rate });
  });

  it("keeps FFS and managed-care rates isolated and requires exact identity", () => {
    expect(
      resolvePayerRatePolicy({ ...lookup, canonicalPayerId: "another-payer" }, [rate]).status,
    ).toBe("missing");
    expect(resolvePayerRatePolicy({ ...lookup, organizationId: "other-org" }, [rate]).status).toBe(
      "missing",
    );
    expect(
      resolvePayerRatePolicy({ ...lookup, providerEntityId: "other-provider" }, [rate]).status,
    ).toBe("missing");
    expect(resolvePayerRatePolicy({ ...lookup, localityCode: null }, [rate]).reasonCode).toBe(
      "RATE_LOCALITY_UNRESOLVED",
    );
    expect(resolvePayerRatePolicy({ ...lookup, serviceCategory: "CHC" }, [rate]).status).toBe(
      "missing",
    );
    expect(resolvePayerRatePolicy({ ...lookup, unitBasis: "per_hour" }, [rate]).status).toBe(
      "missing",
    );
    expect(resolvePayerRatePolicy({ ...lookup, programKind: "oregon_ffs" }, [rate]).status).toBe(
      "missing",
    );
  });

  it("requires verified source and quality evidence at the explicit assessment instant", () => {
    expect(
      resolvePayerRatePolicy(lookup, [{ ...rate, verificationStatus: "unverified" }]).status,
    ).toBe("unverified");
    expect(
      resolvePayerRatePolicy(lookup, [{ ...rate, verifiedByMembershipId: "recorder" }]).status,
    ).toBe("unverified");
    expect(
      resolvePayerRatePolicy(
        {
          ...lookup,
          assessedAt: "2025-11-30T00:00:00Z",
          qualityReporting: { ...lookup.qualityReporting, verifiedAt: "2025-11-01T00:00:00Z" },
        },
        [rate],
      ).status,
    ).toBe("missing");
    expect(
      resolvePayerRatePolicy(
        { ...lookup, qualityReporting: { ...lookup.qualityReporting, providerStatus: "unknown" } },
        [rate],
      ).reasonCode,
    ).toBe("RATE_QUALITY_STATUS_UNVERIFIED");
    expect(
      resolvePayerRatePolicy(
        {
          ...lookup,
          qualityReporting: {
            ...lookup.qualityReporting,
            effectiveFrom: "2026-01-15",
            effectiveTo: "2026-01-31",
          },
        },
        [rate],
      ).reasonCode,
    ).toBe("RATE_QUALITY_STATUS_UNVERIFIED");
  });

  it("selects a legitimate quality variant without treating its sibling as ambiguity", () => {
    const noncompliant = {
      ...rate,
      id: "rate-noncompliant",
      qualityReportingStatus: "does_not_meet" as const,
      rateCents: 9000,
    };
    expect(resolvePayerRatePolicy(lookup, [rate, noncompliant])).toMatchObject({
      status: "qualified",
      rate,
    });
    const selected = resolvePayerRatePolicy(
      {
        ...lookup,
        qualityReporting: { ...lookup.qualityReporting, providerStatus: "does_not_meet" },
      },
      [rate, noncompliant],
    );
    expect(selected).toMatchObject({ status: "qualified", rate: noncompliant });
  });

  it("reports when only a different verified quality variant is effective", () => {
    const noncompliant = {
      ...rate,
      id: "rate-noncompliant",
      qualityReportingStatus: "does_not_meet" as const,
      rateCents: 9000,
    };
    expect(resolvePayerRatePolicy(lookup, [noncompliant])).toMatchObject({
      status: "missing",
      reasonCode: "RATE_QUALITY_VARIANT_UNAVAILABLE",
    });
  });

  it.each(["rejected", "expired", "revoked", "superseded"] as const)(
    "does not qualify a %s row",
    (verificationStatus) => {
      expect(resolvePayerRatePolicy(lookup, [{ ...rate, verificationStatus }])).toMatchObject({
        status: "unverified",
        rate: null,
      });
    },
  );

  it("detects partial overlaps and adjacent rate periods as explicit segments", () => {
    const short = { ...rate, id: "short", effectiveFrom: "2026-01-10", effectiveTo: "2026-01-15" };
    const overlapsLong = resolvePayerRatePolicySegments(lookup, [rate, short]);
    expect(overlapsLong.find((segment) => segment.from === "2026-01-10")).toMatchObject({
      status: "ambiguous",
      reasonCode: "MEDICAID_RATE_POLICY_AMBIGUOUS",
    });

    const adjacent = [
      { ...rate, id: "jan-a", effectiveTo: "2026-01-15" },
      { ...rate, id: "jan-b", effectiveFrom: "2026-01-16", effectiveTo: null },
    ];
    expect(resolvePayerRatePolicy(lookup, adjacent)).toMatchObject({ status: "partial" });
    expect(resolvePayerRatePolicySegments(lookup, adjacent)).toHaveLength(2);
  });

  it("uses inclusive first and last effective dates and reports gaps", () => {
    const onlyMid = { ...rate, effectiveFrom: "2026-01-02", effectiveTo: "2026-01-30" };
    const segments = resolvePayerRatePolicySegments(lookup, [onlyMid]);
    expect(segments[0]).toMatchObject({
      from: "2026-01-01",
      to: "2026-01-01",
      reasonCode: "RATE_EFFECTIVE_PERIOD_GAP",
    });
    expect(segments[1]).toMatchObject({
      from: "2026-01-02",
      to: "2026-01-30",
      status: "qualified",
    });
    expect(segments[2]).toMatchObject({
      from: "2026-01-31",
      to: "2026-01-31",
      reasonCode: "RATE_EFFECTIVE_PERIOD_GAP",
    });
  });

  it("rejects invalid dates and nonqualified hourly boundary/ceiling combinations", () => {
    expect(resolvePayerRatePolicy({ ...lookup, serviceFrom: "2026-02-30" }, [rate]).status).toBe(
      "unsupported",
    );
    const hourly = {
      ...rate,
      serviceCategory: "CHC" as const,
      unitBasis: "per_hour" as const,
      pricingMethod: "per_hour" as const,
      quantityConversionMethod: "hourly_prorated_minutes" as const,
      minimumDurationMethod: "not_required" as const,
      minimumClinicalMinutes: null,
      roundingMode: "half_up" as const,
      roundingBoundary: "segment" as const,
      chargeCeilingMethod: "contract_maximum" as const,
      chargeCeilingBoundary: "service_day" as const,
      chargeCeilingCents: 500,
    };
    expect(
      resolvePayerRatePolicy({ ...lookup, serviceCategory: "CHC", unitBasis: "per_hour" }, [
        hourly,
      ]),
    ).toMatchObject({
      status: "unsupported",
      reasonCode: "PRICING_METHOD_UNSUPPORTED",
    });
  });

  it("supports an open-ended RHC bucket and requires authoritative election-day evidence", () => {
    const ffs = {
      ...lookup,
      programKind: "oregon_ffs" as const,
      canonicalPayerId: "payer-ffs",
      electionDayNumber: 61,
    };
    const day1to60 = {
      ...rate,
      programKind: "oregon_ffs" as const,
      canonicalPayerId: "payer-ffs",
      sourceKind: "oha_ffs_schedule" as const,
      bucketFrom: 1,
      bucketTo: 60,
      qualityReportingApplicability: "required" as const,
      chargeCeilingMethod: "lower_of_rate_and_usual_charge" as const,
      chargeCeilingBoundary: "service_day" as const,
    };
    const day61Plus = { ...day1to60, id: "rate-61", bucketFrom: 61, bucketTo: null };
    expect(resolvePayerRatePolicy(ffs, [day1to60, day61Plus])).toMatchObject({
      status: "qualified",
      rate: day61Plus,
    });
    expect(
      resolvePayerRatePolicy({ ...ffs, electionDayNumber: null }, [day1to60, day61Plus]).reasonCode,
    ).toBe("RATE_ELECTION_DAY_UNRESOLVED");
  });

  it("requires explicit OHA CHC hour-or-part and minimum-duration methodology", () => {
    const ohaChc: PayerRatePolicyFact = {
      ...rate,
      id: "oha-chc",
      programKind: "oregon_ffs",
      canonicalPayerId: "payer-ffs",
      sourceKind: "oha_ffs_schedule",
      serviceCategory: "CHC",
      unitBasis: "per_hour",
      pricingMethod: "per_hour",
      quantityConversionMethod: "hourly_each_hour_or_part",
      minimumDurationMethod: "minimum_minutes",
      minimumClinicalMinutes: 480,
      chargeCeilingMethod: "lower_of_rate_and_usual_charge",
      chargeCeilingBoundary: "service_day",
      roundingMode: "not_applicable",
      roundingBoundary: "not_applicable",
    };
    const chcLookup = {
      ...lookup,
      canonicalPayerId: "payer-ffs",
      programKind: "oregon_ffs" as const,
      serviceCategory: "CHC" as const,
      unitBasis: "per_hour" as const,
    };
    expect(resolvePayerRatePolicy(chcLookup, [ohaChc])).toMatchObject({
      status: "qualified",
      rate: ohaChc,
    });
    expect(
      resolvePayerRatePolicy(chcLookup, [{ ...ohaChc, minimumClinicalMinutes: 479 }]),
    ).toMatchObject({
      status: "unsupported",
      reasonCode: "PRICING_METHOD_UNSUPPORTED",
    });
  });

  it("keeps superseded versions visible as-of an earlier assessment only", () => {
    const correction = {
      ...rate,
      id: "rate-v2",
      supersedesId: rate.id,
      version: 2,
      createdAt: "2026-01-20T00:00:00Z",
      effectiveTo: null,
    };
    expect(
      resolvePayerRatePolicy(
        {
          ...lookup,
          serviceFrom: "2026-01-01",
          serviceTo: "2026-01-31",
          assessedAt: "2026-01-10T00:00:00Z",
        },
        [rate, correction],
      ),
    ).toMatchObject({ status: "qualified", rate });
    expect(resolvePayerRatePolicy(lookup, [rate, correction])).toMatchObject({
      status: "qualified",
      rate: correction,
    });
  });

  it("does not revive an earlier verified rate after a newer correction is revoked", () => {
    const revokedCorrection = {
      ...rate,
      id: "rate-v2-revoked",
      supersedesId: rate.id,
      version: 2,
      createdAt: "2026-01-20T00:00:00Z",
      verificationStatus: "revoked" as const,
    };
    expect(resolvePayerRatePolicy(lookup, [rate, revokedCorrection])).toMatchObject({
      status: "unverified",
      rate: null,
      reasonCode: "RATE_SOURCE_UNVERIFIED",
    });
  });

  it("does not revive an open-ended predecessor outside a correction's narrowed effective period", () => {
    const correction = {
      ...rate,
      id: "rate-v2-narrowed",
      supersedesId: rate.id,
      version: 2,
      createdAt: "2026-01-20T00:00:00Z",
      verifiedAt: "2026-01-20T00:00:00Z",
      effectiveTo: "2026-01-15",
    };
    const segments = resolvePayerRatePolicySegments(lookup, [rate, correction]);
    expect(segments[0]).toMatchObject({
      from: "2026-01-01",
      to: "2026-01-15",
      status: "qualified",
    });
    expect(segments[1]).toMatchObject({
      from: "2026-01-16",
      to: "2026-01-31",
      status: "missing",
      reasonCode: "RATE_EFFECTIVE_PERIOD_GAP",
    });
  });

  it("does not let a rejected correction close a verified predecessor", () => {
    const rejectedCorrection = {
      ...rate,
      id: "rate-v2-rejected",
      supersedesId: rate.id,
      version: 2,
      createdAt: "2026-01-20T00:00:00Z",
      verificationStatus: "rejected" as const,
    };
    expect(resolvePayerRatePolicy(lookup, [rate, rejectedCorrection])).toMatchObject({
      status: "qualified",
      rate,
    });
  });
});
