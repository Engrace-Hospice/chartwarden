import { describe, expect, it } from "vitest";
import {
  type HospiceClaimLineForSnapshot,
  hospiceClaimLineSnapshotIssue,
} from "../src/modules/24-billing-medicaid/claim-hospice-line-snapshot";
import {
  arrangementIssue,
  rbClaimLineIssue,
  rbDayAdmissionEndIssue,
  rbDayIssue,
  rbDayLocSnapshotIssue,
} from "../src/modules/24-billing-medicaid/routes/write-service-drizzle";

const ORG = "a0000000-0000-4000-8000-000000000001";
const OTHER_ORG = "a0000000-0000-4000-8000-000000000009";
const PATIENT = "b0000000-0000-4000-8000-000000000001";
const OTHER_PATIENT = "b0000000-0000-4000-8000-000000000009";
const PROVIDER = "c0000000-0000-4000-8000-000000000001";
const OTHER_PROVIDER = "c0000000-0000-4000-8000-000000000009";
const ARRANGEMENT = "d0000000-0000-4000-8000-000000000001";
const FACILITY = "e0000000-0000-4000-8000-000000000001";
const LOCATION = "f0000000-0000-4000-8000-000000000001";
const LOC_PERIOD = "e0000000-0000-4000-8000-000000000002";
const LOC_PERIOD_2 = "e0000000-0000-4000-8000-000000000003";

const arrangement = (
  overrides: Partial<Parameters<typeof arrangementIssue>[0]> = {},
): Parameters<typeof arrangementIssue>[0] => ({
  id: ARRANGEMENT,
  organizationId: ORG,
  patientId: PATIENT,
  providerEntityId: PROVIDER,
  locationId: LOCATION,
  nfFacilityMdmId: FACILITY,
  nfFacilityNameSnapshot: "Synthetic Skilled Nursing Facility",
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveTo: null,
  contractDocumentId: "d0000000-0000-4000-8000-000000000002",
  contractStartedAt: new Date("2026-01-01T00:00:00.000Z"),
  contractTerminatedAt: null,
  state: "ACTIVE",
  nfPerDiemRoutineCents: 21000,
  ...overrides,
});

const input: Parameters<typeof rbDayIssue>[3] = {
  patientId: PATIENT,
  admissionId: "b0000000-0000-4000-8000-000000000002",
  providerEntityId: PROVIDER,
  serviceFrom: "2026-02-01",
  serviceTo: "2026-02-28",
  kind: "rb_only",
  rbArrangementId: ARRANGEMENT,
};

const rbDay = (
  overrides: Partial<Parameters<typeof rbDayIssue>[0]> = {},
): Parameters<typeof rbDayIssue>[0] => ({
  id: "d0000000-0000-4000-8000-000000000003",
  organizationId: ORG,
  patientId: PATIENT,
  providerEntityId: PROVIDER,
  locationId: LOCATION,
  rbArrangementId: ARRANGEMENT,
  serviceDate: new Date("2026-02-15T00:00:00.000Z"),
  status: "billable",
  locOfDay: "RHC",
  locPeriodIdSnapshot: LOC_PERIOD,
  perDiemCentsSnapshot: 21000,
  exclusionReason: null,
  medicaidClaimLineId: null,
  ...overrides,
});

describe("M24 Room & Board claim assembly integrity", () => {
  it("accepts an arrangement that matches the patient/provider and covers the service range", () => {
    expect(
      arrangementIssue(arrangement(), ORG, PATIENT, PROVIDER, "2026-02-01", "2026-02-28"),
    ).toBeNull();
  });

  it.each([
    ["organization", { organizationId: OTHER_ORG }],
    ["patient", { patientId: OTHER_PATIENT }],
    ["provider", { providerEntityId: OTHER_PROVIDER }],
  ] as const)("refuses an arrangement owned by a different %s", (_scope, overrides) => {
    expect(
      arrangementIssue(arrangement(overrides), ORG, PATIENT, PROVIDER, "2026-02-01", "2026-02-28"),
    ).toMatchObject({ code: "MEDICAID_RB_ARRANGEMENT_IDENTITY_MISMATCH" });
  });

  it("allows historical days up to an arrangement termination date and refuses later days", () => {
    const terminated = arrangement({
      state: "TERMINATED",
      contractTerminatedAt: new Date("2026-02-20T12:00:00.000Z"),
    });
    expect(
      arrangementIssue(terminated, ORG, PATIENT, PROVIDER, "2026-02-01", "2026-02-20"),
    ).toBeNull();
    expect(
      arrangementIssue(terminated, ORG, PATIENT, PROVIDER, "2026-02-21", "2026-02-28"),
    ).toMatchObject({ code: "MEDICAID_RB_ARRANGEMENT_OUTSIDE_SERVICE_RANGE" });
  });

  it("requires existing contract and facility identity evidence", () => {
    expect(
      arrangementIssue(
        arrangement({ contractDocumentId: null }),
        ORG,
        PATIENT,
        PROVIDER,
        "2026-02-01",
        "2026-02-28",
      ),
    ).toMatchObject({ code: "MEDICAID_RB_ARRANGEMENT_CONTRACT_UNVERIFIED" });
    expect(
      arrangementIssue(
        arrangement({ nfFacilityNameSnapshot: "  " }),
        ORG,
        PATIENT,
        PROVIDER,
        "2026-02-01",
        "2026-02-28",
      ),
    ).toMatchObject({ code: "MEDICAID_RB_FACILITY_IDENTITY_MISSING" });
  });

  it("accepts only matching billable RHC/CHC day snapshots", () => {
    expect(rbDayIssue(rbDay(), arrangement(), ORG, input)).toBeNull();
    expect(rbDayIssue(rbDay({ locOfDay: "CHC" }), arrangement(), ORG, input)).toBeNull();
    expect(rbDayIssue(rbDay({ locOfDay: "GIP" }), arrangement(), ORG, input)).toMatchObject({
      code: "MEDICAID_RB_DAY_NOT_BILLABLE",
    });
  });

  it("requires a stored R&B line to retain exact billed-day ownership and current LOC evidence", () => {
    const dayRow = rbDay({
      id: "d0000000-0000-4000-8000-000000000003",
      status: "billed",
      medicaidClaimLineId: "d0000000-0000-4000-8000-000000000004",
    });
    const line: Parameters<typeof rbClaimLineIssue>[0]["line"] = {
      id: "d0000000-0000-4000-8000-000000000004",
      organizationId: ORG,
      providerEntityId: PROVIDER,
      locationId: LOCATION,
      locPeriodId: LOC_PERIOD,
      medicaidClaimId: "d0000000-0000-4000-8000-000000000005",
      serviceDate: new Date("2026-02-15T00:00:00.000Z"),
      revenueCode: "0658",
      qCode: "Q5003",
      levelOfCare: "NF_RB",
      units: 1,
      rateAtAssemblyCents: 21000,
      stateRateScheduleIdSnapshot: null,
      chargesCents: 21000,
      isRb: true,
      rbDayId: dayRow.id,
    };
    const valid = {
      line,
      rbDay: dayRow,
      arrangement: arrangement(),
      organizationId: ORG,
      patientId: PATIENT,
      providerEntityId: PROVIDER,
      claimId: line.medicaidClaimId,
      arrangementId: ARRANGEMENT,
      serviceFrom: "2026-02-01",
      serviceTo: "2026-02-28",
      admission: {
        status: "active" as const,
        stayEndFacts: {
          dischargeDate: null,
          dischargeReason: null,
          deceasedDate: null,
          pendingDischargeDates: [],
          transferOut: null,
          revocationDate: null,
        },
      },
      locPeriods: [
        {
          id: LOC_PERIOD,
          levelOfCare: "routine_home_care" as const,
          effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
          endedAt: null,
        },
      ],
    } satisfies Parameters<typeof rbClaimLineIssue>[0];

    expect(rbClaimLineIssue(valid)).toBeNull();
    expect(
      rbClaimLineIssue({ ...valid, arrangement: arrangement({ locationId: OTHER_PROVIDER }) }),
    ).toMatchObject({ code: "MEDICAID_RB_DAY_CLAIM_OWNERSHIP_MISMATCH" });
    expect(
      rbClaimLineIssue({
        ...valid,
        serviceFrom: "2026-02-16",
      }),
    ).toMatchObject({ code: "MEDICAID_RB_DAY_SERVICE_RANGE_MISMATCH" });
    expect(
      rbClaimLineIssue({ ...valid, rbDay: { ...dayRow, medicaidClaimLineId: null } }),
    ).toMatchObject({ code: "MEDICAID_RB_DAY_CLAIM_OWNERSHIP_MISMATCH" });
    expect(
      rbClaimLineIssue({
        ...valid,
        locPeriods: [
          {
            id: LOC_PERIOD,
            levelOfCare: "routine_home_care",
            effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
            endedAt: new Date("2026-02-10T00:00:00.000Z"),
          },
        ],
      }),
    ).toMatchObject({ code: "MEDICAID_RB_DAY_LOC_SNAPSHOT_STALE" });
  });

  it("preserves prior exclusion evidence after an authorized status override to billable", () => {
    expect(
      rbDayIssue(
        rbDay({ status: "billable", exclusionReason: "Previously reviewed exclusion" }),
        arrangement(),
        ORG,
        input,
      ),
    ).toBeNull();
    expect(rbDayIssue(rbDay({ status: "excluded" }), arrangement(), ORG, input)).toMatchObject({
      code: "MEDICAID_RB_DAY_NOT_BILLABLE",
    });
  });

  it("requires the day snapshot to match a current M6 RHC/CHC period for the selected admission", () => {
    const periods = [
      {
        id: LOC_PERIOD,
        levelOfCare: "routine_home_care" as const,
        effectiveAt: new Date("2026-02-01T00:00:00.000Z"),
        endedAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ];
    expect(rbDayLocSnapshotIssue(rbDay(), periods)).toBeNull();
    expect(
      rbDayLocSnapshotIssue(
        rbDay(),
        [{ ...periods[0]!, endedAt: new Date("2026-02-15T12:00:00.000Z") }],
        "2026-02-15",
      ),
    ).toBeNull();
    expect(
      rbDayLocSnapshotIssue(rbDay(), [
        { ...periods[0]!, endedAt: new Date("2026-02-15T12:00:00.000Z") },
      ]),
    ).toMatchObject({ code: "MEDICAID_RB_DAY_LOC_SNAPSHOT_STALE" });
    expect(rbDayLocSnapshotIssue(rbDay({ locOfDay: "CHC" }), periods)).toMatchObject({
      code: "MEDICAID_RB_DAY_LOC_SNAPSHOT_STALE",
    });
    expect(rbDayLocSnapshotIssue(rbDay(), [])).toMatchObject({
      code: "MEDICAID_RB_DAY_LOC_SNAPSHOT_STALE",
    });
    expect(
      rbDayLocSnapshotIssue(rbDay(), [
        { ...periods[0]!, effectiveAt: new Date("2026-02-16T00:00:00.000Z") },
      ]),
    ).toMatchObject({ code: "MEDICAID_RB_DAY_LOC_SNAPSHOT_STALE" });
    expect(
      rbDayLocSnapshotIssue(
        rbDay(),
        [
          periods[0]!,
          {
            ...periods[0]!,
            id: "f0000000-0000-4000-8000-000000000003",
            effectiveAt: new Date("2026-02-15T12:00:00.000Z"),
          },
        ],
        "2026-02-15",
      ),
    ).toMatchObject({ code: "MEDICAID_RB_DAY_LOC_SNAPSHOT_STALE" });
  });

  it("refuses R&B on or after a non-death admission end date", () => {
    const admission = {
      status: "discharged" as const,
      stayEndFacts: {
        dischargeDate: "2026-02-15",
        dischargeReason: "no_longer_terminal",
        deceasedDate: null,
        pendingDischargeDates: [],
        transferOut: null,
        revocationDate: null,
      },
    };
    expect(
      rbDayAdmissionEndIssue(
        rbDay({ serviceDate: new Date("2026-02-14T00:00:00.000Z") }),
        admission,
      ),
    ).toBeNull();
    expect(rbDayAdmissionEndIssue(rbDay(), admission)).toMatchObject({
      code: "MEDICAID_RB_DAY_OUTSIDE_ADMISSION",
    });
  });

  it("retains the death date and refuses later R&B days", () => {
    const admission = {
      status: "bereavement" as const,
      stayEndFacts: {
        dischargeDate: "2026-02-15",
        dischargeReason: "death",
        deceasedDate: "2026-02-15",
        pendingDischargeDates: [],
        transferOut: null,
        revocationDate: null,
      },
    };
    expect(rbDayAdmissionEndIssue(rbDay(), admission)).toBeNull();
    expect(
      rbDayAdmissionEndIssue(
        rbDay({ serviceDate: new Date("2026-02-16T00:00:00.000Z") }),
        admission,
      ),
    ).toMatchObject({ code: "MEDICAID_RB_DAY_OUTSIDE_ADMISSION" });
  });

  it.each([
    ["transfer-out", { dischargeDate: null, transferOut: { effectiveDate: "2026-02-15" } }],
    ["revocation", { dischargeDate: null, revocationDate: "2026-02-15" }],
  ] as const)("refuses R&B on the effective %s date", (_kind, overrides) => {
    const admission = {
      status: "closed" as const,
      stayEndFacts: {
        dischargeDate: null,
        dischargeReason: null,
        deceasedDate: null,
        pendingDischargeDates: [],
        transferOut: null,
        revocationDate: null,
        ...overrides,
      },
    };
    expect(rbDayAdmissionEndIssue(rbDay(), admission)).toMatchObject({
      code: "MEDICAID_RB_DAY_OUTSIDE_ADMISSION",
    });
    expect(
      rbDayAdmissionEndIssue(
        rbDay({ serviceDate: new Date("2026-02-14T00:00:00.000Z") }),
        admission,
      ),
    ).toBeNull();
  });

  it("blocks R&B on or after a for-cause discharge date while cosign is pending", () => {
    const admission = {
      status: "active" as const,
      stayEndFacts: {
        dischargeDate: null,
        dischargeReason: null,
        deceasedDate: null,
        pendingDischargeDates: ["2026-02-15"],
        transferOut: null,
        revocationDate: null,
      },
    };
    expect(
      rbDayAdmissionEndIssue(
        rbDay({ serviceDate: new Date("2026-02-14T00:00:00.000Z") }),
        admission,
      ),
    ).toBeNull();
    expect(rbDayAdmissionEndIssue(rbDay(), admission)).toMatchObject({
      code: "MEDICAID_RB_ADMISSION_END_PENDING",
    });
  });

  it("refuses terminal admissions whose effective end cannot be verified", () => {
    expect(
      rbDayAdmissionEndIssue(rbDay(), {
        status: "closed",
        stayEndFacts: {
          dischargeDate: null,
          dischargeReason: null,
          deceasedDate: null,
          pendingDischargeDates: [],
          transferOut: null,
          revocationDate: null,
        },
      }),
    ).toMatchObject({ code: "MEDICAID_RB_ADMISSION_END_UNVERIFIED" });
  });

  it("refuses identity, date, rate, and existing-owner inconsistencies", () => {
    for (const overrides of [
      { organizationId: OTHER_ORG },
      { patientId: OTHER_PATIENT },
      { providerEntityId: OTHER_PROVIDER },
      { locationId: null },
      { rbArrangementId: "d0000000-0000-4000-8000-000000000009" },
    ]) {
      expect(rbDayIssue(rbDay(overrides), arrangement(), ORG, input)).toMatchObject({
        code: "MEDICAID_RB_DAY_IDENTITY_MISMATCH",
      });
    }
    expect(
      rbDayIssue(rbDay({ perDiemCentsSnapshot: 20000 }), arrangement(), ORG, input),
    ).toMatchObject({ code: "MEDICAID_RB_DAY_SNAPSHOT_INVALID" });
    expect(
      rbDayIssue(
        rbDay({ medicaidClaimLineId: "e0000000-0000-4000-8000-000000000009" }),
        arrangement(),
        ORG,
        input,
      ),
    ).toMatchObject({ code: "MEDICAID_RB_DAY_SNAPSHOT_INVALID" });
    expect(
      rbDayIssue(
        rbDay({ serviceDate: new Date("2026-03-01T00:00:00.000Z") }),
        arrangement({ effectiveTo: new Date("2026-02-28T00:00:00.000Z") }),
        ORG,
        input,
      ),
    ).toMatchObject({ code: "MEDICAID_RB_ARRANGEMENT_DATE_MISMATCH" });
  });
});

describe("M24 hospice claim lines remain aligned with current M6 periods", () => {
  const claim = {
    organizationId: ORG,
    providerEntityId: PROVIDER,
    claimId: "d0000000-0000-4000-8000-000000000005",
    serviceFrom: "2026-02-01",
    serviceTo: "2026-02-28",
  };
  const periods = [
    {
      id: LOC_PERIOD,
      levelOfCare: "routine_home_care" as const,
      effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
      endedAt: new Date("2026-02-11T00:00:00.000Z"),
    },
    {
      id: LOC_PERIOD_2,
      levelOfCare: "general_inpatient_care" as const,
      effectiveAt: new Date("2026-02-11T00:00:00.000Z"),
      endedAt: null,
    },
  ];
  const line = (
    id: string,
    periodId: string,
    serviceDate: string,
    units: number,
    levelOfCare: "RHC" | "GIP",
    revenueCode: "0651" | "0656",
  ): HospiceClaimLineForSnapshot => ({
    id,
    ...claim,
    medicaidClaimId: claim.claimId,
    locPeriodId: periodId,
    serviceDate,
    units,
    levelOfCare,
    revenueCode,
    rateAtAssemblyCents: 10000,
    stateRateScheduleIdSnapshot: "synthetic-schedule",
    chargesCents: units * 10000,
    isRb: false,
    rbDayId: null,
  });
  const lines = [
    line("line-1", LOC_PERIOD, "2026-02-01", 10, "RHC", "0651"),
    line("line-2", LOC_PERIOD_2, "2026-02-11", 18, "GIP", "0656"),
  ];

  it("accepts one-to-one line snapshots covering the current M6 partition", () => {
    expect(hospiceClaimLineSnapshotIssue({ ...claim, lines, periods })).toBeNull();
  });

  it("assigns a same-day LOC transition to the new period using M6's exclusive end date", () => {
    const transitionPeriods = [
      {
        id: LOC_PERIOD,
        levelOfCare: "routine_home_care" as const,
        effectiveAt: new Date("2026-02-01T00:00:00.000Z"),
        endedAt: new Date("2026-02-10T00:00:00.000Z"),
      },
      {
        id: LOC_PERIOD_2,
        levelOfCare: "general_inpatient_care" as const,
        effectiveAt: new Date("2026-02-10T00:00:00.000Z"),
        endedAt: null,
      },
    ];
    const transitionLines = [
      line("transition-rhc", LOC_PERIOD, "2026-02-01", 9, "RHC", "0651"),
      line("transition-gip", LOC_PERIOD_2, "2026-02-10", 19, "GIP", "0656"),
    ];
    expect(
      hospiceClaimLineSnapshotIssue({
        ...claim,
        lines: transitionLines,
        periods: transitionPeriods,
      }),
    ).toBeNull();
  });

  it("does not count an unconfirmed same-day replacement LOC as covered service", () => {
    expect(
      hospiceClaimLineSnapshotIssue({
        ...claim,
        serviceTo: "2026-02-10",
        lines: [line("before-assignment", LOC_PERIOD, "2026-02-01", 9, "RHC", "0651")],
        periods: [
          {
            id: LOC_PERIOD,
            levelOfCare: "routine_home_care",
            effectiveAt: new Date("2026-02-01T00:00:00.000Z"),
            endedAt: new Date("2026-02-10T00:00:00.000Z"),
          },
        ],
      }),
    ).toMatchObject({ code: "MEDICAID_CLAIM_LINE_LOC_SNAPSHOT_STALE" });
  });

  it("includes only a corroborated death date when M6 ended the final LOC that day", () => {
    const deathClaim = { ...claim, serviceTo: "2026-02-10" };
    const deathPeriods = [
      {
        id: LOC_PERIOD,
        levelOfCare: "routine_home_care" as const,
        effectiveAt: new Date("2026-02-01T00:00:00.000Z"),
        endedAt: new Date("2026-02-10T00:00:00.000Z"),
      },
    ];
    const deathLine = line("death-rhc", LOC_PERIOD, "2026-02-01", 10, "RHC", "0651");
    expect(
      hospiceClaimLineSnapshotIssue({
        ...deathClaim,
        lines: [deathLine],
        periods: deathPeriods,
        inclusiveEndDate: "2026-02-10",
      }),
    ).toBeNull();
    expect(
      hospiceClaimLineSnapshotIssue({ ...deathClaim, lines: [deathLine], periods: deathPeriods }),
    ).toMatchObject({ code: "MEDICAID_CLAIM_LINE_LOC_SNAPSHOT_STALE" });
  });

  it("refuses a LOC correction that makes a stored line's level or revenue code stale", () => {
    expect(
      hospiceClaimLineSnapshotIssue({
        ...claim,
        lines,
        periods: [{ ...periods[0]!, levelOfCare: "continuous_home_care" }, periods[1]!],
      }),
    ).toMatchObject({ code: "MEDICAID_CLAIM_LINE_LOC_SNAPSHOT_STALE" });
  });

  it("refuses missing, duplicate, out-of-range, or arithmetically inconsistent lines", () => {
    expect(
      hospiceClaimLineSnapshotIssue({ ...claim, lines: lines.slice(0, 1), periods }),
    ).toMatchObject({
      code: "MEDICAID_CLAIM_LINE_LOC_SNAPSHOT_STALE",
    });
    expect(
      hospiceClaimLineSnapshotIssue({ ...claim, lines: [...lines, lines[0]!], periods }),
    ).toMatchObject({ code: "MEDICAID_CLAIM_LINE_LOC_SNAPSHOT_STALE" });
    expect(
      hospiceClaimLineSnapshotIssue({
        ...claim,
        lines: [lines[0]!, { ...lines[1]!, chargesCents: 1 }],
        periods,
      }),
    ).toMatchObject({ code: "MEDICAID_CLAIM_LINE_LOC_SNAPSHOT_STALE" });
  });
});
