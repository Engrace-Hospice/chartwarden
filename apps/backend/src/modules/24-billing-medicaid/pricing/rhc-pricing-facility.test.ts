import type { PayerRatePolicyFact } from "@chartwarden/medicaid-adapters";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  assertSupportedRhcPricingSnapshotPayload,
  canonicalPricingSnapshotJson,
  resolveRhcAssistedLivingResidence,
  resolveRhcDailyPricingPlan,
} from "./rhc-pricing-snapshot";

type PlanInput = Parameters<typeof resolveRhcDailyPricingPlan>[0];
type Evidence = Exclude<PlanInput["evidence"], readonly unknown[]>;

const ORG = "00000000-0000-4000-8000-000000000001";
const PROVIDER = "00000000-0000-4000-8000-000000000002";
const PATIENT = "00000000-0000-4000-8000-000000000003";
const ADMISSION = "00000000-0000-4000-8000-000000000004";
const PAYER = "00000000-0000-4000-8000-000000000005";
const FACILITY = "00000000-0000-4000-8000-000000000006";
const ADDRESS = "00000000-0000-4000-8000-000000000007";

const SCOPE: PlanInput["scope"] = {
  organizationId: ORG,
  providerEntityId: PROVIDER,
  patientId: PATIENT,
  admissionId: ADMISSION,
  admissionVersion: 3,
  canonicalPayerId: PAYER,
  programKind: "managed_care",
  serviceState: "OR",
  serviceFrom: "2026-11-01",
  serviceTo: "2026-11-05",
  assessedAt: "2026-11-10T12:00:00.000Z",
};

const Q5001_EVIDENCE = {
  id: "evidence-q5001",
  organizationId: ORG,
  providerEntityId: PROVIDER,
  patientId: PATIENT,
  admissionId: ADMISSION,
  admissionVersion: 3,
  canonicalPayerId: PAYER,
  programKind: "managed_care",
  serviceState: "OR",
  localityCode: "SYNTHETIC-LOCALITY",
  localityEvidenceReference: "evidence:locality",
  localityEvidenceVersion: 1,
  qualityReportingApplicability: "required",
  qualityReportingStatus: "meets",
  qualityEvidenceReference: "evidence:quality",
  qualityEvidenceVersion: 1,
  serviceCategory: "RHC",
  quantityPolicy: "active_rhc_loc_calendar_day",
  quantityEvidenceOwner: "m6_level_of_care_period",
  billingUnit: "daily",
  revenueCode: "0651",
  hcpcsCode: "Q5001",
  codingProfile: "local_draft_only",
  codingEvidenceReference: "evidence:coding",
  codingEvidenceVersion: 1,
  billedChargeCentsPerUnit: 25_000,
  chargeEvidenceReference: "evidence:charge",
  chargeEvidenceVersion: 1,
  verificationStatus: "verified",
  effectiveFrom: "2026-10-01",
  effectiveTo: null,
  sourceDocumentReference: "doc:evidence",
  verifiedAt: new Date("2026-10-02T00:00:00.000Z"),
  verifiedByMembershipId: "00000000-0000-4000-8000-0000000000a1",
  recordedByMembershipId: "00000000-0000-4000-8000-0000000000a2",
  supersedesId: null,
  version: 1,
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
} as Evidence;
const Q5002_EVIDENCE = { ...Q5001_EVIDENCE, id: "evidence-q5002", hcpcsCode: "Q5002" } as Evidence;

const RATE: PayerRatePolicyFact = {
  id: "rate-1",
  organizationId: ORG,
  providerEntityId: PROVIDER,
  canonicalPayerId: PAYER,
  programKind: "managed_care",
  serviceState: "OR",
  localityCode: "SYNTHETIC-LOCALITY",
  serviceCategory: "RHC",
  unitBasis: "per_day",
  bucketFrom: null,
  bucketTo: null,
  rateCents: 20_000,
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
  verifiedAt: "2026-09-01T00:00:00.000Z",
  verifiedByMembershipId: "00000000-0000-4000-8000-0000000000a1",
  recordedByMembershipId: "00000000-0000-4000-8000-0000000000a2",
  createdAt: "2026-09-01T00:00:00.000Z",
  supersedesId: null,
  version: 1,
};
const segmentCeiling = (cents: number): PayerRatePolicyFact => ({
  ...RATE,
  chargeCeilingMethod: "contract_maximum",
  chargeCeilingBoundary: "segment",
  chargeCeilingCents: cents,
});

const OPEN_RHC_PERIOD = {
  id: "loc-1",
  version: 0,
  levelOfCare: "routine_home_care" as const,
  effectiveAt: new Date("2026-10-15T00:00:00.000Z"),
  endedAt: null,
  updatedAt: new Date("2026-10-15T00:00:00.000Z"),
};

const HOME_SPAN = {
  addressId: ADDRESS,
  kind: "home",
  facilityId: null,
  effectiveFrom: "2026-10-01",
  effectiveTo: null,
} as const;
const ALF_SPAN = {
  addressId: ADDRESS,
  kind: "facility",
  facilityId: FACILITY,
  effectiveFrom: "2026-10-01",
  effectiveTo: null,
} as const;
const ALF_KINDS: ReadonlyMap<string, string> = new Map([[FACILITY, "alf"]]);

const planInput = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  scope: SCOPE,
  evidence: Q5002_EVIDENCE,
  locPeriods: [OPEN_RHC_PERIOD],
  rates: [RATE],
  residenceSpans: [ALF_SPAN],
  facilityKinds: ALF_KINDS,
  ...overrides,
});

const resolvedLines = (input: PlanInput) => {
  const plan = resolveRhcDailyPricingPlan(input);
  if (plan.status !== "resolved") throw new Error(`expected resolved, got ${plan.reasonCode}`);
  return plan.lines;
};

describe("resolveRhcAssistedLivingResidence", () => {
  const resolve = (
    spans: PlanInput["residenceSpans"],
    kinds: ReadonlyMap<string, string> = ALF_KINDS,
  ) => resolveRhcAssistedLivingResidence(spans, kinds, "2026-11-01", "2026-11-05");

  it("accepts one facility residence that covers the window and is an assisted-living facility", () => {
    expect(resolve([ALF_SPAN])).toEqual({
      status: "resolved",
      span: ALF_SPAN,
      facilityKind: "alf",
    });
  });

  it.each([
    ["no residence", [], ALF_KINDS, "unresolved", "RHC_SERVICE_RESIDENCE_MISSING"],
    [
      "two residences",
      [ALF_SPAN, ALF_SPAN],
      ALF_KINDS,
      "ambiguous",
      "RHC_SERVICE_RESIDENCE_AMBIGUOUS",
    ],
    [
      "a span that ends inside the window",
      [{ ...ALF_SPAN, effectiveTo: "2026-11-03" }],
      ALF_KINDS,
      "unresolved",
      "RHC_SERVICE_RESIDENCE_PERIOD_INCOMPLETE",
    ],
    ["a home", [HOME_SPAN], ALF_KINDS, "unsupported", "RHC_Q5002_REQUIRES_FACILITY_RESIDENCE"],
    [
      "a facility with no M40 kind (merged, deactivated or unknown)",
      [ALF_SPAN],
      new Map<string, string>(),
      "unresolved",
      "RHC_FACILITY_KIND_UNRESOLVED",
    ],
    [
      "another facility kind",
      [ALF_SPAN],
      new Map([[FACILITY, "snf"]]),
      "unsupported",
      "RHC_Q5002_REQUIRES_ASSISTED_LIVING",
    ],
  ] as const)("refuses %s", (_name, spans, kinds, status, reasonCode) => {
    expect(resolve(spans, kinds)).toEqual({ status, reasonCode });
  });
});

describe("daily RHC plan by billing code and residence", () => {
  it("prices Q5002 evidence on an assisted-living residence as a v2 snapshot bound to the claimed days", () => {
    const [line, ...rest] = resolvedLines(planInput());
    expect(rest).toHaveLength(0);
    expect(line).toMatchObject({
      snapshotSchemaVersion: 2,
      hcpcsCode: "Q5002",
      revenueCode: "0651",
      units: 5,
      baseReimbursementCents: 100_000,
    });
    expect(line!.integrityFacts).toMatchObject({
      schemaVersion: 2,
      localBillingProfile: "rhc_assisted_living_q5002_daily_v1",
      serviceLocation: {
        patientAddressId: ADDRESS,
        kind: "facility",
        facilityId: FACILITY,
        facilityKind: "alf",
        effectiveFrom: "2026-11-01",
        effectiveTo: "2026-11-05",
      },
    });
  });

  it("is not staled by the residence closing after the claimed days", () => {
    const open = resolvedLines(planInput())[0]!.integrityFacts;
    const movedOutLater = resolvedLines(
      planInput({ residenceSpans: [{ ...ALF_SPAN, effectiveTo: "2026-11-20" }] }),
    )[0]!.integrityFacts;
    expect(canonicalPricingSnapshotJson(movedOutLater)).toBe(canonicalPricingSnapshotJson(open));
  });

  it("keeps Q5001 on a home residence as a v1 snapshot without a local billing profile", () => {
    const [line] = resolvedLines(
      planInput({
        evidence: Q5001_EVIDENCE,
        residenceSpans: [HOME_SPAN],
        facilityKinds: new Map(),
      }),
    );
    expect(line).toMatchObject({ snapshotSchemaVersion: 1, hcpcsCode: "Q5001" });
    expect(line!.integrityFacts).not.toHaveProperty("localBillingProfile");
    expect(line!.integrityFacts).toMatchObject({
      serviceLocation: { kind: "home", facilityId: null, effectiveFrom: "2026-11-01" },
    });
  });

  it.each([
    [
      "Q5001 evidence with a facility residence",
      { evidence: Q5001_EVIDENCE },
      { status: "unsupported", reasonCode: "RHC_Q5001_REQUIRES_HOME_RESIDENCE" },
    ],
    [
      "Q5002 evidence with a home residence",
      { residenceSpans: [HOME_SPAN] },
      { status: "unsupported", reasonCode: "RHC_Q5002_REQUIRES_FACILITY_RESIDENCE" },
    ],
    [
      "Q5002 evidence with a non-assisted-living facility",
      { facilityKinds: new Map([[FACILITY, "snf"]]) },
      { status: "unsupported", reasonCode: "RHC_Q5002_REQUIRES_ASSISTED_LIVING" },
    ],
    [
      "Q5002 evidence when no facility kind could be read",
      { facilityKinds: new Map<string, string>() },
      { status: "unresolved", reasonCode: "RHC_FACILITY_KIND_UNRESOLVED" },
    ],
    [
      "evidence for a local code outside the supported profiles",
      { evidence: { ...Q5001_EVIDENCE, hcpcsCode: "Q5003" } as Evidence },
      { status: "unsupported", reasonCode: "RHC_DAILY_LOCAL_PROFILE_UNSUPPORTED" },
    ],
  ] as const)("refuses %s", (_name, overrides, expected) => {
    expect(resolveRhcDailyPricingPlan(planInput(overrides))).toEqual(expected);
  });

  it("prices a Q5001 -> Q5002 evidence transition as a v1 line then a v2 line on its own residence", () => {
    const lines = resolvedLines(
      planInput({
        evidence: [
          { ...Q5001_EVIDENCE, id: "evidence-home", effectiveTo: "2026-11-02" } as Evidence,
          { ...Q5002_EVIDENCE, id: "evidence-alf", effectiveFrom: "2026-11-03" } as Evidence,
        ],
        residenceSpans: [
          { ...HOME_SPAN, effectiveTo: "2026-11-02" },
          { ...ALF_SPAN, effectiveFrom: "2026-11-03" },
        ],
      }),
    );
    expect(
      lines.map((l) => [l.snapshotSchemaVersion, l.hcpcsCode, l.serviceFrom, l.serviceTo, l.units]),
    ).toEqual([
      [1, "Q5001", "2026-11-01", "2026-11-02", 2],
      [2, "Q5002", "2026-11-03", "2026-11-05", 3],
    ]);
  });
});

describe("segment contract ceiling across evidence heads", () => {
  const twoHeads = (rate: PayerRatePolicyFact) =>
    planInput({
      evidence: [
        { ...Q5001_EVIDENCE, id: "evidence-a", effectiveTo: "2026-11-02" } as Evidence,
        {
          ...Q5001_EVIDENCE,
          id: "evidence-b",
          effectiveFrom: "2026-11-03",
          billedChargeCentsPerUnit: 30_000,
        } as Evidence,
      ],
      residenceSpans: [HOME_SPAN],
      facilityKinds: new Map(),
      rates: [rate],
    });
  const estimates = (rate: PayerRatePolicyFact) =>
    resolvedLines(twoHeads(rate)).map((l) => l.reimbursementEstimateCents);

  it("applies the ceiling once to the whole segment, not once per evidence head", () => {
    // 2 days + 3 days at 20_000 = 100_000 base; a 90_000 ceiling is shared, never doubled.
    expect(estimates(segmentCeiling(90_000))).toEqual([36_000, 54_000]);
  });

  it("allocates the rounding remainder by largest fractional share, so the total is exactly the ceiling", () => {
    // 99_999 * 40_000 / 100_000 = 39_999.6 and 59_999.4: the spare cent goes to the larger remainder.
    expect(estimates(segmentCeiling(99_999))).toEqual([40_000, 59_999]);
  });

  it("never allocates a line more than its own base amount, and ties go to the earlier line", () => {
    // Three one-day heads of 20_000 each under a 59_999 ceiling: floors are 19_999, two spare cents.
    const threeHeads = planInput({
      scope: { ...SCOPE, serviceTo: "2026-11-03" },
      evidence: [
        { ...Q5001_EVIDENCE, id: "evidence-a", effectiveTo: "2026-11-01" } as Evidence,
        {
          ...Q5001_EVIDENCE,
          id: "evidence-b",
          effectiveFrom: "2026-11-02",
          effectiveTo: "2026-11-02",
        } as Evidence,
        { ...Q5001_EVIDENCE, id: "evidence-c", effectiveFrom: "2026-11-03" } as Evidence,
      ],
      residenceSpans: [HOME_SPAN],
      facilityKinds: new Map(),
      rates: [segmentCeiling(59_999)],
    });
    const lines = resolvedLines(threeHeads);
    expect(lines.map((l) => l.reimbursementEstimateCents)).toEqual([20_000, 20_000, 19_999]);
    for (const line of lines) {
      expect(line.reimbursementEstimateCents).toBeLessThanOrEqual(line.baseReimbursementCents);
    }
  });

  it("leaves the base amounts alone when the ceiling does not bind", () => {
    expect(estimates(segmentCeiling(150_000))).toEqual([40_000, 60_000]);
  });

  it("keeps the engine's ceiling record, with its evidence reference, on every line", () => {
    for (const line of resolvedLines(twoHeads(segmentCeiling(90_000)))) {
      expect(line.appliedCeilings).toHaveLength(1);
      expect(line.appliedCeilings[0]).toMatchObject({
        method: "contract_maximum",
        boundary: "segment",
        amountCents: 90_000,
        evidenceReference: "doc:synthetic-contract",
        evidenceVersion: 1,
      });
      expect(line.integrityFacts.reimbursementEstimateCents).toBe(line.reimbursementEstimateCents);
    }
  });

  it("does not join separate M6 level-of-care periods: each is its own capped segment", () => {
    // One evidence head, two RHC periods (days 1-2, days 3-5), a 50_000 ceiling per segment.
    const lines = resolvedLines(
      planInput({
        evidence: Q5001_EVIDENCE,
        residenceSpans: [HOME_SPAN],
        facilityKinds: new Map(),
        rates: [segmentCeiling(50_000)],
        locPeriods: [
          { ...OPEN_RHC_PERIOD, endedAt: new Date("2026-11-03T00:00:00.000Z") },
          { ...OPEN_RHC_PERIOD, id: "loc-2", effectiveAt: new Date("2026-11-03T00:00:00.000Z") },
        ],
      }),
    );
    expect(lines.map((l) => [l.locPeriodId, l.reimbursementEstimateCents])).toEqual([
      ["loc-1", 40_000],
      ["loc-2", 50_000],
    ]);
  });
});

describe("assertSupportedRhcPricingSnapshotPayload", () => {
  const COMMON = {
    assessmentTimestamp: "2026-11-10T12:00:00.000Z",
    organizationId: ORG,
    providerEntityId: PROVIDER,
    patientId: PATIENT,
    admissionId: ADMISSION,
    medicaidClaimId: "claim-1",
    claimLineId: "line-1",
    billingEvidenceId: "evidence-1",
    payerRatePolicyId: "rate-1",
    postingAuthorized: false,
    levelOfCare: "RHC",
    programKind: "managed_care",
  };
  const V1 = {
    ...COMMON,
    schemaVersion: 1,
    hcpcsCode: "Q5001",
    serviceLocation: { patientAddressId: ADDRESS, kind: "home", facilityId: null },
  };
  const V2 = {
    ...COMMON,
    schemaVersion: 2,
    hcpcsCode: "Q5002",
    localBillingProfile: "rhc_assisted_living_q5002_daily_v1",
    serviceLocation: {
      patientAddressId: ADDRESS,
      kind: "facility",
      facilityId: FACILITY,
      facilityKind: "alf",
    },
  };

  it("passes the two supported profiles through unchanged", () => {
    expect(assertSupportedRhcPricingSnapshotPayload(V1, 1)).toBe(V1);
    expect(assertSupportedRhcPricingSnapshotPayload(V2, 2)).toBe(V2);
  });

  it.each([
    ["a v2 payload for a v1 line", V2, 1],
    ["a v1 payload for a v2 line", V1, 2],
    ["a v1 payload that names a local billing profile", { ...V1, localBillingProfile: "x" }, 1],
    [
      "a v2 payload for another facility kind",
      { ...V2, serviceLocation: { ...V2.serviceLocation, facilityKind: "snf" } },
      2,
    ],
    ["a v2 payload without its billing profile", { ...V2, localBillingProfile: undefined }, 2],
    ["a payload without an assessment timestamp", { ...V1, assessmentTimestamp: undefined }, 1],
    ["a payload that authorises posting", { ...V1, postingAuthorized: true }, 1],
  ] as const)("refuses %s with a typed 500", (_name, payload, version) => {
    let thrown: unknown;
    try {
      assertSupportedRhcPricingSnapshotPayload(payload, version);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ChartWardenError);
    expect(thrown).toMatchObject({
      code: "RHC_PRICING_SNAPSHOT_PROFILE_UNSUPPORTED",
      statusCode: 500,
    });
  });
});
