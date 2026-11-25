import { type PatientLifecycleStatus, ValidationError } from "@chartwarden/types";

/**
 * Longest service window the assembly preview and claim assembly accept. Pricing builds one object per
 * calendar day on the shared event loop, so an open-ended window (serviceTo=9999-12-31) must be refused
 * before any day expansion. A hospice claim covers at most a billing period; a year is generous.
 */
export const MAX_ASSEMBLY_SERVICE_SPAN_DAYS = 366;
export const MEDICAID_SERVICE_SPAN_TOO_LONG = "MEDICAID_SERVICE_SPAN_TOO_LONG";

const DAY_MS = 86_400_000;

/** Reject a service window longer than the cap with a typed VALIDATION_FAILED detail (422). */
export function assertAssemblyServiceSpan(serviceFrom: string, serviceTo: string): void {
  const spanDays =
    (Date.parse(`${serviceTo.slice(0, 10)}T00:00:00.000Z`) -
      Date.parse(`${serviceFrom.slice(0, 10)}T00:00:00.000Z`)) /
      DAY_MS +
    1;
  if (!Number.isFinite(spanDays) || spanDays > MAX_ASSEMBLY_SERVICE_SPAN_DAYS) {
    throw new ValidationError("request validation failed", [
      {
        field: "serviceTo",
        code: MEDICAID_SERVICE_SPAN_TOO_LONG,
        message: `the service period must not exceed ${MAX_ASSEMBLY_SERVICE_SPAN_DAYS} days`,
      },
    ]);
  }
}

export interface PatientLifecycleForClaim {
  readonly status: PatientLifecycleStatus;
  readonly deceasedDate: string | null;
}

export interface AdmissionStayForClaim {
  readonly status:
    | "referred"
    | "pending"
    | "notice_of_rights_acknowledged"
    | "active"
    | "on_hold"
    | "discharged"
    | "bereavement"
    | "closed";
  readonly stayEndFacts: {
    readonly dischargeDate: string | null;
    readonly dischargeReason: string | null;
    readonly deceasedDate: string | null;
    readonly pendingDischargeDates: readonly string[];
    readonly transferOut: { readonly effectiveDate: string } | null;
    readonly revocationDate: string | null;
  };
}

/** M6's ended_at day is exclusive except for a death discharge with matching recorded dates. */
export function inclusiveLocEndDateForAdmission(admission: AdmissionStayForClaim): string | null {
  const { dischargeDate, dischargeReason, deceasedDate } = admission.stayEndFacts;
  return dischargeReason === "death" && dischargeDate !== null && dischargeDate === deceasedDate
    ? deceasedDate
    : null;
}

export interface ClaimRangeIssue {
  readonly code: string;
  readonly message: string;
}

/** A claim's last service date must not extend beyond a patient's recorded date of death. */
export function patientLifecycleServiceRangeIssue(
  lifecycle: PatientLifecycleForClaim | null | undefined,
  serviceTo: string,
): ClaimRangeIssue | null {
  if (!lifecycle) {
    return {
      code: "MEDICAID_PATIENT_LIFECYCLE_UNAVAILABLE",
      message:
        "Patient lifecycle could not be verified for this claim. Recheck the patient record before validation.",
    };
  }
  if (lifecycle.deceasedDate && lifecycle.status !== "deceased") {
    return {
      code: "MEDICAID_PATIENT_LIFECYCLE_INCONSISTENT",
      message:
        "The patient lifecycle and date of death do not agree. Reconcile the patient record before billing.",
    };
  }
  if (lifecycle.status === "deceased" && !lifecycle.deceasedDate) {
    return {
      code: "MEDICAID_PATIENT_DEATH_DATE_UNAVAILABLE",
      message:
        "The patient is recorded as deceased without a verified date of death. Reconcile the patient record before billing.",
    };
  }
  if (lifecycle.deceasedDate && serviceTo > lifecycle.deceasedDate) {
    return {
      code: "MEDICAID_CLAIM_AFTER_PATIENT_DEATH",
      message:
        "The claim service period extends beyond the recorded date of death and cannot be validated.",
    };
  }
  return null;
}

/**
 * Cross-check the claim period against M6's transaction-bound stay snapshot. The death date remains
 * billable; other completed stay ends and pending discharge dates are exclusive for this check.
 */
export function admissionServiceRangeIssue(
  admission: AdmissionStayForClaim | null | undefined,
  serviceTo: string,
): ClaimRangeIssue | null {
  if (!admission) {
    return {
      code: "MEDICAID_ADMISSION_LIFECYCLE_UNAVAILABLE",
      message:
        "Admission status could not be verified for this claim. Reconcile the admission before validation.",
    };
  }
  if (admission.stayEndFacts.pendingDischargeDates.some((date) => serviceTo >= date)) {
    return {
      code: "MEDICAID_ADMISSION_END_PENDING",
      message:
        "A discharge for this admission is awaiting approval within the claim period. Reconcile the discharge before validation.",
    };
  }

  const { dischargeDate, dischargeReason, deceasedDate, transferOut, revocationDate } =
    admission.stayEndFacts;
  const endFacts = [
    ...(dischargeDate
      ? [
          {
            date: dischargeReason === "death" ? (deceasedDate ?? dischargeDate) : dischargeDate,
            inclusive: dischargeReason === "death",
          },
        ]
      : []),
    ...(transferOut ? [{ date: transferOut.effectiveDate, inclusive: false }] : []),
    ...(revocationDate ? [{ date: revocationDate, inclusive: false }] : []),
  ];
  const terminal =
    admission.status === "discharged" ||
    admission.status === "bereavement" ||
    admission.status === "closed";

  const endDates = [...new Set(endFacts.map((fact) => fact.date))];
  if (
    (!terminal && endFacts.length > 0) ||
    (terminal && endFacts.length === 0) ||
    endDates.length > 1
  ) {
    return {
      code: "MEDICAID_ADMISSION_LIFECYCLE_INCONSISTENT",
      message:
        "Admission status and effective stay-end facts do not agree. Reconcile the admission before billing.",
    };
  }
  const endDate = endDates[0];
  const includesEndDate = endFacts.some((fact) => fact.inclusive);
  if (endDate && (serviceTo > endDate || (serviceTo === endDate && !includesEndDate))) {
    return {
      code: "MEDICAID_CLAIM_AFTER_ADMISSION_END",
      message:
        "The claim service period extends beyond the effective end of the hospice admission.",
    };
  }
  return null;
}
