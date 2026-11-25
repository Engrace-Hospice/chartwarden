import { ValidationError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  MAX_ASSEMBLY_SERVICE_SPAN_DAYS,
  MEDICAID_SERVICE_DATE_INVALID,
  MEDICAID_SERVICE_SPAN_TOO_LONG,
  admissionServiceRangeIssue,
  assertAssemblyServiceSpan,
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

describe("M24 assembly service-window cap", () => {
  it("accepts a window of exactly the cap and a single day", () => {
    expect(MAX_ASSEMBLY_SERVICE_SPAN_DAYS).toBe(366);
    expect(() => assertAssemblyServiceSpan("2026-03-01", "2026-03-01")).not.toThrow();
    // 2026-01-01 .. 2027-01-01 is 366 inclusive days.
    expect(() => assertAssemblyServiceSpan("2026-01-01", "2027-01-01")).not.toThrow();
  });

  it("rejects a window one day over the cap with a typed validation error", () => {
    const attempt = () => assertAssemblyServiceSpan("2026-01-01", "2027-01-02");
    expect(attempt).toThrow(ValidationError);
    try {
      attempt();
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 422,
        details: [{ field: "serviceTo", code: MEDICAID_SERVICE_SPAN_TOO_LONG }],
      });
    }
  });

  it("rejects an open-ended window before any per-day expansion", () => {
    expect(() => assertAssemblyServiceSpan("2026-01-01", "9999-12-31")).toThrow(ValidationError);
  });

  it("rejects an invalid date with its own code and the field that is wrong", () => {
    const refusal = (from: string, to: string) => {
      try {
        assertAssemblyServiceSpan(from, to);
      } catch (error) {
        return error;
      }
      return null;
    };
    for (const [from, to, field] of [
      ["2026-01-01", "not-a-date", "serviceTo"],
      ["not-a-date", "2026-01-31", "serviceFrom"],
      // a date that exists in no calendar rolls over under Date.parse, so it is refused, not shifted
      ["2026-02-30", "2026-03-05", "serviceFrom"],
      ["2026-03-01", "2026-04-31", "serviceTo"],
    ] as const) {
      expect(refusal(from, to), `${from}..${to}`).toMatchObject({
        statusCode: 422,
        details: [{ field, code: MEDICAID_SERVICE_DATE_INVALID }],
      });
    }
  });
});
