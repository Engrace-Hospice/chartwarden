import type { PayerRatePolicyFact } from "@chartwarden/medicaid-adapters";
import { describe, expect, it } from "vitest";
import {
  canonicalPricingSnapshotJson,
  pricingSnapshotFingerprint,
  rateRowAsFact,
  resolveRhcDailyPricingPlan,
  resolveRhcHomeResidence,
  verifyStoredRhcPricingSnapshots,
} from "./rhc-pricing-snapshot";

const HOME = {
  addressId: "11111111-1111-1111-1111-111111111111",
  kind: "home",
  facilityId: null,
  effectiveFrom: "2026-11-01",
  effectiveTo: null,
} as const;

describe("RHC service-location qualification", () => {
  it("requires one stable home residence covering the inclusive service window", () => {
    expect(resolveRhcHomeResidence([HOME], "2026-11-01", "2026-11-04")).toEqual({
      status: "resolved",
      span: HOME,
    });
    expect(
      resolveRhcHomeResidence([{ ...HOME, effectiveTo: "2026-11-03" }], "2026-11-01", "2026-11-04"),
    ).toEqual({ status: "unresolved", reasonCode: "RHC_SERVICE_RESIDENCE_PERIOD_INCOMPLETE" });
  });

  it("refuses facility and ambiguous residence histories instead of emitting Q5001", () => {
    expect(
      resolveRhcHomeResidence(
        [{ ...HOME, kind: "facility", facilityId: "22222222-2222-2222-2222-222222222222" }],
        "2026-11-01",
        "2026-11-04",
      ),
    ).toEqual({ status: "unsupported", reasonCode: "RHC_Q5001_REQUIRES_HOME_RESIDENCE" });
    expect(resolveRhcHomeResidence([HOME, HOME], "2026-11-01", "2026-11-04")).toEqual({
      status: "ambiguous",
      reasonCode: "RHC_SERVICE_RESIDENCE_AMBIGUOUS",
    });
    expect(resolveRhcHomeResidence([], "2026-11-01", "2026-11-04")).toEqual({
      status: "unresolved",
      reasonCode: "RHC_SERVICE_RESIDENCE_MISSING",
    });
  });
});

type PlanInput = Parameters<typeof resolveRhcDailyPricingPlan>[0];
type VerifyInput = Parameters<typeof verifyStoredRhcPricingSnapshots>[0];

const ORG = "00000000-0000-4000-8000-000000000001";
const PROVIDER = "00000000-0000-4000-8000-000000000002";
const PATIENT = "00000000-0000-4000-8000-000000000003";
const ADMISSION = "00000000-0000-4000-8000-000000000004";
const PAYER = "00000000-0000-4000-8000-000000000005";
const ASSESSED_AT = "2026-11-10T12:00:00.000Z";

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
  assessedAt: ASSESSED_AT,
};

const EVIDENCE = {
  id: "evidence-1",
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
} as PlanInput["evidence"];

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

const OPEN_RHC_PERIOD = {
  id: "loc-1",
  version: 0,
  levelOfCare: "routine_home_care" as const,
  effectiveAt: new Date("2026-10-15T00:00:00.000Z"),
  endedAt: null,
  updatedAt: new Date("2026-10-15T00:00:00.000Z"),
};

const planInput = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  scope: SCOPE,
  evidence: EVIDENCE,
  locPeriods: [OPEN_RHC_PERIOD],
  rates: [RATE],
  residenceSpans: [HOME],
  ...overrides,
});

const resolvedLines = (input: PlanInput) => {
  const plan = resolveRhcDailyPricingPlan(input);
  if (plan.status !== "resolved")
    throw new Error(`expected a resolved plan, got ${plan.reasonCode}`);
  return plan.lines;
};

describe("resolveRhcDailyPricingPlan", () => {
  it("prices one RHC line per period, one unit per calendar day, with the rate as a plain fact", () => {
    const [line, ...rest] = resolvedLines(planInput());
    expect(rest).toHaveLength(0);
    expect(line).toMatchObject({
      serviceFrom: "2026-11-01",
      serviceTo: "2026-11-05",
      locPeriodId: "loc-1",
      units: 5,
      rateCents: 20_000,
      baseReimbursementCents: 100_000,
      chargesCents: 125_000,
      revenueCode: "0651",
      hcpcsCode: "Q5001",
    });
    // The plan carries the fact the pricing engine used (string timestamps), not the Drizzle row.
    expect(line!.rate).toMatchObject({ id: "rate-1", createdAt: "2026-09-01T00:00:00.000Z" });
  });

  it("splits at a rate boundary and keeps every day covered exactly once", () => {
    const rates = [
      { ...RATE, id: "rate-a", effectiveTo: "2026-11-02" },
      { ...RATE, id: "rate-b", effectiveFrom: "2026-11-03", rateCents: 30_000 },
    ];
    const lines = resolvedLines(planInput({ rates }));
    expect(lines.map((l) => [l.serviceFrom, l.serviceTo, l.units, l.rateCents])).toEqual([
      ["2026-11-01", "2026-11-02", 2, 20_000],
      ["2026-11-03", "2026-11-05", 3, 30_000],
    ]);
  });

  it("refuses evidence for another scope, a stale admission version, and a window it does not cover", () => {
    expect(
      resolveRhcDailyPricingPlan(planInput({ evidence: { ...EVIDENCE, patientId: "other" } })),
    ).toEqual({ status: "unresolved", reasonCode: "BILLING_EVIDENCE_SCOPE_MISMATCH" });
    expect(
      resolveRhcDailyPricingPlan(planInput({ evidence: { ...EVIDENCE, admissionVersion: 2 } })),
    ).toEqual({ status: "unresolved", reasonCode: "BILLING_EVIDENCE_STALE_OR_OUT_OF_RANGE" });
    expect(
      resolveRhcDailyPricingPlan(
        planInput({ evidence: { ...EVIDENCE, effectiveFrom: "2026-11-02" } }),
      ),
    ).toEqual({ status: "unresolved", reasonCode: "BILLING_EVIDENCE_PERIOD_INCOMPLETE" });
  });

  it("fails closed on a non-RHC period, a gap between periods, and missing LOC evidence", () => {
    expect(
      resolveRhcDailyPricingPlan(
        planInput({
          locPeriods: [{ ...OPEN_RHC_PERIOD, levelOfCare: "general_inpatient_care" as const }],
        }),
      ),
    ).toEqual({ status: "unsupported", reasonCode: "RHC_DAILY_PATH_ONLY" });
    expect(
      resolveRhcDailyPricingPlan(
        planInput({
          locPeriods: [
            { ...OPEN_RHC_PERIOD, endedAt: new Date("2026-11-03T00:00:00.000Z") },
            { ...OPEN_RHC_PERIOD, id: "loc-2", effectiveAt: new Date("2026-11-04T00:00:00.000Z") },
          ],
        }),
      ),
    ).toEqual({ status: "ambiguous", reasonCode: "M6_LOC_SERVICE_DAYS_CONFLICT" });
    expect(resolveRhcDailyPricingPlan(planInput({ locPeriods: [] }))).toEqual({
      status: "unresolved",
      reasonCode: "M6_LOC_EVIDENCE_MISSING",
    });
    expect(
      resolveRhcDailyPricingPlan(
        planInput({ locPeriods: [{ ...OPEN_RHC_PERIOD, updatedAt: undefined }] }),
      ),
    ).toEqual({ status: "unresolved", reasonCode: "M6_LOC_VERSION_UNAVAILABLE" });
  });

  it("refuses a rate that does not cover the window", () => {
    const plan = resolveRhcDailyPricingPlan(
      planInput({ rates: [{ ...RATE, effectiveFrom: "2026-11-03" }] }),
    );
    expect(plan.status).not.toBe("resolved");
  });

  it("closes the final period at the inclusive death date only when the stay facts say so", () => {
    const deathDay = "2026-11-05";
    const endedOnDeathDay = {
      ...OPEN_RHC_PERIOD,
      endedAt: new Date(`${deathDay}T14:30:00.000Z`),
    };
    const deathScope = { ...SCOPE, serviceTo: deathDay };
    // M6 windows are half-open: without the inclusive date the death day belongs to no RHC period.
    expect(
      resolveRhcDailyPricingPlan(planInput({ scope: deathScope, locPeriods: [endedOnDeathDay] })),
    ).toEqual({ status: "unresolved", reasonCode: "M6_LOC_SERVICE_DAYS_INCOMPLETE" });
    const [line] = resolvedLines(
      planInput({
        scope: { ...deathScope, inclusiveEndDate: deathDay },
        locPeriods: [endedOnDeathDay],
      }),
    );
    expect(line).toMatchObject({ serviceFrom: "2026-11-01", serviceTo: deathDay, units: 5 });
  });

  it("does not extend an earlier period when a later period owns the death date", () => {
    const deathDay = "2026-11-05";
    const locPeriods = [
      { ...OPEN_RHC_PERIOD, endedAt: new Date(`${deathDay}T00:00:00.000Z`) },
      { ...OPEN_RHC_PERIOD, id: "loc-2", effectiveAt: new Date(`${deathDay}T00:00:00.000Z`) },
    ];
    const [first, second] = resolvedLines(
      planInput({
        scope: { ...SCOPE, serviceTo: deathDay, inclusiveEndDate: deathDay },
        locPeriods,
      }),
    );
    expect(first).toMatchObject({ locPeriodId: "loc-1", serviceTo: "2026-11-04", units: 4 });
    expect(second).toMatchObject({ locPeriodId: "loc-2", serviceFrom: deathDay, units: 1 });
  });

  it("binds the snapshot to the claimed days, not to M6 row versions that change for other reasons", () => {
    const baseline = resolvedLines(planInput())[0]!.integrityFacts;
    // Closing the open period after the claimed range bumps its version and updated_at, nothing else.
    const closedLater = resolvedLines(
      planInput({
        locPeriods: [
          {
            ...OPEN_RHC_PERIOD,
            version: 7,
            updatedAt: new Date("2026-11-09T00:00:00.000Z"),
            endedAt: new Date("2026-11-08T00:00:00.000Z"),
          },
        ],
      }),
    )[0]!.integrityFacts;
    expect(canonicalPricingSnapshotJson(closedLater)).toBe(canonicalPricingSnapshotJson(baseline));
    expect(baseline).toMatchObject({ locPeriodId: "loc-1", locEffectiveFrom: "2026-11-01" });
    expect(baseline).toMatchObject({ locEffectiveTo: "2026-11-05", levelOfCare: "RHC" });
    for (const unrelated of ["locPeriodVersion", "locSourceUpdatedAt", "admissionVersion"]) {
      expect(baseline).not.toHaveProperty(unrelated);
    }
    // A real change to a claimed day still changes the snapshot (here: the period's claimed extent).
    const shortened = resolveRhcDailyPricingPlan(
      planInput({
        locPeriods: [{ ...OPEN_RHC_PERIOD, endedAt: new Date("2026-11-03T00:00:00.000Z") }],
      }),
    );
    expect(shortened).toEqual({
      status: "unresolved",
      reasonCode: "M6_LOC_SERVICE_DAYS_INCOMPLETE",
    });
  });
});

describe("canonicalPricingSnapshotJson", () => {
  it("is independent of key order, at every depth", () => {
    expect(canonicalPricingSnapshotJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: "z" } })).toBe(
      canonicalPricingSnapshotJson({ a: { c: "z", d: [3, { x: 2, y: 1 }] }, b: 1 }),
    );
    expect(canonicalPricingSnapshotJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("keeps array order and distinguishes null from an absent key", () => {
    expect(canonicalPricingSnapshotJson([1, 2])).not.toBe(canonicalPricingSnapshotJson([2, 1]));
    expect(canonicalPricingSnapshotJson({ a: null })).toBe('{"a":null}');
    expect(pricingSnapshotFingerprint({ a: null })).not.toBe(pricingSnapshotFingerprint({}));
  });

  it("rejects undefined and non-finite values instead of normalizing them into a colliding form", () => {
    expect(() => canonicalPricingSnapshotJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalPricingSnapshotJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalPricingSnapshotJson({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalPricingSnapshotJson({ a: () => 1 })).toThrow(TypeError);
  });

  it("yields a stable fingerprint for equal material and a different one for changed material", () => {
    expect(pricingSnapshotFingerprint({ b: 1, a: 2 })).toBe(
      pricingSnapshotFingerprint({ a: 2, b: 1 }),
    );
    expect(pricingSnapshotFingerprint({ a: 2 })).not.toBe(pricingSnapshotFingerprint({ a: 3 }));
    expect(pricingSnapshotFingerprint({ a: 2 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("rateRowAsFact", () => {
  it("serializes row timestamps to ISO strings and keeps the identity fields", () => {
    const fact = rateRowAsFact({
      ...RATE,
      verifiedAt: new Date(RATE.verifiedAt!),
      createdAt: new Date(RATE.createdAt),
    } as Parameters<typeof rateRowAsFact>[0]);
    expect(fact).toMatchObject({
      id: "rate-1",
      verifiedAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
  });
});

/**
 * A scripted transaction: each `select()` returns the next queued result set whatever chain is built on
 * it, and `execute()` (advisory locks, the database fingerprint) answers a fixed fingerprint. Only the
 * statement ORDER of verifyStoredRhcPricingSnapshots matters here: payer assignment, billing evidence,
 * then stored snapshots.
 */
function scriptedTx(selects: readonly unknown[][]): VerifyInput["tx"] {
  const queue = [...selects];
  // A real promise carrying the chainable query-builder methods, so `await` works at any link.
  const chain = (rows: unknown[]) => {
    const link = Promise.resolve(rows) as Promise<unknown[]> & Record<string, () => unknown>;
    for (const method of ["from", "where", "orderBy", "limit", "for"]) link[method] = () => link;
    return link;
  };
  return {
    select: () => chain(queue.shift() ?? []),
    execute: async () => ({ rows: [{ fingerprint: "synthetic-fingerprint" }] }),
  } as unknown as VerifyInput["tx"];
}

const CLAIM_ID = "00000000-0000-4000-8000-0000000000c1";
const LINE_ID = "00000000-0000-4000-8000-0000000000c2";
const CLAIM = {
  id: CLAIM_ID,
  organizationId: ORG,
  providerEntityId: PROVIDER,
  patientId: PATIENT,
  admissionId: ADMISSION,
  patientPayerId: "00000000-0000-4000-8000-0000000000c3",
  canonicalPayerId: PAYER,
  medicaidProgramKind: "managed_care",
  serviceState: "OR",
  serviceFrom: "2026-11-01",
  serviceTo: "2026-11-05",
  kind: "hospice_only",
};
const PAYER_READER: NonNullable<VerifyInput["payerReader"]> = {
  resolvePayer: async () => ({
    id: PAYER,
    displayName: "Synthetic CCO",
    kind: "medicaid",
    stateCode: "OR",
    status: "active",
  }),
  medicaidProgramClassifications: async () => [
    {
      id: "classification-1",
      canonicalPayerId: PAYER,
      stateCode: "OR",
      classification: "medicaid_cco",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      verificationStatus: "verified",
      sourceKind: "synthetic",
      sourceReference: "doc:classification",
      supersedesId: null,
      verifiedAt: "2026-01-01T00:00:00.000Z",
      verifiedBy: "reviewer",
      recordedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};
const ASSIGNMENT_ROWS = [
  {
    id: "assignment-1",
    programKind: "managed_care",
    canonicalPayerId: PAYER,
    status: "verified",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
  },
];
const RATE_ROW = {
  ...RATE,
  verifiedAt: new Date(RATE.verifiedAt!),
  createdAt: new Date(RATE.createdAt),
} as VerifyInput["rateRows"][number];

/** Build the persisted claim line + immutable snapshot a prior assembly would have stored. */
function storedAssembly(input: PlanInput) {
  const [line] = resolvedLines(input);
  const material = { ...line!.integrityFacts, medicaidClaimId: CLAIM_ID, claimLineId: LINE_ID };
  return {
    line: {
      id: LINE_ID,
      organizationId: ORG,
      providerEntityId: PROVIDER,
      medicaidClaimId: CLAIM_ID,
      serviceDate: new Date(`${line!.serviceFrom}T00:00:00.000Z`),
      serviceDateTo: new Date(`${line!.serviceTo}T00:00:00.000Z`),
      revenueCode: line!.revenueCode,
      qCode: line!.hcpcsCode,
      levelOfCare: "RHC",
      locPeriodId: line!.locPeriodId,
      units: line!.units,
      rateAtAssemblyCents: line!.rateCents,
      stateRateScheduleIdSnapshot: null,
      payerRatePolicyIdSnapshot: line!.rate.id,
      chargesCents: line!.chargesCents,
      isRb: false,
    },
    snapshot: {
      medicaidClaimLineId: LINE_ID,
      payerRatePolicyId: line!.rate.id,
      billingEvidenceId: line!.evidence.id,
      snapshotSchemaVersion: 1,
      fingerprint: "synthetic-fingerprint",
      snapshot: { ...material, assessmentTimestamp: ASSESSED_AT },
    },
  };
}

function verifyAgainst(
  stored: ReturnType<typeof storedAssembly>,
  current: {
    locPeriods?: VerifyInput["locPeriods"];
    inclusiveEndDate?: string | null;
    claim?: Partial<typeof CLAIM>;
  } = {},
) {
  return verifyStoredRhcPricingSnapshots({
    tx: scriptedTx([ASSIGNMENT_ROWS, [EVIDENCE], [stored.snapshot]]),
    claim: { ...CLAIM, ...current.claim },
    lines: [stored.line],
    locPeriods: current.locPeriods ?? [OPEN_RHC_PERIOD],
    admissionVersion: 3,
    inclusiveEndDate: current.inclusiveEndDate,
    rateRows: [RATE_ROW],
    payerReader: PAYER_READER,
    residenceReader: { residencesBetweenInTransaction: async () => [HOME] },
    inHomeRespiteEvidenceReader: {
      readInTransaction: async () => ({ status: "none", serviceCount: 0, evidenceVersions: [] }),
    },
    assessedAt: ASSESSED_AT,
  });
}

describe("verifyStoredRhcPricingSnapshots", () => {
  it("passes trivially when the claim has no hospice lines and refuses without a payer reader", async () => {
    const stored = storedAssembly(planInput());
    const noHospice = await verifyStoredRhcPricingSnapshots({
      tx: scriptedTx([]),
      claim: CLAIM,
      lines: [{ ...stored.line, isRb: true }],
      locPeriods: [],
      admissionVersion: 3,
      rateRows: [],
      payerReader: undefined,
      residenceReader: undefined,
      assessedAt: ASSESSED_AT,
    });
    expect(noHospice).toEqual({
      pricingSnapshotVerified: true,
      institutionalFormatQualified: true,
    });
    await expect(
      verifyStoredRhcPricingSnapshots({
        tx: scriptedTx([]),
        claim: CLAIM,
        lines: [stored.line],
        locPeriods: [],
        admissionVersion: 3,
        rateRows: [],
        payerReader: undefined,
        residenceReader: undefined,
        assessedAt: ASSESSED_AT,
      }),
    ).resolves.toEqual({ pricingSnapshotVerified: false, institutionalFormatQualified: false });
  });

  it("verifies a faithfully stored snapshot and reports the local-draft coding profile as unqualified", async () => {
    const result = await verifyAgainst(storedAssembly(planInput()));
    expect(result).toEqual({ pricingSnapshotVerified: true, institutionalFormatQualified: false });
  });

  it("stays verified when the open LOC period is closed after the claimed range", async () => {
    const stored = storedAssembly(planInput());
    const result = await verifyAgainst(stored, {
      locPeriods: [
        {
          ...OPEN_RHC_PERIOD,
          version: 4,
          updatedAt: new Date("2026-11-09T00:00:00.000Z"),
          endedAt: new Date("2026-11-08T00:00:00.000Z"),
        },
      ],
    });
    expect(result.pricingSnapshotVerified).toBe(true);
  });

  it("fails closed when a claimed day changes (period shortened inside the range)", async () => {
    const stored = storedAssembly(planInput());
    const result = await verifyAgainst(stored, {
      locPeriods: [{ ...OPEN_RHC_PERIOD, endedAt: new Date("2026-11-03T00:00:00.000Z") }],
    });
    expect(result).toEqual({ pricingSnapshotVerified: false, institutionalFormatQualified: false });
  });

  it("fails closed when a tampered snapshot no longer matches the current plan", async () => {
    const stored = storedAssembly(planInput());
    const tampered = {
      ...stored,
      snapshot: {
        ...stored.snapshot,
        snapshot: { ...stored.snapshot.snapshot, rateCents: 1 },
      },
    };
    expect((await verifyAgainst(tampered)).pricingSnapshotVerified).toBe(false);
  });

  it("verifies a death-date claim only when the stay's inclusive date of death is supplied", async () => {
    const deathDay = "2026-11-05";
    const locPeriods = [{ ...OPEN_RHC_PERIOD, endedAt: new Date(`${deathDay}T14:30:00.000Z`) }];
    const stored = storedAssembly(
      planInput({
        scope: { ...SCOPE, serviceTo: deathDay, inclusiveEndDate: deathDay },
        locPeriods,
      }),
    );
    const claim = { serviceTo: deathDay };
    expect(
      (await verifyAgainst(stored, { locPeriods, inclusiveEndDate: deathDay, claim }))
        .pricingSnapshotVerified,
    ).toBe(true);
    expect((await verifyAgainst(stored, { locPeriods, claim })).pricingSnapshotVerified).toBe(
      false,
    );
  });
});

describe("verifyStoredRhcPricingSnapshots for a facility (Q5002) residence", () => {
  const FACILITY = "00000000-0000-4000-8000-0000000000f1";
  const ALF_SPAN = {
    addressId: "00000000-0000-4000-8000-0000000000f2",
    kind: "facility",
    facilityId: FACILITY,
    effectiveFrom: "2026-10-01",
    effectiveTo: null,
  } as const;
  const Q5002_EVIDENCE = { ...EVIDENCE, id: "evidence-q5002", hcpcsCode: "Q5002" };
  const kinds = (kind: string) => new Map([[FACILITY, kind]]);
  const stored = (() => {
    const assembly = storedAssembly(
      planInput({
        evidence: Q5002_EVIDENCE,
        residenceSpans: [ALF_SPAN],
        facilityKinds: kinds("alf"),
      }),
    );
    return { ...assembly, snapshot: { ...assembly.snapshot, snapshotSchemaVersion: 2 } };
  })();
  const verifyFacility = (
    facilityKindReader: VerifyInput["facilityKindReader"],
    residence: readonly (typeof ALF_SPAN)[] | readonly Record<string, unknown>[] = [ALF_SPAN],
  ) =>
    verifyStoredRhcPricingSnapshots({
      tx: scriptedTx([ASSIGNMENT_ROWS, [Q5002_EVIDENCE], [stored.snapshot]]),
      claim: CLAIM,
      lines: [stored.line],
      locPeriods: [OPEN_RHC_PERIOD],
      admissionVersion: 3,
      rateRows: [RATE_ROW],
      payerReader: PAYER_READER,
      residenceReader: {
        residencesBetweenInTransaction: async () =>
          residence as unknown as readonly (typeof ALF_SPAN)[],
      },
      facilityKindReader,
      inHomeRespiteEvidenceReader: {
        readInTransaction: async () => ({ status: "none", serviceCount: 0, evidenceVersions: [] }),
      },
      assessedAt: ASSESSED_AT,
    });
  const lockedReader = (kind: string) => ({
    kindsFor: async () => kinds("alf"),
    kindsForInTransaction: async () => kinds(kind),
  });

  it("verifies a stored v2 snapshot against an active assisted-living facility", async () => {
    expect((await verifyFacility(lockedReader("alf"))).pricingSnapshotVerified).toBe(true);
  });

  it("stays verified when the residence closes after the claimed days", async () => {
    const result = await verifyFacility(lockedReader("alf"), [
      { ...ALF_SPAN, effectiveTo: "2026-11-20" },
    ]);
    expect(result.pricingSnapshotVerified).toBe(true);
  });

  it("fails closed when the facility is now another kind, or the locked kind is unavailable", async () => {
    expect((await verifyFacility(lockedReader("snf"))).pricingSnapshotVerified).toBe(false);
    const absent = {
      kindsFor: async () => kinds("alf"),
      kindsForInTransaction: async () => new Map(),
    };
    expect((await verifyFacility(absent)).pricingSnapshotVerified).toBe(false);
  });

  it("never falls back to the unlocked reader: without a locked read no facility kind is known", async () => {
    const unlockedOnly = { kindsFor: async () => kinds("alf") };
    expect((await verifyFacility(unlockedOnly)).pricingSnapshotVerified).toBe(false);
    expect((await verifyFacility(undefined)).pricingSnapshotVerified).toBe(false);
  });
});
