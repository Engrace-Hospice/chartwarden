import { describe, expect, it } from "vitest";
import {
  arrangementIssue,
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
