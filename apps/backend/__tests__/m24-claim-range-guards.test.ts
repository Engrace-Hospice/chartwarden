import { describe, expect, it } from "vitest";
import {
  admissionServiceRangeIssue,
  inclusiveLocEndDateForAdmission,
  patientLifecycleServiceRangeIssue,
} from "../src/modules/24-billing-medicaid/claim-range-guards";

const activeAdmission = {
  status: "active" as const,
  stayEndFacts: {
    dischargeDate: null,
    dischargeReason: null,
    deceasedDate: null,
    pendingDischargeDates: [],
    transferOut: null,
    revocationDate: null,
  },
};

describe("M24 claim lifecycle range guards", () => {
  it("allows historical service through the recorded day of death", () => {
    expect(
      patientLifecycleServiceRangeIssue(
        { status: "deceased", deceasedDate: "2026-03-10" },
        "2026-03-10",
      ),
    ).toBeNull();
  });

  it("refuses a claim extending beyond the patient's date of death", () => {
    expect(
      patientLifecycleServiceRangeIssue(
        { status: "deceased", deceasedDate: "2026-03-10" },
        "2026-03-11",
      ),
    ).toMatchObject({ code: "MEDICAID_CLAIM_AFTER_PATIENT_DEATH" });
  });

  it("fails closed when patient lifecycle is unavailable or contradictory", () => {
    expect(patientLifecycleServiceRangeIssue(null, "2026-03-10")).toMatchObject({
      code: "MEDICAID_PATIENT_LIFECYCLE_UNAVAILABLE",
    });
    expect(
      patientLifecycleServiceRangeIssue(
        { status: "active", deceasedDate: "2026-03-10" },
        "2026-03-10",
      ),
    ).toMatchObject({ code: "MEDICAID_PATIENT_LIFECYCLE_INCONSISTENT" });
  });

  it("allows a live admission and refuses service on or after a pending discharge", () => {
    expect(admissionServiceRangeIssue(activeAdmission, "2026-03-10")).toBeNull();
    expect(
      admissionServiceRangeIssue(
        {
          ...activeAdmission,
          stayEndFacts: { ...activeAdmission.stayEndFacts, pendingDischargeDates: ["2026-03-10"] },
        },
        "2026-03-10",
      ),
    ).toMatchObject({ code: "MEDICAID_ADMISSION_END_PENDING" });
  });

  it("allows a death-day claim but refuses service after a completed death discharge", () => {
    const deceasedAdmission = {
      status: "discharged" as const,
      stayEndFacts: {
        ...activeAdmission.stayEndFacts,
        dischargeDate: "2026-03-10",
        dischargeReason: "death",
        deceasedDate: "2026-03-10",
      },
    };
    expect(admissionServiceRangeIssue(deceasedAdmission, "2026-03-10")).toBeNull();
    expect(admissionServiceRangeIssue(deceasedAdmission, "2026-03-11")).toMatchObject({
      code: "MEDICAID_CLAIM_AFTER_ADMISSION_END",
    });
  });

  it("makes only a corroborated death date an inclusive M6 LOC end date", () => {
    expect(
      inclusiveLocEndDateForAdmission({
        status: "discharged",
        stayEndFacts: {
          dischargeDate: "2026-03-10",
          dischargeReason: "death",
          deceasedDate: "2026-03-10",
          pendingDischargeDates: [],
          transferOut: null,
          revocationDate: null,
        },
      }),
    ).toBe("2026-03-10");
    expect(
      inclusiveLocEndDateForAdmission({
        status: "discharged",
        stayEndFacts: {
          dischargeDate: "2026-03-10",
          dischargeReason: "transfer",
          deceasedDate: null,
          pendingDischargeDates: [],
          transferOut: { effectiveDate: "2026-03-10" },
          revocationDate: null,
        },
      }),
    ).toBeNull();
    expect(
      inclusiveLocEndDateForAdmission({
        status: "discharged",
        stayEndFacts: {
          dischargeDate: "2026-03-10",
          dischargeReason: "death",
          deceasedDate: "2026-03-09",
          pendingDischargeDates: [],
          transferOut: null,
          revocationDate: null,
        },
      }),
    ).toBeNull();
  });

  it("accepts corroborating stay-end facts on one date but refuses conflicting dates", () => {
    const transferred = {
      status: "discharged" as const,
      stayEndFacts: {
        ...activeAdmission.stayEndFacts,
        dischargeDate: "2026-03-10",
        dischargeReason: "transfer",
        transferOut: { effectiveDate: "2026-03-10" },
      },
    };
    expect(admissionServiceRangeIssue(transferred, "2026-03-09")).toBeNull();
    expect(admissionServiceRangeIssue(transferred, "2026-03-10")).toMatchObject({
      code: "MEDICAID_CLAIM_AFTER_ADMISSION_END",
    });
    expect(
      admissionServiceRangeIssue(
        {
          ...transferred,
          stayEndFacts: { ...transferred.stayEndFacts, revocationDate: "2026-03-11" },
        },
        "2026-03-09",
      ),
    ).toMatchObject({ code: "MEDICAID_ADMISSION_LIFECYCLE_INCONSISTENT" });
  });

  it("refuses absent or inconsistent admission end facts", () => {
    expect(admissionServiceRangeIssue(null, "2026-03-10")).toMatchObject({
      code: "MEDICAID_ADMISSION_LIFECYCLE_UNAVAILABLE",
    });
    expect(
      admissionServiceRangeIssue({ ...activeAdmission, status: "discharged" }, "2026-03-10"),
    ).toMatchObject({ code: "MEDICAID_ADMISSION_LIFECYCLE_INCONSISTENT" });
  });
});
