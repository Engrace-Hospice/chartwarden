import { describe, expect, it } from "vitest";
import { assessHospicePricing } from "../src/hospice-pricing";
import type { PayerRatePolicyFact } from "../src/payer-rate-policy";

const assessedAt = "2026-03-01T12:00:00.000Z";
const payerContext = {
  organizationId: "synthetic-org",
  providerEntityId: "synthetic-provider",
  canonicalPayerId: "synthetic-payer",
  programKind: "managed_care" as const,
  serviceState: "OR",
  assessedAt,
  qualityReporting: {
    applicability: "required" as const,
    providerStatus: "meets" as const,
    evidenceReference: "evidence:synthetic-quality",
    evidenceVersion: 1,
    verifiedAt: "2026-02-01T00:00:00.000Z",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
  },
};
const rate = (
  id: string,
  rateCents: number,
  effectiveFrom: string,
  effectiveTo: string | null,
  extra: Partial<PayerRatePolicyFact> = {},
): PayerRatePolicyFact => ({
  id,
  organizationId: "synthetic-org",
  providerEntityId: "synthetic-provider",
  canonicalPayerId: "synthetic-payer",
  programKind: "managed_care",
  serviceState: "OR",
  localityCode: "SYNTHETIC-LOCALITY",
  serviceCategory: "RHC",
  unitBasis: "per_day",
  bucketFrom: null,
  bucketTo: null,
  rateCents,
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
  effectiveFrom,
  effectiveTo,
  sourceDocumentRef: `doc:${id}`,
  verifiedAt: "2026-02-01T00:00:00.000Z",
  verifiedByMembershipId: "synthetic-reviewer",
  recordedByMembershipId: "synthetic-recorder",
  createdAt: "2026-02-01T00:00:00.000Z",
  supersedesId: null,
  version: 1,
  ...extra,
});
const quantityEvidence = (
  date: string,
  serviceCategory: "RHC" | "CHC" | "IRC" | "GIP" | "IN_HOME_RESPITE" = "RHC",
  unitBasis: "per_day" | "per_hour" = "per_day",
) => ({
  serviceDate: date,
  providerEntityId: "synthetic-provider",
  serviceCategory,
  unitBasis,
  sourceReference: `evidence:synthetic-quantity-${date}`,
  version: 1,
  verifiedAt: "2026-02-20T00:00:00.000Z",
});
const day = (serviceDate: string, extra: Record<string, unknown> = {}) => ({
  serviceDate,
  serviceCategory: "RHC" as const,
  unitBasis: "per_day" as const,
  localityCode: "SYNTHETIC-LOCALITY",
  localityEvidence: {
    localityCode: "SYNTHETIC-LOCALITY",
    serviceState: "OR",
    sourceReference: "evidence:synthetic-locality",
    version: 1,
    verifiedAt: "2026-02-20T00:00:00.000Z",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
  },
  electionDayEvidence: null,
  inpatientRespiteDayEvidence: null,
  quantity: { unitBasis: "per_day" as const, units: 1 },
  quantityEvidence: quantityEvidence(serviceDate),
  providerUsualCharge: null,
  payerContext,
  ...extra,
});

describe("assessHospicePricing", () => {
  it("splits four daily services at an effective rate change and computes exact synthetic arithmetic", () => {
    const result = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-04",
      assessedAt,
      days: ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"].map((date) => day(date)),
      rates: [
        rate("synthetic-a", 101, "2026-03-01", "2026-03-02"),
        rate("synthetic-b", 203, "2026-03-03", "2026-03-31"),
      ],
    });
    expect(result).toMatchObject({
      status: "fully_resolved",
      coversRequestedPeriod: true,
      reimbursementEstimateTotalCents: 608,
      actualBilledChargeTotalCents: null,
      payerAllowedAmountCents: null,
      actualPaymentCents: null,
      submissionAvailable: false,
    });
    expect(
      result.segments.map(({ serviceFrom, serviceTo, rateEvidence }) => [
        serviceFrom,
        serviceTo,
        rateEvidence?.id,
      ]),
    ).toEqual([
      ["2026-03-01", "2026-03-02", "synthetic-a"],
      ["2026-03-03", "2026-03-04", "synthetic-b"],
    ]);
  });

  it("selects synthetic RHC day 60 and open-ended day 61+ buckets separately", () => {
    const ffsContext = {
      ...payerContext,
      canonicalPayerId: "synthetic-ffs",
      programKind: "oregon_ffs" as const,
    };
    const ffsDay = (serviceDate: string, electionDayNumber: number) => ({
      ...day(serviceDate),
      electionDayEvidence: {
        electionDayNumber,
        serviceDate,
        sourceReference: `evidence:synthetic-election-day-${serviceDate}`,
        version: 1,
        verifiedAt: "2026-02-20T00:00:00.000Z",
      },
      payerContext: ffsContext,
      providerUsualCharge: {
        amountCents: 10_000,
        serviceDate,
        providerEntityId: "synthetic-provider",
        serviceCategory: "RHC" as const,
        sourceReference: `evidence:synthetic-usual-charge-${serviceDate}`,
        version: 1,
        verifiedAt: "2026-02-20T00:00:00.000Z",
      },
    });
    const ffsRate = (id: string, amount: number, bucketFrom: number, bucketTo: number | null) =>
      rate(id, amount, "2026-03-01", null, {
        canonicalPayerId: "synthetic-ffs",
        programKind: "oregon_ffs",
        sourceKind: "oha_ffs_schedule",
        bucketFrom,
        bucketTo,
        chargeCeilingMethod: "lower_of_rate_and_usual_charge",
        chargeCeilingBoundary: "service_day",
      });
    const result = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-02",
      assessedAt,
      days: [ffsDay("2026-03-01", 60), ffsDay("2026-03-02", 61)],
      rates: [
        ffsRate("synthetic-days-1-60", 300, 1, 60),
        ffsRate("synthetic-days-61-plus", 250, 61, null),
      ],
    });
    expect(result.status).toBe("fully_resolved");
    expect(result.reimbursementEstimateTotalCents).toBe(550);
    expect(result.segments.map((segment) => segment.rateEvidence?.id)).toEqual([
      "synthetic-days-1-60",
      "synthetic-days-61-plus",
    ]);
  });

  it("keeps a partial result without a claim-wide total when one segment lacks locality", () => {
    const result = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-02",
      assessedAt,
      days: [day("2026-03-01"), day("2026-03-02", { localityCode: null })],
      rates: [rate("synthetic-rate", 100, "2026-03-01", null)],
    });
    expect(result.status).toBe("partially_resolved");
    expect(result.reimbursementEstimateTotalCents).toBeNull();
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({
      status: "resolved",
      reimbursementEstimateCents: 100,
    });
    expect(result.segments[1]?.reasonCodes).toContain("RATE_LOCALITY_UNRESOLVED");
    expect(result.segments[1]?.reimbursementEstimateCents).toBeNull();
  });

  it("resolves a rate while preserving missing quantity as a partial result", () => {
    const result = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [day("2026-03-01", { quantity: null, quantityEvidence: null })],
      rates: [rate("synthetic-rate", 100, "2026-03-01", null)],
    });
    expect(result.status).toBe("partially_resolved");
    expect(result.segments[0]).toMatchObject({
      status: "partial",
      rateEvidence: { id: "synthetic-rate" },
      reasonCodes: ["CLINICAL_QUANTITY_UNRESOLVED"],
      reimbursementEstimateCents: null,
    });
  });

  it("accepts the initial M6 LOC revision as authoritative daily quantity evidence", () => {
    const result = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [
        day("2026-03-01", {
          quantityEvidence: { ...quantityEvidence("2026-03-01"), version: 0 },
        }),
      ],
      rates: [rate("synthetic-rate", 100, "2026-03-01", null)],
    });
    expect(result.status).toBe("fully_resolved");
    expect(result.reimbursementEstimateTotalCents).toBe(100);
  });

  it("uses explicit synthetic hourly minutes and exact configured rounding", () => {
    const hourlyRate = rate("synthetic-hourly", 90, "2026-03-01", null, {
      serviceCategory: "CHC",
      unitBasis: "per_hour",
      pricingMethod: "per_hour",
      quantityConversionMethod: "hourly_prorated_minutes",
      minimumDurationMethod: "not_required",
      roundingMode: "half_even",
      roundingBoundary: "service_day",
    });
    const hourlyDay = {
      ...day("2026-03-01"),
      serviceCategory: "CHC" as const,
      unitBasis: "per_hour" as const,
      quantity: { unitBasis: "per_hour" as const, clinicalMinutes: 1 },
      quantityEvidence: quantityEvidence("2026-03-01", "CHC", "per_hour"),
    };
    const result = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [hourlyDay],
      rates: [hourlyRate],
    });
    expect(result.status).toBe("fully_resolved");
    expect(result.reimbursementEstimateTotalCents).toBe(2);
    expect(result.segments[0]?.actualBilledChargeCents).toBeNull();
  });

  it("uses a fixed contract unit only with a matching verified unit contract", () => {
    const fixedContractRate = rate("synthetic-fixed-contract", 175, "2026-03-01", null, {
      pricingMethod: "fixed_contract_unit",
    });
    const priced = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [day("2026-03-01")],
      rates: [fixedContractRate],
    });
    expect(priced).toMatchObject({
      status: "fully_resolved",
      reimbursementEstimateTotalCents: 175,
      segments: [{ rateEvidence: { pricingMethod: "fixed_contract_unit" } }],
    });

    const mismatched = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [
        day("2026-03-01", {
          unitBasis: "per_hour",
          quantity: { unitBasis: "per_hour", clinicalMinutes: 60 },
          quantityEvidence: quantityEvidence("2026-03-01", "RHC", "per_hour"),
        }),
      ],
      rates: [fixedContractRate],
    });
    expect(mismatched.status).toBe("unresolved");
    expect(mismatched.reimbursementEstimateTotalCents).toBeNull();
  });

  it("rounds hourly amounts once at the qualified rate segment boundary and preserves all quantity evidence", () => {
    const hourlyRate = rate("synthetic-hourly-segment", 100, "2026-03-01", null, {
      serviceCategory: "CHC",
      unitBasis: "per_hour",
      pricingMethod: "per_hour",
      quantityConversionMethod: "hourly_prorated_minutes",
      minimumDurationMethod: "not_required",
      roundingMode: "half_up",
      roundingBoundary: "segment",
    });
    const hourlyDay = (date: string, ref: string) => ({
      ...day(date),
      serviceCategory: "CHC" as const,
      unitBasis: "per_hour" as const,
      quantity: { unitBasis: "per_hour" as const, clinicalMinutes: 1 },
      quantityEvidence: {
        serviceDate: date,
        providerEntityId: "synthetic-provider",
        serviceCategory: "CHC" as const,
        unitBasis: "per_hour" as const,
        sourceReference: ref,
        version: 1,
        verifiedAt: "2026-02-20T00:00:00.000Z",
      },
    });
    const result = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-02",
      assessedAt,
      days: [
        hourlyDay("2026-03-01", "evidence:minute-a"),
        hourlyDay("2026-03-02", "evidence:minute-b"),
      ],
      rates: [hourlyRate],
    });
    expect(result).toMatchObject({ status: "fully_resolved", reimbursementEstimateTotalCents: 3 });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-02",
      quantity: { unitBasis: "per_hour", clinicalMinutes: 2 },
      quantityEvidence: [
        { sourceReference: "evidence:minute-a" },
        { sourceReference: "evidence:minute-b" },
      ],
      baseReimbursementCents: 3,
      rateEvidence: { roundingBoundary: "segment", methodologyVersion: 1 },
    });
  });

  it("does not guess hourly fractional rounding when policy says exact only", () => {
    const hourlyRate = rate("synthetic-hourly", 30, "2026-03-01", null, {
      serviceCategory: "CHC",
      unitBasis: "per_hour",
      pricingMethod: "per_hour",
      quantityConversionMethod: "hourly_prorated_minutes",
      minimumDurationMethod: "not_required",
      roundingMode: "exact_only",
      roundingBoundary: "service_day",
    });
    const result = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [
        {
          ...day("2026-03-01"),
          serviceCategory: "CHC",
          unitBasis: "per_hour",
          quantity: { unitBasis: "per_hour", clinicalMinutes: 1 },
          quantityEvidence: quantityEvidence("2026-03-01", "CHC", "per_hour"),
        },
      ],
      rates: [hourlyRate],
    });
    expect(result.status).toBe("unsupported");
    expect(result.segments[0]?.reasonCodes).toContain("RATE_UNIT_CONVERSION_UNQUALIFIED");
  });

  it("applies an explicit hourly unit conversion and minimum-duration rule", () => {
    const hourlyRate = rate("synthetic-hourly-rule", 100, "2026-03-01", null, {
      serviceCategory: "CHC",
      unitBasis: "per_hour",
      pricingMethod: "per_hour",
      quantityConversionMethod: "hourly_each_hour_or_part",
      minimumDurationMethod: "minimum_minutes",
      minimumClinicalMinutes: 120,
      roundingMode: "not_applicable",
      roundingBoundary: "not_applicable",
    });
    const dayWithMinutes = (clinicalMinutes: number) => ({
      ...day("2026-03-01"),
      serviceCategory: "CHC" as const,
      unitBasis: "per_hour" as const,
      quantity: { unitBasis: "per_hour" as const, clinicalMinutes },
      quantityEvidence: quantityEvidence("2026-03-01", "CHC", "per_hour"),
    });
    const belowMinimum = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [dayWithMinutes(119)],
      rates: [hourlyRate],
    });
    expect(belowMinimum.status).toBe("unsupported");
    expect(belowMinimum.segments[0]?.reasonCodes).toContain("PRICING_MINIMUM_DURATION_NOT_MET");

    const atMinimum = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [dayWithMinutes(121)],
      rates: [hourlyRate],
    });
    expect(atMinimum).toMatchObject({
      status: "fully_resolved",
      reimbursementEstimateTotalCents: 300,
    });
  });

  it("applies only an explicitly evidenced usual-charge ceiling and never calls it a billed charge", () => {
    const result = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [
        day("2026-03-01", {
          providerUsualCharge: {
            amountCents: 80,
            serviceDate: "2026-03-01",
            providerEntityId: "synthetic-provider",
            serviceCategory: "RHC",
            sourceReference: "evidence:synthetic-usual-charge",
            version: 1,
            verifiedAt: "2026-02-20T00:00:00Z",
          },
        }),
      ],
      rates: [
        rate("synthetic-ceiling", 100, "2026-03-01", null, {
          chargeCeilingMethod: "lower_of_rate_and_usual_charge",
          chargeCeilingBoundary: "service_day",
        }),
      ],
    });
    expect(result.status).toBe("fully_resolved");
    expect(result.segments[0]).toMatchObject({
      baseReimbursementCents: 100,
      reimbursementEstimateCents: 80,
      actualBilledChargeCents: null,
      appliedCeilings: [
        { method: "lower_of_rate_and_usual_charge", amountCents: 80, boundary: "service_day" },
      ],
    });
  });

  it("fails closed on missing ceiling evidence and monetary overflow", () => {
    const noCharge = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [day("2026-03-01")],
      rates: [
        rate("synthetic-ceiling", 100, "2026-03-01", null, {
          chargeCeilingMethod: "lower_of_rate_and_usual_charge",
          chargeCeilingBoundary: "service_day",
        }),
      ],
    });
    expect(noCharge.status).toBe("partially_resolved");
    expect(noCharge.reimbursementEstimateTotalCents).toBeNull();
    expect(noCharge.segments[0]?.reasonCodes).toContain("RATE_CHARGE_CEILING_UNRESOLVED");

    const overflow = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [
        day("2026-03-01", { quantity: { unitBasis: "per_day", units: Number.MAX_SAFE_INTEGER } }),
      ],
      rates: [rate("synthetic-overflow", 2_000_000_000, "2026-03-01", null)],
    });
    expect(overflow.status).toBe("unsupported");
    expect(overflow.reimbursementEstimateTotalCents).toBeNull();
  });

  it("returns an unresolved result for a malformed quantity instead of throwing", () => {
    const dailyRate = rate("synthetic-malformed-daily", 100, "2026-03-01", null);
    for (const units of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      const result = assessHospicePricing({
        serviceFrom: "2026-03-01",
        serviceTo: "2026-03-01",
        assessedAt,
        days: [day("2026-03-01", { quantity: { unitBasis: "per_day", units } })],
        rates: [dailyRate],
      });
      expect(result.status).not.toBe("fully_resolved");
      expect(result.reimbursementEstimateTotalCents).toBeNull();
      expect(result.segments[0]?.reasonCodes).toContain("CLINICAL_QUANTITY_UNRESOLVED");
    }

    const hourlyRate = rate("synthetic-malformed-hourly", 100, "2026-03-01", null, {
      serviceCategory: "CHC",
      unitBasis: "per_hour",
      pricingMethod: "per_hour",
      quantityConversionMethod: "hourly_each_hour_or_part",
      minimumDurationMethod: "minimum_minutes",
      minimumClinicalMinutes: 120,
      roundingMode: "not_applicable",
      roundingBoundary: "not_applicable",
    });
    for (const clinicalMinutes of [0, -5, Number.NaN, 90.5, 1441]) {
      const result = assessHospicePricing({
        serviceFrom: "2026-03-01",
        serviceTo: "2026-03-01",
        assessedAt,
        days: [
          {
            ...day("2026-03-01"),
            serviceCategory: "CHC" as const,
            unitBasis: "per_hour" as const,
            quantity: { unitBasis: "per_hour" as const, clinicalMinutes },
            quantityEvidence: quantityEvidence("2026-03-01", "CHC", "per_hour"),
          },
        ],
        rates: [hourlyRate],
      });
      expect(result.status).not.toBe("fully_resolved");
      expect(result.reimbursementEstimateTotalCents).toBeNull();
      expect(result.segments[0]?.reasonCodes).toContain("CLINICAL_QUANTITY_UNRESOLVED");
    }
  });

  it("requires date-bound locality evidence rather than accepting a locality string", () => {
    const unauthenticated = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [day("2026-03-01", { localityEvidence: null })],
      rates: [rate("synthetic-rate", 100, "2026-03-01", null)],
    });
    expect(unauthenticated.status).toBe("unresolved");
    expect(unauthenticated.segments[0]?.reasonCodes).toContain("RATE_LOCALITY_UNRESOLVED");

    const wrongLocality = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [
        day("2026-03-01", {
          localityEvidence: {
            ...day("2026-03-01").localityEvidence!,
            localityCode: "DIFFERENT-SYNTHETIC-LOCALITY",
          },
        }),
      ],
      rates: [rate("synthetic-rate", 100, "2026-03-01", null)],
    });
    expect(wrongLocality.segments[0]?.reasonCodes).toContain("RATE_LOCALITY_UNRESOLVED");
  });

  it("requires source-bound RHC election-day evidence for Oregon FFS bucket selection", () => {
    const ffsContext = {
      ...payerContext,
      canonicalPayerId: "synthetic-ffs",
      programKind: "oregon_ffs" as const,
    };
    const ffsRate = rate("synthetic-ffs-rate", 100, "2026-03-01", null, {
      canonicalPayerId: "synthetic-ffs",
      programKind: "oregon_ffs",
      sourceKind: "oha_ffs_schedule",
      bucketFrom: 1,
      bucketTo: 60,
      chargeCeilingMethod: "lower_of_rate_and_usual_charge",
      chargeCeilingBoundary: "service_day",
    });
    const noEvidence = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [day("2026-03-01", { payerContext: ffsContext })],
      rates: [ffsRate],
    });
    expect(noEvidence.segments[0]?.reasonCodes).toContain("RATE_ELECTION_DAY_UNRESOLVED");

    const wrongServiceDate = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [
        day("2026-03-01", {
          payerContext: ffsContext,
          electionDayEvidence: {
            electionDayNumber: 60,
            serviceDate: "2026-03-02",
            sourceReference: "evidence:synthetic-wrong-day",
            version: 1,
            verifiedAt: "2026-02-20T00:00:00.000Z",
          },
        }),
      ],
      rates: [ffsRate],
    });
    expect(wrongServiceDate.segments[0]?.reasonCodes).toContain("RATE_ELECTION_DAY_UNRESOLVED");
  });

  it("rejects future evidence and payer contexts assessed at a different instant", () => {
    const futureLocality = day("2026-03-01", {
      localityEvidence: {
        ...day("2026-03-01").localityEvidence!,
        verifiedAt: "2026-03-02T00:00:00.000Z",
      },
    });
    const futureResult = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [futureLocality],
      rates: [rate("synthetic-rate", 100, "2026-03-01", null)],
    });
    expect(futureResult.segments[0]?.reasonCodes).toContain("RATE_LOCALITY_UNRESOLVED");

    const mismatchedAssessmentTime = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [
        day("2026-03-01", {
          payerContext: {
            ...payerContext,
            assessedAt: "2026-03-01T12:00:01.000Z",
          },
        }),
      ],
      rates: [rate("synthetic-rate", 100, "2026-03-01", null)],
    });
    expect(mismatchedAssessmentTime.status).toBe("unsupported");
    expect(mismatchedAssessmentTime.reimbursementEstimateTotalCents).toBeNull();
  });

  it("does not price an in-home respite category from a rate row alone", () => {
    const result = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [day("2026-03-01", { serviceCategory: "IN_HOME_RESPITE" })],
      rates: [
        rate("synthetic-respite", 100, "2026-03-01", null, {
          serviceCategory: "IN_HOME_RESPITE",
        }),
      ],
    });
    expect(result.status).toBe("unsupported");
    expect(result.reimbursementEstimateTotalCents).toBeNull();
  });

  it("requires verified consecutive inpatient-respite day evidence and blocks day six", () => {
    const respiteRate = rate("synthetic-irc", 150, "2026-03-01", null, {
      serviceCategory: "IRC",
    });
    const respiteDay = (consecutiveDayNumber: number | null, sourceVersion = 1) =>
      day("2026-03-01", {
        serviceCategory: "IRC",
        quantityEvidence: quantityEvidence("2026-03-01", "IRC"),
        inpatientRespiteDayEvidence:
          consecutiveDayNumber === null
            ? null
            : {
                consecutiveDayNumber,
                serviceDate: "2026-03-01",
                episodeReference: "episode:synthetic-irc",
                sourceReference: "evidence:synthetic-irc-sequence",
                version: sourceVersion,
                verifiedAt: "2026-02-20T00:00:00.000Z",
              },
      });
    const missing = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [respiteDay(null)],
      rates: [respiteRate],
    });
    expect(missing.status).toBe("partially_resolved");
    expect(missing.segments[0]?.reasonCodes).toContain("INPATIENT_RESPITE_SEQUENCE_UNRESOLVED");

    const fifthDay = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [respiteDay(5)],
      rates: [respiteRate],
    });
    expect(fifthDay).toMatchObject({
      status: "fully_resolved",
      reimbursementEstimateTotalCents: 150,
    });

    const initialM37Version = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [respiteDay(3, 0)],
      rates: [respiteRate],
    });
    expect(initialM37Version).toMatchObject({
      status: "fully_resolved",
      segments: [
        {
          rateEvidence: {
            inpatientRespiteEvidenceVersion: 0,
            inpatientRespiteConsecutiveDayNumber: 3,
          },
        },
      ],
    });

    const sixthDay = assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt,
      days: [respiteDay(6)],
      rates: [respiteRate],
    });
    expect(sixthDay.status).toBe("unsupported");
    expect(sixthDay.segments[0]?.reasonCodes).toContain("INPATIENT_RESPITE_LIMIT_EXCEEDED");
    expect(sixthDay.reimbursementEstimateTotalCents).toBeNull();
  });
});
