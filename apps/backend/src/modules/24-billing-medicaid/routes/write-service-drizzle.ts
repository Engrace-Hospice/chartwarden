// apps/backend/src/modules/24-billing-medicaid/routes/write-service-drizzle.ts — the Drizzle-backed M24 WRITE
// service. Each command runs under withOrgContext (RLS), validates the §2.2 transition via the pure
// @chartwarden/medicaid-adapters reducers, stamps the acting membership, writes an append-only
// medicaid_claim_state_history row, and emits the §4.11 outbox event on the caller's tx (transactional
// outbox). A bad transition → INVALID_TRANSITION (409); a stale If-Match → STALE_VERSION (409); a missing
// row → NOT_FOUND. Money is INTEGER cents; no MBI/Recipient ID enters an outbox payload (D12 / D13 / §3.6).
//
// DEFERRAL (the M25/M26 posture): commands that need an unbound consumed reader DEGRADE to a structured typed
// error / queued no-op rather than crashing — assembleClaim (M5/M6/M40 readers), refreshEligibility (M5
// unlock + the per-state 270/271 adapter), testCredential + submitClaim adapter wire I/O (the state adapter),
// loadRateSchedule (M40), registerPlatformRule (rules are the frozen code registry). Each is noted at its site.
import { randomUUID } from "node:crypto";
import type { ClaimReader } from "@chartwarden/billing";
import { type DbClient, schema } from "@chartwarden/db";
import {
  DEFAULT_MEDICAID_RULES,
  DEFAULT_MEDICAID_RULE_SET_VERSION,
  type MedicaidValidationContext,
  type PlaceOfServiceFacilityKind,
  type PlaceOfServiceResidenceKind,
  buildHospiceLines,
  claimStructureFailure,
  deriveMedicaidControlNumber,
  deriveMedicaidTobFromAdmission,
  electronicSubmissionRefusal,
  evaluateMedicaidPayerResponsibility,
  isMedicaidCadenceBearingClaim,
  medicaidClaimMachine,
  medicaidClaimRouteReadiness,
  parseMedicaidControlNumber,
  rbArrangementMachine,
  runMedicaidRules,
} from "@chartwarden/medicaid-adapters";
import { StaleVersionError } from "@chartwarden/shared/route-kit";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  type CoverageForRange,
  ForbiddenError,
  NotFoundError,
  type PatientCoverageReader,
} from "@chartwarden/types";
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { assertTxScopedToOrg } from "../../../bootstrap/onboarding-credential-port";
import {
  type CurrentLocPeriodForClaim,
  hospiceClaimLineSnapshotIssue,
  inclusiveDeathLocPeriodId,
  m6LocClaimEndDate,
} from "../claim-hospice-line-snapshot";
import {
  type PatientLifecycleForClaim,
  admissionServiceRangeIssue,
  inclusiveLocEndDateForAdmission,
  patientLifecycleServiceRangeIssue,
} from "../claim-range-guards";
import type { CredentialCipherPort } from "../credential-crypto";
import type { M24Actor } from "./actor";
import {
  enrollmentTransactionMatches,
  resolveProgramResponsibility,
  resolveProviderPayerRoute,
  verificationSourceAllowed,
} from "./program-responsibility";
import type { ClaimView, RbArrangementView } from "./read-service";
import { resolveServiceState } from "./service-state";

const ENROLLMENT_REQUIREMENTS = [
  "state_medicaid_provider_enrollment",
  "mco_participation",
  "837i_enrollment",
  "835_era_enrollment",
  "clearinghouse_payer_route",
  "institutional_format_qualification",
  "payer_transport_certification",
  "production_activation_approval",
] as const;

function enrollmentRequirementStatus(
  rows: ReadonlyArray<typeof schema.medicaidEnrollmentEvidence.$inferSelect>,
  kind: (typeof ENROLLMENT_REQUIREMENTS)[number],
  from: string,
  to: string,
  canonicalPayerId: string | null,
  programKind: string | null,
  selectedClearinghouse: string | null,
  requiredTransactionType: "837I" | "835" | null,
): AssemblyPreviewView["enrollmentReadiness"][number] {
  if (kind === "mco_participation" && programKind === "ffs_open_card") {
    return {
      kind,
      status: "not_applicable",
      reasonCode: "MCO_PARTICIPATION_NOT_APPLICABLE_TO_FFS",
    };
  }
  if (kind !== "state_medicaid_provider_enrollment" && !canonicalPayerId) {
    return { kind, status: "unavailable", reasonCode: "PROGRAM_PAYER_IDENTITY_UNRESOLVED" };
  }
  if (
    (kind === "clearinghouse_payer_route" ||
      kind === "institutional_format_qualification" ||
      kind === "payer_transport_certification" ||
      kind === "production_activation_approval") &&
    !selectedClearinghouse
  ) {
    return { kind, status: "unavailable", reasonCode: "TENANT_CLEARINGHOUSE_SELECTION_UNBOUND" };
  }
  const relevant = rows.filter((row) => {
    if (row.evidenceKind !== kind) return false;
    if (!enrollmentTransactionMatches(row.transactionType, requiredTransactionType)) return false;
    if (row.canonicalPayerId && row.canonicalPayerId !== canonicalPayerId) return false;
    if (
      (kind === "clearinghouse_payer_route" ||
        kind === "institutional_format_qualification" ||
        kind === "payer_transport_certification" ||
        kind === "production_activation_approval") &&
      row.clearinghouse !== selectedClearinghouse
    )
      return false;
    return day(row.effectiveFrom) <= to && (!row.effectiveTo || day(row.effectiveTo) >= from);
  });
  if (relevant.length > 1)
    return { kind, status: "ambiguous", reasonCode: "ENROLLMENT_EVIDENCE_AMBIGUOUS" };
  const row = relevant[0];
  if (!row) return { kind, status: "missing", reasonCode: "ENROLLMENT_EVIDENCE_MISSING" };
  if (row.status === "revoked")
    return { kind, status: "revoked", reasonCode: "ENROLLMENT_EVIDENCE_REVOKED" };
  if (row.status === "expired" || (row.effectiveTo && day(row.effectiveTo) < to))
    return { kind, status: "expired", reasonCode: "ENROLLMENT_EVIDENCE_EXPIRED_OR_PARTIAL" };
  if (row.status === "pending")
    return { kind, status: "pending", reasonCode: "ENROLLMENT_EVIDENCE_PENDING" };
  if (row.status === "rejected")
    return { kind, status: "missing", reasonCode: "ENROLLMENT_EVIDENCE_REJECTED" };
  if (
    row.status === "verified" &&
    day(row.effectiveFrom) <= from &&
    (!row.effectiveTo || day(row.effectiveTo) >= to)
  ) {
    return { kind, status: "verified", reasonCode: "ENROLLMENT_EVIDENCE_VERIFIED" };
  }
  return { kind, status: "missing", reasonCode: "ENROLLMENT_EVIDENCE_NOT_CURRENT" };
}

function tradingPartnerCredentialStatus(
  rows: ReadonlyArray<{ activeFrom: Date; activeTo: Date | null }>,
  from: string,
  to: string,
): AssemblyPreviewView["tradingPartnerCredential"] {
  const relevant = rows.filter(
    (row) => day(row.activeFrom) <= to && (!row.activeTo || day(row.activeTo) >= from),
  );
  if (relevant.length === 0) {
    const latest = [...rows].sort((a, b) => day(b.activeFrom).localeCompare(day(a.activeFrom)))[0];
    if (latest?.activeTo && day(latest.activeTo) < from)
      return { status: "expired", reasonCode: "TRADING_PARTNER_CREDENTIAL_EXPIRED" };
    if (rows.some((row) => day(row.activeFrom) > to))
      return { status: "future", reasonCode: "TRADING_PARTNER_CREDENTIAL_FUTURE_DATED" };
    return { status: "missing", reasonCode: "TRADING_PARTNER_CREDENTIAL_MISSING" };
  }
  if (relevant.length > 1)
    return { status: "ambiguous", reasonCode: "TRADING_PARTNER_CREDENTIAL_AMBIGUOUS" };
  const row = relevant[0]!;
  if (day(row.activeFrom) > from)
    return { status: "future", reasonCode: "TRADING_PARTNER_CREDENTIAL_STARTS_DURING_WINDOW" };
  if (row.activeTo && day(row.activeTo) < to)
    return { status: "partial", reasonCode: "TRADING_PARTNER_CREDENTIAL_EXPIRES_DURING_WINDOW" };
  return { status: "configured", reasonCode: "TRADING_PARTNER_CREDENTIAL_CONFIGURED_ONLY" };
}
import type {
  ApplyOverrideInput,
  AssembleClaimInput,
  AssemblyPreviewArrangement,
  AssemblyPreviewClaimKind,
  AssemblyPreviewCoverage,
  AssemblyPreviewView,
  CreateCustomRuleInput,
  CreateRbArrangementInput,
  EditRbArrangementInput,
  EditRuleConfigInput,
  LoadRateScheduleInput,
  M24WriteService,
  OverrideRbDayInput,
  PreviewClaimAssemblyInput,
  RefreshEligibilityInput,
  RegisterPlatformRuleInput,
  ReplaceClaimInput,
  SubmitClaimInput,
  TerminateRbArrangementInput,
  UpdateDraftClaimInput,
  UpsertCredentialInput,
  VoidClaimInput,
  WriteOutboxPort,
} from "./write-service";

const NOOP_OUTBOX: WriteOutboxPort = { async publish() {} };
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

class ConflictError extends ChartWardenError {
  constructor(code: string, message: string) {
    super(code, message, 409);
    this.name = "ConflictError";
  }
}
class UnprocessableError extends ChartWardenError {
  constructor(code: string, message: string) {
    super(code, message, 422);
    this.name = "UnprocessableError";
  }
}
class DegradedError extends ChartWardenError {
  constructor(code: string, message: string) {
    super(code, message, 503);
    this.name = "DegradedError";
  }
}

const iso = (d: Date | string | null): string =>
  d === null ? "" : d instanceof Date ? d.toISOString() : new Date(d).toISOString();
const day = (d: Date | string | null): string => iso(d).slice(0, 10);
const dayN = (d: Date | string | null): string | null => (d === null ? null : day(d));

const ASSEMBLY_INPUT_ERRORS = {
  rbArrangementForbidden: [
    "MEDICAID_RB_ARRANGEMENT_NOT_APPLICABLE",
    "A hospice-only claim cannot include a Room & Board arrangement.",
  ],
  rbArrangementRequired: [
    "MEDICAID_RB_ARRANGEMENT_REQUIRED",
    "Select an applicable Room & Board arrangement for this claim kind.",
  ],
  medicareLinkUnsupported: [
    "MEDICAID_MEDICARE_LINKAGE_UNSUPPORTED",
    "A Medicare claim identifier is not verified adjudication or payment evidence. Medicare-linked COB assembly is not available yet.",
  ],
} as const;

function assertAssemblyRequestShape(input: AssembleClaimInput): void {
  if (input.medicareClaimId !== undefined) {
    throw new ConflictError(...ASSEMBLY_INPUT_ERRORS.medicareLinkUnsupported);
  }
  if (input.kind === "hospice_only" && input.rbArrangementId) {
    throw new ConflictError(...ASSEMBLY_INPUT_ERRORS.rbArrangementForbidden);
  }
  if (input.kind !== "hospice_only" && !input.rbArrangementId) {
    throw new ConflictError(...ASSEMBLY_INPUT_ERRORS.rbArrangementRequired);
  }
}

function claimStructureError(
  failure: ReturnType<typeof claimStructureFailure>,
): { code: string; message: string } | null {
  if (!failure) return null;
  switch (failure) {
    case "rb_arrangement_forbidden":
      return {
        code: "MEDICAID_RB_ARRANGEMENT_NOT_APPLICABLE",
        message: "A hospice-only claim cannot include a Room & Board arrangement.",
      };
    case "rb_arrangement_required":
      return {
        code: "MEDICAID_RB_ARRANGEMENT_REQUIRED",
        message: "Select an applicable Room & Board arrangement for this claim kind.",
      };
    case "hospice_lines_required":
      return {
        code: "MEDICAID_HOSPICE_LINES_REQUIRED",
        message: "This claim kind requires at least one valid hospice level-of-care line.",
      };
    case "rb_lines_required":
      return {
        code: "MEDICAID_RB_LINES_REQUIRED",
        message: "This claim kind requires at least one available, billable Room & Board day.",
      };
    case "hospice_lines_forbidden":
      return {
        code: "MEDICAID_HOSPICE_LINES_NOT_APPLICABLE",
        message: "An R&B-only claim cannot contain hospice level-of-care lines.",
      };
    case "rb_lines_forbidden":
      return {
        code: "MEDICAID_RB_LINES_NOT_APPLICABLE",
        message: "A hospice-only claim cannot contain Room & Board lines.",
      };
  }
}

type RbArrangementRow = typeof schema.rbArrangement.$inferSelect;

type RbArrangementAssemblyFacts = Pick<
  RbArrangementRow,
  | "id"
  | "organizationId"
  | "patientId"
  | "providerEntityId"
  | "locationId"
  | "nfFacilityMdmId"
  | "nfFacilityNameSnapshot"
  | "effectiveFrom"
  | "effectiveTo"
  | "contractDocumentId"
  | "contractStartedAt"
  | "contractTerminatedAt"
  | "state"
  | "nfPerDiemRoutineCents"
>;

function arrangementEndDate(arrangement: RbArrangementAssemblyFacts): string | null {
  const effectiveTo = dayN(arrangement.effectiveTo);
  switch (arrangement.state) {
    case "ACTIVE":
      return effectiveTo;
    case "EXPIRED":
      return effectiveTo;
    case "TERMINATED":
      return arrangement.contractTerminatedAt
        ? ([effectiveTo, day(arrangement.contractTerminatedAt)].filter(Boolean).sort()[0] ?? null)
        : null;
    case "SUPERSEDED":
      return effectiveTo;
    case "DRAFT":
      return null;
  }
}

export function arrangementIssue(
  arrangement: RbArrangementAssemblyFacts,
  organizationId: string,
  patientId: string,
  providerEntityId: string,
  serviceFrom: string,
  serviceTo: string,
  serviceDate?: string,
): { code: string; message: string } | null {
  if (
    arrangement.organizationId !== organizationId ||
    arrangement.patientId !== patientId ||
    arrangement.providerEntityId !== providerEntityId
  ) {
    return {
      code: "MEDICAID_RB_ARRANGEMENT_IDENTITY_MISMATCH",
      message: "The selected R&B arrangement is not valid for this patient and provider entity.",
    };
  }
  if (!arrangement.contractDocumentId || !arrangement.contractStartedAt) {
    return {
      code: "MEDICAID_RB_ARRANGEMENT_CONTRACT_UNVERIFIED",
      message: "The R&B arrangement lacks the contract evidence required for billing.",
    };
  }
  const endDate = arrangementEndDate(arrangement);
  if (arrangement.state === "DRAFT" || (arrangement.state !== "ACTIVE" && endDate === null)) {
    return {
      code: "MEDICAID_RB_ARRANGEMENT_STATE_UNVERIFIED",
      message: "The R&B arrangement state does not establish an effective billing period.",
    };
  }
  const startDate = day(arrangement.effectiveFrom);
  if (serviceDate) {
    if (serviceDate < startDate || (endDate !== null && serviceDate > endDate)) {
      return {
        code: "MEDICAID_RB_ARRANGEMENT_DATE_MISMATCH",
        message: "An R&B service day falls outside the arrangement's effective billing dates.",
      };
    }
  } else if (startDate > serviceTo || (endDate !== null && endDate < serviceFrom)) {
    return {
      code: "MEDICAID_RB_ARRANGEMENT_OUTSIDE_SERVICE_RANGE",
      message: "The R&B arrangement does not cover any date in this claim's service range.",
    };
  }
  if (!arrangement.nfFacilityMdmId || !arrangement.nfFacilityNameSnapshot.trim()) {
    return {
      code: "MEDICAID_RB_FACILITY_IDENTITY_MISSING",
      message: "The R&B arrangement does not contain a verified facility identity.",
    };
  }
  return null;
}

function throwAssemblyIssue(issue: { code: string; message: string }): never {
  throw new ConflictError(issue.code, issue.message);
}

type RbDayAssemblyFacts = Pick<
  typeof schema.rbDay.$inferSelect,
  | "organizationId"
  | "id"
  | "patientId"
  | "providerEntityId"
  | "locationId"
  | "rbArrangementId"
  | "serviceDate"
  | "status"
  | "locOfDay"
  | "locPeriodIdSnapshot"
  | "perDiemCentsSnapshot"
  | "exclusionReason"
  | "medicaidClaimLineId"
>;

export function rbDayIssue(
  rbDay: RbDayAssemblyFacts,
  arrangement: RbArrangementAssemblyFacts,
  organizationId: string,
  input: AssembleClaimInput,
): { code: string; message: string } | null {
  if (
    rbDay.organizationId !== organizationId ||
    rbDay.patientId !== input.patientId ||
    rbDay.providerEntityId !== input.providerEntityId ||
    rbDay.rbArrangementId !== arrangement.id ||
    rbDay.locationId !== arrangement.locationId
  ) {
    return {
      code: "MEDICAID_RB_DAY_IDENTITY_MISMATCH",
      message:
        "A Room & Board day does not match this claim's organization, patient, provider, or arrangement.",
    };
  }
  const serviceDate = day(rbDay.serviceDate);
  const arrangementIssueResult = arrangementIssue(
    arrangement,
    organizationId,
    input.patientId,
    input.providerEntityId,
    input.serviceFrom,
    input.serviceTo,
    serviceDate,
  );
  if (arrangementIssueResult) return arrangementIssueResult;
  if (rbDay.locOfDay !== "RHC" && rbDay.locOfDay !== "CHC") {
    return {
      code: "MEDICAID_RB_DAY_NOT_BILLABLE",
      message: "A Room & Board day has an ineligible level-of-care snapshot and cannot be billed.",
    };
  }
  if (rbDay.status !== "billable") {
    return {
      code: "MEDICAID_RB_DAY_NOT_BILLABLE",
      message: "A Room & Board day is not currently classified as billable.",
    };
  }
  if (
    rbDay.perDiemCentsSnapshot <= 0 ||
    rbDay.perDiemCentsSnapshot !== arrangement.nfPerDiemRoutineCents ||
    rbDay.medicaidClaimLineId !== null
  ) {
    return {
      code: "MEDICAID_RB_DAY_SNAPSHOT_INVALID",
      message: "A Room & Board day has an inconsistent rate, exclusion, or ownership snapshot.",
    };
  }
  return null;
}

export function rbDayLocSnapshotIssue(
  rbDay: Pick<RbDayAssemblyFacts, "serviceDate" | "locOfDay" | "locPeriodIdSnapshot">,
  periods: readonly {
    id: string;
    levelOfCare:
      | "routine_home_care"
      | "continuous_home_care"
      | "inpatient_respite_care"
      | "general_inpatient_care";
    effectiveAt: Date;
    endedAt: Date | null;
  }[],
  inclusiveEndDate?: string | null,
): { code: string; message: string } | null {
  const serviceDate = day(rbDay.serviceDate);
  const period = periods.find((candidate) => candidate.id === rbDay.locPeriodIdSnapshot);
  const latestPeriodForDay = periods
    .filter((candidate) => day(candidate.effectiveAt) <= serviceDate)
    .sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime())[0];
  const expectedLoc =
    period?.levelOfCare === "routine_home_care"
      ? "RHC"
      : period?.levelOfCare === "continuous_home_care"
        ? "CHC"
        : null;
  if (
    !period ||
    latestPeriodForDay?.id !== period.id ||
    expectedLoc === null ||
    expectedLoc !== rbDay.locOfDay ||
    day(period.effectiveAt) > serviceDate ||
    (period.endedAt !== null &&
      serviceDate >= day(period.endedAt) &&
      !(inclusiveEndDate === serviceDate && day(period.endedAt) === serviceDate))
  ) {
    return {
      code: "MEDICAID_RB_DAY_LOC_SNAPSHOT_STALE",
      message:
        "A Room & Board day no longer matches an eligible hospice level-of-care period for this admission.",
    };
  }
  return null;
}

type RbAdmissionSnapshot = {
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
};

/** Fail closed when a pre-materialized day lies on/after a non-death stay end or after death. */
export function rbDayAdmissionEndIssue(
  rbDay: Pick<RbDayAssemblyFacts, "serviceDate">,
  admission: RbAdmissionSnapshot,
): { code: string; message: string } | null {
  const { dischargeDate, dischargeReason, deceasedDate, transferOut, revocationDate } =
    admission.stayEndFacts;
  const serviceDate = day(rbDay.serviceDate);
  if (admission.stayEndFacts.pendingDischargeDates.some((date) => serviceDate >= date)) {
    return {
      code: "MEDICAID_RB_ADMISSION_END_PENDING",
      message:
        "A discharge for this admission is awaiting required approval. Reconcile the discharge before billing Room & Board days on or after its effective date.",
    };
  }
  const terminalStatus =
    admission.status === "discharged" ||
    admission.status === "bereavement" ||
    admission.status === "closed";
  const endFacts = [
    ...(dischargeDate
      ? [
          {
            date: dischargeReason === "death" ? (deceasedDate ?? dischargeDate) : dischargeDate,
            includesDate: dischargeReason === "death",
          },
        ]
      : []),
    ...(transferOut ? [{ date: transferOut.effectiveDate, includesDate: false }] : []),
    ...(revocationDate ? [{ date: revocationDate, includesDate: false }] : []),
  ];
  if (!terminalStatus && endFacts.length === 0) return null;
  if (!terminalStatus || endFacts.length !== 1) {
    return {
      code: "MEDICAID_RB_ADMISSION_END_UNVERIFIED",
      message:
        "The admission end date or reason cannot be established consistently; reconcile the stay before billing Room & Board days.",
    };
  }
  const end = endFacts[0];
  if (!end) return null;
  if (serviceDate > end.date || (serviceDate === end.date && !end.includesDate)) {
    return {
      code: "MEDICAID_RB_DAY_OUTSIDE_ADMISSION",
      message:
        "A Room & Board day is on or after the effective end of this admission and cannot be included in this claim.",
    };
  }
  return null;
}

type RbClaimLineFacts = Pick<
  typeof schema.medicaidClaimLine.$inferSelect,
  | "id"
  | "organizationId"
  | "providerEntityId"
  | "locationId"
  | "locPeriodId"
  | "medicaidClaimId"
  | "serviceDate"
  | "revenueCode"
  | "qCode"
  | "levelOfCare"
  | "units"
  | "rateAtAssemblyCents"
  | "stateRateScheduleIdSnapshot"
  | "chargesCents"
  | "isRb"
  | "rbDayId"
>;

/** Verify a stored R&B line still owns the exact billed day and current eligible LOC snapshot. */
export function rbClaimLineIssue(input: {
  readonly line: RbClaimLineFacts;
  readonly rbDay: RbDayAssemblyFacts;
  readonly arrangement: RbArrangementAssemblyFacts;
  readonly organizationId: string;
  readonly patientId: string;
  readonly providerEntityId: string;
  readonly claimId: string;
  readonly arrangementId: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly admission: RbAdmissionSnapshot;
  readonly locPeriods: readonly {
    id: string;
    levelOfCare:
      | "routine_home_care"
      | "continuous_home_care"
      | "inpatient_respite_care"
      | "general_inpatient_care";
    effectiveAt: Date;
    endedAt: Date | null;
  }[];
}): { code: string; message: string } | null {
  const { line, rbDay, arrangement } = input;
  if (
    !line.isRb ||
    line.rbDayId !== rbDay.id ||
    line.medicaidClaimId !== input.claimId ||
    line.organizationId !== input.organizationId ||
    line.providerEntityId !== input.providerEntityId ||
    line.locationId !== rbDay.locationId ||
    line.locationId !== arrangement.locationId ||
    rbDay.organizationId !== input.organizationId ||
    rbDay.patientId !== input.patientId ||
    rbDay.providerEntityId !== input.providerEntityId ||
    rbDay.locationId !== arrangement.locationId ||
    rbDay.rbArrangementId !== input.arrangementId ||
    arrangement.id !== input.arrangementId ||
    rbDay.status !== "billed" ||
    rbDay.medicaidClaimLineId !== line.id
  ) {
    return {
      code: "MEDICAID_RB_DAY_CLAIM_OWNERSHIP_MISMATCH",
      message:
        "A Room & Board claim line no longer matches the billed day and its current claim owner. Reconcile the claim before validation.",
    };
  }
  const serviceDate = day(rbDay.serviceDate);
  if (serviceDate < input.serviceFrom || serviceDate > input.serviceTo) {
    return {
      code: "MEDICAID_RB_DAY_SERVICE_RANGE_MISMATCH",
      message:
        "A Room & Board day linked to this claim falls outside the claim's service period. Reconcile the claim before validation.",
    };
  }
  const arrangementProblem = arrangementIssue(
    arrangement,
    input.organizationId,
    input.patientId,
    input.providerEntityId,
    input.serviceFrom,
    input.serviceTo,
    serviceDate,
  );
  if (arrangementProblem) return arrangementProblem;
  if (
    day(line.serviceDate) !== serviceDate ||
    line.levelOfCare !== "NF_RB" ||
    line.locPeriodId !== rbDay.locPeriodIdSnapshot ||
    line.units !== 1 ||
    line.revenueCode !== "0658" ||
    line.qCode !== "Q5003" ||
    line.rateAtAssemblyCents !== rbDay.perDiemCentsSnapshot ||
    line.chargesCents !== rbDay.perDiemCentsSnapshot ||
    line.stateRateScheduleIdSnapshot !== null
  ) {
    return {
      code: "MEDICAID_RB_DAY_CLAIM_LINE_MISMATCH",
      message:
        "A Room & Board line no longer matches its billed day snapshot. Reconcile the claim before validation.",
    };
  }
  const deathDate =
    input.admission.stayEndFacts.dischargeReason === "death"
      ? (input.admission.stayEndFacts.deceasedDate ?? input.admission.stayEndFacts.dischargeDate)
      : null;
  return (
    rbDayAdmissionEndIssue(rbDay, input.admission) ??
    rbDayLocSnapshotIssue(rbDay, input.locPeriods, deathDate)
  );
}

/**
 * Refuse to store a secret when no cipher port is bound, rather than dropping it. The pre-crypto placeholder
 * accepted the secret and wrote a sentinel — the caller believed it was saved. Failing loudly is the only
 * honest option when the KEK is absent.
 */
const UNBOUND_CIPHER: CredentialCipherPort = {
  seal() {
    throw new DegradedError(
      "CREDENTIAL_CRYPTO_UNBOUND",
      "credential secrets cannot be stored — M24_CREDENTIAL_ENCRYPTION_KEY is not configured",
    );
  },
  open() {
    throw new DegradedError(
      "CREDENTIAL_CRYPTO_UNBOUND",
      "credential secrets cannot be read — M24_CREDENTIAL_ENCRYPTION_KEY is not configured",
    );
  },
};

/**
 * How the write path resolves a patient's Medicaid and actual primary coverage. Bound at the composition root to M5's §3.4
 * `PatientCoverageReader` seam (via getSeam); left undefined in a slice/test, where the paths that need it
 * degrade with a precise message instead of a blanket "readers unbound".
 */
export interface CoverageResolverPort {
  activeMedicaidCoverage(input: {
    organizationId: string;
    patientId: string;
    onDate: string;
  }): Promise<{ id: string; payerId: string; subscriberId: string; rank: number } | null>;
  claimCoverageForRange(input: {
    organizationId: string;
    patientId: string;
    from: string;
    to: string;
  }): Promise<{ medicaid: CoverageForRange; primary: CoverageForRange }>;
  claimCoverageSnapshotInTransaction(
    transaction: unknown,
    input: {
      organizationId: string;
      patientId: string;
      from: string;
      to: string;
    },
  ): Promise<{
    medicaid: CoverageForRange;
    primary: CoverageForRange;
    patientLifecycle: PatientLifecycleForClaim | null;
  }>;
}

/**
 * The production {@link CoverageResolverPort} over M5's §3.4 `PatientCoverageReader` seam, resolved at CALL time so
 * registration order does not matter. Claim assembly resolves Medicaid and all-kind primary coverage range-wide;
 * its transaction path derives both from one M5 row-locked snapshot. Eligibility refresh remains a point read.
 */
export function buildM24MedicaidCoverageResolver(
  reader: () => Pick<
    PatientCoverageReader,
    "activeCoverageOfKind" | "coverageForRange" | "coverageSnapshotForRangeInTransaction"
  >,
): CoverageResolverPort {
  return {
    async activeMedicaidCoverage(q) {
      const found = await reader().activeCoverageOfKind({
        organizationId: q.organizationId,
        patientId: q.patientId,
        coverageKind: "medicaid",
        onDate: q.onDate,
      });
      return found
        ? {
            id: found.id,
            payerId: found.payerId,
            subscriberId: found.subscriberId,
            rank: found.rank,
          }
        : null;
    },
    async claimCoverageForRange(q) {
      const r = reader();
      const range = { from: q.from, to: q.to };
      const [medicaid, primary] = await Promise.all([
        r.coverageForRange({
          organizationId: q.organizationId,
          patientId: q.patientId,
          ...range,
          coverageKind: "medicaid",
        }),
        r.coverageForRange({
          organizationId: q.organizationId,
          patientId: q.patientId,
          ...range,
        }),
      ]);
      return { medicaid, primary };
    },
    async claimCoverageSnapshotInTransaction(transaction, q) {
      const snapshot = await reader().coverageSnapshotForRangeInTransaction(transaction, {
        organizationId: q.organizationId,
        patientId: q.patientId,
        from: q.from,
        to: q.to,
        coverageKind: "medicaid",
      });
      return {
        medicaid: snapshot.resolution,
        primary: snapshot.primaryResolution,
        patientLifecycle: snapshot.patientLifecycle,
      };
    },
  };
}

function coverageResolutionKey(resolution: CoverageForRange): string {
  return resolution.status === "uniform"
    ? `uniform:${resolution.coverage.id}:${resolution.coverage.payerId}:${resolution.coverage.rank}:${resolution.coverage.coverageKind}`
    : `${resolution.status}:${resolution.onDate}`;
}

function requireUniformClaimCoverage(
  resolution: CoverageForRange,
  role: "medicaid" | "primary",
): Extract<CoverageForRange, { status: "uniform" }>["coverage"] {
  if (resolution.status === "uniform") return resolution.coverage;

  if (role === "medicaid") {
    switch (resolution.status) {
      case "none":
        throw new ConflictError(
          "MEDICAID_COVERAGE_NOT_IN_FORCE",
          "No single Medicaid coverage is in force for the complete service window. Correct the coverage dates or split the claim at the coverage change.",
        );
      case "changes":
        throw new ConflictError(
          "MEDICAID_COVERAGE_CHANGED",
          `Medicaid coverage changes within the service window (starting ${resolution.onDate}). Correct the coverage dates or split the claim at that boundary.`,
        );
      case "ambiguous":
        throw new ConflictError(
          "MEDICAID_COVERAGE_AMBIGUOUS",
          `More than one Medicaid coverage has the same highest rank on ${resolution.onDate}. Resolve the coverage overlap before assembling a claim.`,
        );
    }
  }

  switch (resolution.status) {
    case "none":
      throw new ConflictError(
        "MEDICAID_PRIMARY_COVERAGE_MISSING",
        "The patient's primary coverage is missing for part or all of this service window. Correct the coverage record before assembling a Medicaid claim.",
      );
    case "changes":
      throw new ConflictError(
        "MEDICAID_PRIMARY_COVERAGE_CHANGED",
        `The patient's highest-ranked coverage changes within the service window (starting ${resolution.onDate}). Correct the coverage dates or split the claim at that boundary.`,
      );
    case "ambiguous":
      throw new ConflictError(
        "MEDICAID_PRIMARY_COVERAGE_AMBIGUOUS",
        `More than one coverage has the same highest rank on ${resolution.onDate}. Resolve the overlap before assembling a Medicaid claim.`,
      );
  }
}

function assertMedicaidPayerResponsibility(
  kind: AssembleClaimInput["kind"],
  medicaid: Extract<CoverageForRange, { status: "uniform" }>["coverage"],
  primary: Extract<CoverageForRange, { status: "uniform" }>["coverage"],
): void {
  const decision = evaluateMedicaidPayerResponsibility({
    claimKind: kind,
    medicaidCoverageId: medicaid.id,
    medicaidRank: medicaid.rank,
    primaryCoverageId: primary.id,
    primaryCoverageKind: primary.coverageKind,
    primaryRank: primary.rank,
  });
  if (decision.allowed) return;

  switch (decision.reason) {
    case "rank_one_coverage_missing":
      throw new ConflictError(
        "MEDICAID_PRIMARY_COVERAGE_MISSING",
        "No rank-1 coverage is established for the complete service window. Medicaid ranked second or higher cannot be treated as primary; correct the coverage records before assembly.",
      );
    case "tertiary_medicaid_unsupported":
      throw new ConflictError(
        "MEDICAID_TERTIARY_BILLING_UNSUPPORTED",
        "Tertiary Medicaid billing is not authorized by the current payer-responsibility policy.",
      );
    case "coverage_identity_conflict":
      throw new ConflictError(
        "MEDICAID_COVERAGE_RESOLUTION_CONFLICT",
        "The selected Medicaid coverage does not match the resolved rank-1 payer. Review the coverage records before assembly.",
      );
    case "medicare_hospice_is_primary":
      throw new ConflictError(
        "MEDICARE_PRIMARY_HOSPICE_RESPONSIBILITY",
        "Medicare is primary for hospice-covered services. Assemble those services through M23; no secondary Medicaid hospice-only claim is assembled here.",
      );
    case "medicare_secondary_rb_format_unconfirmed":
      throw new ConflictError(
        "MEDICAID_SECONDARY_RB_FORMAT_UNVERIFIED",
        "Medicaid may have a distinct Room & Board responsibility for a qualifying Medicare-primary patient, but the applicable secondary R&B-only claim format is unverified. This is not a Medicaid eligibility denial; assembly remains blocked pending state-format confirmation.",
      );
    case "medicare_secondary_combined_format_unconfirmed":
      throw new ConflictError(
        "MEDICAID_SECONDARY_COMBINED_FORMAT_UNVERIFIED",
        "The secondary combined hospice and Room & Board claim format and its Medicare COB treatment are unverified. This is not a Medicaid eligibility denial; assembly remains blocked pending state-format confirmation.",
      );
    case "third_party_liability_policy_unconfirmed":
      throw new ConflictError(
        "MEDICAID_TPL_POLICY_UNVERIFIED",
        "The applicable Medicaid third-party-liability policy for this primary payer and claim kind is not established. Resolve payer responsibility before assembly.",
      );
  }
}

function coveragePreview(resolution: CoverageForRange): AssemblyPreviewCoverage {
  return resolution.status === "uniform"
    ? {
        status: "uniform",
        coverageKind: resolution.coverage.coverageKind,
        rank: resolution.coverage.rank,
      }
    : { status: resolution.status, coverageKind: null, rank: null };
}

function coverageRefusalCode(
  role: "medicaid" | "primary",
  resolution: CoverageForRange,
): string | null {
  if (resolution.status === "uniform") return null;
  if (role === "medicaid") {
    return {
      none: "MEDICAID_COVERAGE_NOT_IN_FORCE",
      changes: "MEDICAID_COVERAGE_CHANGED",
      ambiguous: "MEDICAID_COVERAGE_AMBIGUOUS",
    }[resolution.status];
  }
  return {
    none: "MEDICAID_PRIMARY_COVERAGE_MISSING",
    changes: "MEDICAID_PRIMARY_COVERAGE_CHANGED",
    ambiguous: "MEDICAID_PRIMARY_COVERAGE_AMBIGUOUS",
  }[resolution.status];
}

function payerPolicyReasonCode(reason: string): string {
  switch (reason) {
    case "rank_one_coverage_missing":
      return "MEDICAID_PRIMARY_COVERAGE_MISSING";
    case "tertiary_medicaid_unsupported":
      return "MEDICAID_TERTIARY_BILLING_UNSUPPORTED";
    case "coverage_identity_conflict":
      return "MEDICAID_COVERAGE_RESOLUTION_CONFLICT";
    case "medicare_hospice_is_primary":
      return "MEDICARE_PRIMARY_HOSPICE_RESPONSIBILITY";
    case "medicare_secondary_rb_format_unconfirmed":
      return "MEDICAID_SECONDARY_RB_FORMAT_UNVERIFIED";
    case "medicare_secondary_combined_format_unconfirmed":
      return "MEDICAID_SECONDARY_COMBINED_FORMAT_UNVERIFIED";
    case "third_party_liability_policy_unconfirmed":
      return "MEDICAID_TPL_POLICY_UNVERIFIED";
    default:
      return "MEDICAID_PAYER_RESPONSIBILITY_UNRESOLVED";
  }
}

function claimKindPreviews(
  medicaid: CoverageForRange,
  primary: CoverageForRange,
): AssemblyPreviewClaimKind[] {
  const kinds: AssembleClaimInput["kind"][] = ["hospice_only", "rb_only", "combined_hospice_rb"];
  if (medicaid.status !== "uniform" || primary.status !== "uniform") {
    const reasonCode =
      coverageRefusalCode("medicaid", medicaid) ?? coverageRefusalCode("primary", primary);
    return kinds.map((kind) => ({ kind, payerPolicy: "unresolved", reasonCode }));
  }
  return kinds.map((kind) => {
    const decision = evaluateMedicaidPayerResponsibility({
      claimKind: kind,
      medicaidCoverageId: medicaid.coverage.id,
      medicaidRank: medicaid.coverage.rank,
      primaryCoverageId: primary.coverage.id,
      primaryCoverageKind: primary.coverage.coverageKind,
      primaryRank: primary.coverage.rank,
    });
    return {
      kind,
      payerPolicy: decision.allowed ? "permitted" : "blocked",
      reasonCode: decision.allowed ? null : payerPolicyReasonCode(decision.reason),
    };
  });
}

/**
 * How the write path resolves a provider entity's CMS Certification Number (the control-number namespace,
 * D4). `provider_entity` is M1-owned — the table-ownership gate forbids this module's own Drizzle schema
 * from touching it, so the read lives at the composition root (outside every module's codePaths) and is
 * injected here, mirroring `CoverageResolverPort`'s "degrade with a precise message" posture when absent.
 */
export interface ProviderEntityCcnReader {
  ccnForProviderEntity(organizationId: string, providerEntityId: string): Promise<string | null>;
}

/** M40's canonical, merge-aware payer identity reader. A candidate UUID alone is never payer proof. */
export interface CanonicalPayerIdentityReader {
  resolvePayer(
    organizationId: string,
    canonicalPayerId: string,
  ): Promise<{
    id: string;
    displayName: string;
    kind: string;
    stateCode: string | null;
    status: "active" | "deactivated" | "provisional";
  } | null>;
}
export interface TenantClearinghouseReadPort {
  selectedTenantRoute(organizationId: string): Promise<{
    source: "tenant" | "platform_env" | "none";
    vendor: string | null;
    status: string | null;
  }>;
}

/** M6-owned transaction-bound admission snapshot and row lock shared by claim cadence and LOC writes. */
export interface AdmissionCadenceReaderPort {
  previewSnapshotInTransaction?(
    transaction: unknown,
    organizationId: string,
    admissionId: string,
  ): Promise<{
    patientId: string;
    providerEntityId: string | null;
    locationId: string | null;
    serviceAddressState: string | null;
    dischargedAt: Date | null;
    status:
      | "referred"
      | "pending"
      | "notice_of_rights_acknowledged"
      | "active"
      | "on_hold"
      | "discharged"
      | "bereavement"
      | "closed";
    stayEndFacts: RbAdmissionSnapshot["stayEndFacts"];
  } | null>;
  cadenceSnapshotInTransaction(
    transaction: unknown,
    organizationId: string,
    admissionId: string,
  ): Promise<{
    patientId: string;
    providerEntityId: string | null;
    locationId: string | null;
    serviceAddressState: string | null;
    dischargedAt: Date | null;
    status:
      | "referred"
      | "pending"
      | "notice_of_rights_acknowledged"
      | "active"
      | "on_hold"
      | "discharged"
      | "bereavement"
      | "closed";
    stayEndFacts: RbAdmissionSnapshot["stayEndFacts"];
  } | null>;
  /** Current LOC rows on the same transaction, after cadenceSnapshotInTransaction has locked the admission. */
  periodsForAdmissionInTransaction?(
    transaction: unknown,
    organizationId: string,
    admissionId: string,
  ): Promise<
    ReadonlyArray<{
      id: string;
      levelOfCare:
        | "routine_home_care"
        | "continuous_home_care"
        | "inpatient_respite_care"
        | "general_inpatient_care";
      effectiveAt: Date;
      endedAt: Date | null;
      facilityId: string | null;
      ipuBedAssignmentId: string | null;
    }>
  >;
}

/** Resolve state-specific adjustment TOBs through the registered MedicaidAdapter. */
export interface MedicaidAdjustmentAdapterResolverPort {
  adapterForState(state: string): {
    replacementTob(originalTob: string): string;
    voidTob(originalTob: string): string;
  } | null;
}

/** M6's `level_of_care_period` raw list (per-line assembly follow-up). `level_of_care_period` is M6-owned —
 * same "composition-root escape valve" posture as `ProviderEntityCcnReader` (the read lives outside every
 * module's codePaths: M6's `createAdmissionLocPeriodsReader`, bound in apps/backend/src/index.ts), injected here as a narrow port). `facilityId`/
 * `ipuBedAssignmentId` (place-of-service follow-up) are the same two pre-existing M6 columns, just now
 * also selected — M6's own write path does not populate them for IRC/GIP yet (a separate, pre-existing
 * M6-T04 gap — `changeLoc` hardcodes `facilityId: null`), so they read null in practice until that lands;
 * reading them regardless costs nothing and needs no further M24 change once M6 starts writing them. */
export interface LevelOfCarePeriodReaderPort {
  periodsForAdmission(
    organizationId: string,
    admissionId: string,
  ): Promise<
    ReadonlyArray<{
      id: string;
      levelOfCare:
        | "routine_home_care"
        | "continuous_home_care"
        | "inpatient_respite_care"
        | "general_inpatient_care";
      effectiveAt: Date;
      endedAt: Date | null;
      facilityId: string | null;
      ipuBedAssignmentId: string | null;
    }>
  >;
}

/** `facility.kind` (M40) for a batch of facility ids (place-of-service follow-up). `facility` is
 * NON_ORG_SCOPED/M40-owned — same composition-root escape-valve posture as `LevelOfCarePeriodReaderPort`.
 * Batched (not per-id) so resolving a claim's LOC periods + residence never issues more than one query. */
export interface FacilityKindReaderPort {
  kindsFor(
    facilityIds: readonly string[],
  ): Promise<ReadonlyMap<string, PlaceOfServiceFacilityKind>>;
}

/**
 * M40's LIVE `MdmEntityProvider` seam, narrowed to the one question an R&B arrangement asks it
 * (GAP-040): what is this nursing facility's canonical display name, right now, at contract time?
 *
 * `rb_arrangement.nf_facility_name_snapshot` is a SNAPSHOT — the name as it stood when the contract was
 * signed, deliberately frozen against later MDM renames, and surfaced verbatim through the read API. It
 * was written as the literal string "[unresolved — M40 facility resolver deferred]" on every create,
 * even though M40's provider has been registered over a Drizzle store at boot since M40 landed.
 *
 * Resolved through the SEAM rather than a direct `facility` read (the `FacilityKindReaderPort`
 * escape-valve above) because the seam chases `merged_into_id` (§7.2): a facility canonical that was
 * merged after the tenant picked it must snapshot the SURVIVOR's name, not a dead row's.
 */
export interface FacilityNameResolverPort {
  resolveFacility(
    orgId: string,
    id: string,
  ): Promise<{ readonly canonical: { readonly displayName: string } } | null>;
}

/** M5's LIVE `PatientAddressReader` seam (place-of-service follow-up) — the patient's residence kind/
 * facility as of a given date, for RHC/CHC's home-vs-facility Q-code disambiguation. Optional: an absent
 * binding degrades to the LOC-based Q-code default (via `resolvePlaceOfServiceQCode`'s own fallback), not
 * a hard failure — residence is a refinement, not a required input to assembling the claim. */
export interface ResidenceReaderPort {
  residenceAt(
    organizationId: string,
    patientId: string,
    asOfDate: string,
  ): Promise<{ kind: PlaceOfServiceResidenceKind; facilityId: string | null } | null>;
}

/** M8's LIVE `SignedEncountersReader` seam, narrowed to what claim assembly needs (backing-encounter
 * evidence for a line, not the full digest). Bound at the composition root via `getSeam`. Optional: an
 * absent binding degrades to zero linked encounters rather than blocking assembly — the LOC period is the
 * authoritative billing basis; encounter linkage is supplementary audit evidence, not a NOT-NULL input. */
export interface SignedEncounterWindowReaderPort {
  encountersInWindow(
    organizationId: string,
    patientId: string,
    from: string,
    to: string,
  ): Promise<ReadonlyArray<{ encounterId: string; serviceDate: string }>>;
}

const LOC_BY_M6_ENUM: Record<
  | "routine_home_care"
  | "continuous_home_care"
  | "inpatient_respite_care"
  | "general_inpatient_care",
  "RHC" | "CHC" | "IRC" | "GIP"
> = {
  routine_home_care: "RHC",
  continuous_home_care: "CHC",
  inpatient_respite_care: "IRC",
  general_inpatient_care: "GIP",
};

export function buildDrizzleM24WriteService(
  db: DbClient,
  outbox: WriteOutboxPort = NOOP_OUTBOX,
  cipher: CredentialCipherPort = UNBOUND_CIPHER,
  coverage?: CoverageResolverPort,
  ccnReader?: ProviderEntityCcnReader,
  locPeriodReader?: LevelOfCarePeriodReaderPort,
  signedEncounters?: SignedEncounterWindowReaderPort,
  facilityKindReader?: FacilityKindReaderPort,
  residenceReader?: ResidenceReaderPort,
  facilityNames?: FacilityNameResolverPort,
  /** S11: false when the state's gateway is not wired in this deployment (Oregon with no launch gateway). */
  isGatewayBound: (state: string) => boolean = () => true,
  admissionCadenceReader?: AdmissionCadenceReaderPort,
  adjustmentAdapters?: MedicaidAdjustmentAdapterResolverPort,
  medicareClaimReader?: () => Pick<ClaimReader, "medicareSecondaryContext">,
  canonicalPayerReader?: CanonicalPayerIdentityReader,
  tenantClearinghouseReader?: TenantClearinghouseReadPort,
): M24WriteService {
  const C = schema.medicaidClaim;
  const SUB = schema.medicaidSubmission;
  const VR = schema.medicaidValidationRun;
  const VRES = schema.medicaidValidationResult;
  const VOV = schema.medicaidValidationOverride;
  const RC = schema.medicaidValidationRuleConfig;
  const A = schema.rbArrangement;
  const RD = schema.rbDay;
  const TP = schema.stateMedicaidTradingPartnerCredential;
  const EC = schema.medicaidEligibilityCheck;
  const SH = schema.medicaidClaimStateHistory;
  const SPC = schema.medicaidStatePlanCode;
  const PA = schema.medicaidProgramAssignment;
  const EE = schema.medicaidEnrollmentEvidence;
  const L = schema.medicaidClaimLine;
  const LE = schema.medicaidClaimLineEncounter;
  const RULES_BY_KEY = new Map(DEFAULT_MEDICAID_RULES.map((r) => [r.key, r]));

  async function loadClaim(tx: Tx, claimId: string, lockForUpdate = false) {
    const q = tx.select().from(C).where(eq(C.id, claimId)).limit(1);
    const rows = await (lockForUpdate ? q.for("update") : q);
    if (!rows[0]) throw new NotFoundError("medicaid claim not found");
    return rows[0];
  }

  /**
   * GAP-040 — resolve the NF's canonical display name for the contract snapshot. FAILS the write when
   * the resolver is unbound or the id resolves to nothing: an R&B arrangement names a real nursing
   * facility the agency has a pass-through contract with, and a snapshot that says anything other than
   * that facility's name is worse than no arrangement at all — it is surfaced verbatim on the
   * arrangement view and read as the contracted party. A placeholder is not a degraded answer here, it
   * is a wrong one.
   */
  async function resolveNfFacilityName(orgId: string, facilityMdmId: string): Promise<string> {
    if (!facilityNames) {
      throw new DegradedError(
        "MDM_FACILITY_RESOLVER_UNBOUND",
        "the NF facility name cannot be snapshotted — M40's MdmEntityProvider is not bound",
      );
    }
    const resolved = await facilityNames.resolveFacility(orgId, facilityMdmId);
    if (!resolved) {
      throw new ChartWardenError(
        "NF_FACILITY_NOT_FOUND",
        `no M40 facility resolves for '${facilityMdmId}' — pick the facility from the master-data list`,
        422,
      );
    }
    return resolved.canonical.displayName;
  }
  function assertVersion(row: { version: number }, expected: number | null): void {
    if (expected !== null && row.version !== expected) {
      throw new StaleVersionError("the If-Match version is stale; reload and retry");
    }
  }
  async function recordHistory(
    tx: Tx,
    orgId: string,
    claimId: string,
    fromState: (typeof C.state.enumValues)[number] | null,
    toState: (typeof C.state.enumValues)[number],
    actorMembershipId: string,
    reason: string | null,
  ): Promise<void> {
    await tx.insert(SH).values({
      organizationId: orgId,
      medicaidClaimId: claimId,
      fromState,
      toState,
      reason,
      triggerSource: "user",
      actorMembershipId,
    });
  }

  async function abandonPreSubmissionClaim(
    tx: Tx,
    actor: M24Actor,
    claim: typeof C.$inferSelect,
  ): Promise<typeof C.$inferSelect> {
    const preSubmission = new Set([
      "DRAFT",
      "FAILED_VALIDATION",
      "READY",
      "FAILED_MEDICARE_PRIMARY",
    ]);
    if (preSubmission.has(claim.state) || claim.state === "ACK_REJECTED") {
      if (preSubmission.has(claim.state)) {
        const submissions = await tx
          .select({ id: SUB.id })
          .from(SUB)
          .where(
            and(eq(SUB.organizationId, actor.organizationId), eq(SUB.medicaidClaimId, claim.id)),
          )
          .limit(1);
        if (submissions.length > 0) {
          throw new ConflictError(
            "MEDICAID_CLAIM_SUBMISSION_EXISTS",
            "This claim has a submission record and cannot use the pre-submission abandonment path.",
          );
        }
      }
      const lines = await tx
        .select({ isRb: L.isRb })
        .from(L)
        .where(
          and(
            eq(L.organizationId, actor.organizationId),
            eq(L.providerEntityId, claim.providerEntityId),
            eq(L.medicaidClaimId, claim.id),
          ),
        );
      if (lines.some((line) => line.isRb)) {
        throw new ConflictError(
          "MEDICAID_RB_DAYS_REQUIRE_RECONCILIATION",
          "This claim owns Room & Board days. Reconcile the rejected submission and day eligibility before abandoning it; the claim and its audit evidence were left unchanged.",
        );
      }
    }
    const reduced = medicaidClaimMachine.reduce(claim.state, "abandon");
    if (reduced.error) {
      throw new ConflictError("INVALID_TRANSITION", `cannot abandon from ${claim.state}`);
    }
    const now = new Date();
    const updated = await tx
      .update(C)
      .set({
        state: "ABANDONED",
        version: claim.version + 1,
        updatedAt: now,
        updatedByMembershipId: actor.userId,
      })
      .where(
        and(
          eq(C.id, claim.id),
          eq(C.organizationId, actor.organizationId),
          eq(C.version, claim.version),
        ),
      )
      .returning();
    if (!updated[0]) throw new StaleVersionError("the claim changed; reload before abandoning");
    await recordHistory(
      tx,
      actor.organizationId,
      claim.id,
      claim.state,
      "ABANDONED",
      actor.userId,
      claim.state === "ACK_REJECTED" ? "abandon_rejected_submission" : "abandon_pre_submission",
    );
    return updated[0];
  }

  function toClaimView(r: typeof C.$inferSelect): ClaimView {
    return {
      id: r.id,
      providerEntityId: r.providerEntityId,
      patientId: r.patientId,
      admissionId: r.admissionId,
      serviceState: r.serviceState,
      kind: r.kind,
      tob: r.tob,
      serviceFrom: day(r.serviceFrom),
      serviceTo: day(r.serviceTo),
      mcoId: r.mcoId ?? null,
      medicaidProgramKind: r.medicaidProgramKind ?? null,
      canonicalPayerId: r.canonicalPayerId ?? null,
      programResolutionSnapshot: r.programResolutionSnapshot ?? null,
      medicareClaimId: r.medicareClaimId ?? null,
      rbArrangementId: r.rbArrangementId ?? null,
      medicaidClaimControlNumber: r.medicaidClaimControlNumber,
      state: r.state,
      version: r.version,
      validationRunIdLatest: r.validationRunIdLatest ?? null,
      eligibilityOutcomeSnapshot: r.eligibilityOutcomeSnapshot ?? null,
      electronicSubmissionRefusal:
        electronicSubmissionRefusal(
          r.serviceState,
          isGatewayBound(r.serviceState),
          r.mcoId ?? null,
          r.medicaidProgramKind ?? "unresolved",
          (r.programResolutionSnapshot as { status?: unknown } | null)?.status === "verified",
        )?.message ?? null,
      routeReadiness: medicaidClaimRouteReadiness(
        r.serviceState,
        r.mcoId ?? null,
        isGatewayBound(r.serviceState),
        r.medicaidProgramKind ?? "unresolved",
        (r.programResolutionSnapshot as { status?: unknown } | null)?.status === "verified",
      ),
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
    };
  }
  function toArrangementView(r: typeof A.$inferSelect): RbArrangementView {
    return {
      id: r.id,
      patientId: r.patientId,
      providerEntityId: r.providerEntityId,
      nfFacilityMdmId: r.nfFacilityMdmId,
      nfFacilityNameSnapshot: r.nfFacilityNameSnapshot,
      effectiveFrom: day(r.effectiveFrom),
      effectiveTo: dayN(r.effectiveTo),
      nfPerDiemRoutineCents: r.nfPerDiemRoutineCents,
      nfPerDiemRespCents: r.nfPerDiemRespCents,
      nfPerDiemGipCents: r.nfPerDiemGipCents,
      passThroughPct: r.passThroughPct,
      retentionPct: r.retentionPct,
      state: r.state,
      version: r.version,
      createdAt: iso(r.createdAt),
    };
  }

  /** Insert or version-bump one provider entity's state trading-partner credential, on `tx` (RLS already scoped). */
  async function upsertCredentialRow(
    tx: Tx,
    actor: M24Actor,
    input: UpsertCredentialInput,
  ): Promise<{ id: string }> {
    const existing = await tx
      .select()
      .from(TP)
      .where(
        and(
          eq(TP.organizationId, actor.organizationId),
          eq(TP.providerEntityId, input.providerEntityId),
          eq(TP.serviceState, input.serviceState),
          eq(TP.channel, input.channel),
        ),
      )
      .limit(1);
    // §8.7 envelope encryption under the per-tenant HKDF DEK. A submitted secret is SEALED (never
    // stored plaintext, never returned by any read); an omitted secret leaves the existing cipher
    // untouched, so a PATCH-shaped upsert cannot silently blank a credential. With no KEK bound the
    // seal THROWS — storing a sentinel and reporting success is what the placeholder did wrong.
    const clientSecretCipher =
      input.clientSecret != null
        ? cipher.seal(actor.organizationId, input.clientSecret)
        : (existing[0]?.clientSecretCipher ?? null);
    const sftpKeyCipher =
      input.sftpKey != null
        ? cipher.seal(actor.organizationId, input.sftpKey)
        : (existing[0]?.sftpKeyCipher ?? null);
    let id: string;
    let version: number;
    if (existing[0]) {
      id = existing[0].id;
      version = existing[0].version + 1;
      await tx
        .update(TP)
        .set({
          mcoId: input.mcoId ?? null,
          tradingPartnerId: input.tradingPartnerId,
          clientId: input.clientId ?? null,
          clientSecretCipher,
          sftpHost: input.sftpHost ?? null,
          sftpUser: input.sftpUser ?? null,
          sftpKeyCipher,
          portalUrl: input.portalUrl ?? null,
          activeFrom: new Date(input.activeFrom),
          activeTo: input.activeTo ? new Date(input.activeTo) : null,
          version,
          updatedAt: new Date(),
          updatedByMembershipId: actor.userId,
        })
        .where(eq(TP.id, id));
    } else {
      id = randomUUID();
      version = 1;
      await tx.insert(TP).values({
        id,
        organizationId: actor.organizationId,
        providerEntityId: input.providerEntityId,
        serviceState: input.serviceState,
        channel: input.channel,
        mcoId: input.mcoId ?? null,
        tradingPartnerId: input.tradingPartnerId,
        clientId: input.clientId ?? null,
        clientSecretCipher,
        sftpHost: input.sftpHost ?? null,
        sftpUser: input.sftpUser ?? null,
        sftpKeyCipher,
        portalUrl: input.portalUrl ?? null,
        activeFrom: new Date(input.activeFrom),
        activeTo: input.activeTo ? new Date(input.activeTo) : null,
        createdByMembershipId: actor.userId,
        updatedByMembershipId: actor.userId,
      });
    }
    await outbox.publish(tx, {
      eventName: "m24.medicaid_trading_partner.updated",
      organizationId: actor.organizationId,
      aggregateKind: "state_medicaid_trading_partner_credential",
      aggregateId: id,
      payload: {
        organizationId: actor.organizationId,
        providerEntityId: input.providerEntityId,
        state: input.serviceState,
        channel: input.channel,
        mcoId: input.mcoId ?? null,
        version,
      },
    });
    return { id };
  }

  return {
    async previewClaimAssembly(actor, input): Promise<AssemblyPreviewView> {
      if (input.serviceFrom > input.serviceTo) {
        throw new ConflictError(
          "MEDICAID_SERVICE_RANGE_INVALID",
          "service start must not follow service end",
        );
      }
      const previewAdmissionSnapshot = admissionCadenceReader?.previewSnapshotInTransaction;
      if (!admissionCadenceReader || !previewAdmissionSnapshot) {
        throw new DegradedError(
          "MEDICAID_ADMISSION_CADENCE_READER_UNBOUND",
          "the preview cannot verify patient/provider scope without M6's read-only admission snapshot",
        );
      }

      let coverageSnapshot: { medicaid: CoverageForRange; primary: CoverageForRange } | null = null;
      try {
        coverageSnapshot = coverage
          ? await coverage.claimCoverageForRange({
              organizationId: actor.organizationId,
              patientId: input.patientId,
              from: input.serviceFrom,
              to: input.serviceTo,
            })
          : null;
      } catch {
        // A preview reports an unavailable source without turning a reader failure into a denial or a pass.
        coverageSnapshot = null;
      }

      const medicaidResolution = coverageSnapshot?.medicaid ?? null;
      const primaryResolution = coverageSnapshot?.primary ?? null;
      const medicaidView: AssemblyPreviewCoverage = medicaidResolution
        ? coveragePreview(medicaidResolution)
        : { status: "unavailable", coverageKind: null, rank: null };
      const primaryView: AssemblyPreviewCoverage = primaryResolution
        ? coveragePreview(primaryResolution)
        : { status: "unavailable", coverageKind: null, rank: null };
      const claimKinds: AssemblyPreviewClaimKind[] =
        medicaidResolution && primaryResolution
          ? claimKindPreviews(medicaidResolution, primaryResolution)
          : ["hospice_only", "rb_only", "combined_hospice_rb"].map((kind) => ({
              kind: kind as AssembleClaimInput["kind"],
              payerPolicy: "unresolved",
              reasonCode: "MEDICAID_COVERAGE_READER_UNBOUND",
            }));
      const payerResponsibility: AssemblyPreviewView["payerResponsibility"] =
        medicaidResolution?.status === "uniform" && primaryResolution?.status === "uniform"
          ? primaryResolution.coverage.rank === 1 &&
            medicaidResolution.coverage.rank === 1 &&
            primaryResolution.coverage.coverageKind === "medicaid" &&
            primaryResolution.coverage.id === medicaidResolution.coverage.id
            ? "medicaid_primary"
            : primaryResolution.coverage.rank !== 1
              ? "unresolved"
              : primaryResolution.coverage.coverageKind === "medicare_ffs"
                ? medicaidResolution.coverage.rank === 2
                  ? "medicare_primary_medicaid_secondary"
                  : "unresolved"
                : medicaidResolution.coverage.rank === 2
                  ? "other_primary"
                  : "unresolved"
          : "unresolved";

      let arrangements: AssemblyPreviewArrangement[] = [];
      let arrangementListStatus: AssemblyPreviewView["arrangementListStatus"] = "unavailable";
      let recordedEligibility: AssemblyPreviewView["recordedEligibility"] = {
        status: "unavailable",
        outcome: null,
        serviceState: null,
        asOfServiceDate: null,
        checkedAt: null,
        staleAt: null,
      };
      let programResponsibility: AssemblyPreviewView["programResponsibility"] = {
        status: "unavailable",
        programKind: null,
        canonicalPayerId: null,
        canonicalPayerName: null,
        reasonCode: "PROGRAM_RESPONSIBILITY_UNAVAILABLE",
      };
      let enrollmentReadiness: AssemblyPreviewView["enrollmentReadiness"] =
        ENROLLMENT_REQUIREMENTS.map((kind) => ({
          kind,
          status: "unavailable",
          reasonCode: "READINESS_CONTEXT_UNAVAILABLE",
        }));
      let selectedClearinghouse: AssemblyPreviewView["selectedClearinghouse"] = {
        status: "missing",
        vendor: null,
        configurationStatus: null,
      };
      let tenantClearinghouseAccount: {
        source: string;
        vendor: string | null;
        status: string | null;
      } | null = null;
      let tradingPartnerCredential: AssemblyPreviewView["tradingPartnerCredential"] = {
        status: "unavailable",
        reasonCode: "SERVICE_JURISDICTION_UNAVAILABLE",
      };
      if (tenantClearinghouseReader) {
        try {
          const route = await tenantClearinghouseReader.selectedTenantRoute(actor.organizationId);
          tenantClearinghouseAccount = {
            source: route.source,
            vendor: route.vendor,
            status: route.status,
          };
        } catch {
          tenantClearinghouseAccount = { source: "unavailable", vendor: null, status: null };
        }
      } else {
        tenantClearinghouseAccount = { source: "unavailable", vendor: null, status: null };
      }

      if (admissionCadenceReader) {
        const previewReads = await withOrgContext(db, actor, async (tx) => {
          const admissionSnapshot = await previewAdmissionSnapshot.call(
            admissionCadenceReader,
            tx,
            actor.organizationId,
            input.admissionId,
          );
          if (!admissionSnapshot) throw new NotFoundError("admission not found");
          if (
            admissionSnapshot.patientId !== input.patientId ||
            admissionSnapshot.providerEntityId !== input.providerEntityId
          ) {
            throw new ConflictError(
              "MEDICAID_ADMISSION_IDENTITY_MISMATCH",
              "the admission does not belong to the selected patient and provider entity",
            );
          }

          const rangeFrom = new Date(`${input.serviceFrom}T00:00:00.000Z`);
          const rangeTo = new Date(`${input.serviceTo}T00:00:00.000Z`);
          const [arrangementRows, dayRows, credentialRows] = await Promise.all([
            tx
              .select()
              .from(A)
              .where(
                and(
                  eq(A.organizationId, actor.organizationId),
                  eq(A.patientId, input.patientId),
                  eq(A.providerEntityId, input.providerEntityId),
                  lte(A.effectiveFrom, rangeTo),
                  or(isNull(A.effectiveTo), gte(A.effectiveTo, rangeFrom)),
                ),
              )
              .orderBy(desc(A.effectiveFrom))
              .limit(50),
            tx
              .select()
              .from(RD)
              .where(
                and(
                  eq(RD.organizationId, actor.organizationId),
                  eq(RD.providerEntityId, input.providerEntityId),
                  eq(RD.patientId, input.patientId),
                  gte(RD.serviceDate, rangeFrom),
                  lte(RD.serviceDate, rangeTo),
                ),
              )
              .orderBy(RD.serviceDate, RD.id),
            tx
              .select({
                serviceState: TP.serviceState,
                activeFrom: TP.activeFrom,
                activeTo: TP.activeTo,
              })
              .from(TP)
              .where(
                and(
                  eq(TP.organizationId, actor.organizationId),
                  eq(TP.providerEntityId, input.providerEntityId),
                ),
              )
              .orderBy(TP.activeFrom, TP.id),
          ]);
          const eligibilityRows =
            medicaidResolution?.status === "uniform"
              ? await tx
                  .select({
                    outcome: EC.outcome,
                    serviceState: EC.serviceState,
                    asOfServiceDate: EC.asOfServiceDate,
                    checkedAt: EC.checkedAt,
                    staleAt: EC.staleAt,
                  })
                  .from(EC)
                  .where(
                    and(
                      eq(EC.organizationId, actor.organizationId),
                      eq(EC.providerEntityId, input.providerEntityId),
                      eq(EC.patientId, input.patientId),
                      eq(EC.patientPayerId, medicaidResolution.coverage.id),
                      gte(EC.asOfServiceDate, rangeFrom),
                      lte(EC.asOfServiceDate, rangeTo),
                    ),
                  )
                  .orderBy(desc(EC.asOfServiceDate), desc(EC.checkedAt))
                  .limit(1)
              : [];
          const serviceState = admissionSnapshot.serviceAddressState?.trim().toUpperCase() ?? null;
          const projectedTradingPartnerCredential =
            serviceState && /^[A-Z]{2}$/.test(serviceState)
              ? tradingPartnerCredentialStatus(
                  credentialRows.filter((row) => row.serviceState === serviceState),
                  input.serviceFrom,
                  input.serviceTo,
                )
              : { status: "unavailable" as const, reasonCode: "SERVICE_JURISDICTION_UNRESOLVED" };
          const eligibility = eligibilityRows[0];
          const projectedEligibility: AssemblyPreviewView["recordedEligibility"] =
            medicaidResolution?.status !== "uniform"
              ? {
                  status: "unavailable",
                  outcome: null,
                  serviceState: null,
                  asOfServiceDate: null,
                  checkedAt: null,
                  staleAt: null,
                }
              : eligibility
                ? {
                    status: eligibility.staleAt.getTime() > Date.now() ? "current" : "stale",
                    outcome: String(eligibility.outcome),
                    serviceState: eligibility.serviceState,
                    asOfServiceDate: day(eligibility.asOfServiceDate),
                    checkedAt: iso(eligibility.checkedAt),
                    staleAt: iso(eligibility.staleAt),
                  }
                : {
                    status: "not_recorded",
                    outcome: null,
                    serviceState: null,
                    asOfServiceDate: null,
                    checkedAt: null,
                    staleAt: null,
                  };

          const programRows =
            medicaidResolution?.status === "uniform" &&
            serviceState &&
            /^[A-Z]{2}$/.test(serviceState)
              ? await tx
                  .select({
                    id: PA.id,
                    programKind: PA.programKind,
                    canonicalPayerId: PA.canonicalPayerId,
                    status: PA.status,
                    effectiveFrom: PA.effectiveFrom,
                    effectiveTo: PA.effectiveTo,
                  })
                  .from(PA)
                  .where(
                    and(
                      eq(PA.organizationId, actor.organizationId),
                      eq(PA.patientId, input.patientId),
                      eq(PA.patientPayerId, medicaidResolution.coverage.id),
                      eq(PA.admissionId, input.admissionId),
                      eq(PA.providerEntityId, input.providerEntityId),
                      eq(PA.serviceState, serviceState),
                      lte(PA.effectiveFrom, rangeTo),
                      or(isNull(PA.effectiveTo), gte(PA.effectiveTo, rangeFrom)),
                    ),
                  )
                  .orderBy(PA.effectiveFrom, PA.id)
              : [];
          let projectedProgramResponsibility: AssemblyPreviewView["programResponsibility"] =
            !serviceState || !/^[A-Z]{2}$/.test(serviceState)
              ? {
                  status: "unavailable",
                  programKind: null,
                  canonicalPayerId: null,
                  canonicalPayerName: null,
                  reasonCode: "SERVICE_JURISDICTION_UNRESOLVED",
                }
              : medicaidResolution?.status !== "uniform"
                ? {
                    status: "unavailable",
                    programKind: null,
                    canonicalPayerId: null,
                    canonicalPayerName: null,
                    reasonCode: "MEDICAID_COVERAGE_UNRESOLVED",
                  }
                : resolveProgramResponsibility(
                    programRows.map((row) => ({
                      id: row.id,
                      programKind: row.programKind as
                        | "ffs_open_card"
                        | "managed_care"
                        | "other_managed_care"
                        | "unsupported",
                      canonicalPayerId: row.canonicalPayerId,
                      status: row.status,
                      effectiveFrom: day(row.effectiveFrom),
                      effectiveTo: row.effectiveTo ? day(row.effectiveTo) : null,
                    })),
                    input.serviceFrom,
                    input.serviceTo,
                  );
          projectedProgramResponsibility = {
            ...projectedProgramResponsibility,
            canonicalPayerName: null,
          };
          if (projectedProgramResponsibility.status === "verified") {
            const payer = await canonicalPayerReader?.resolvePayer(
              actor.organizationId,
              projectedProgramResponsibility.canonicalPayerId,
            );
            if (
              !payer ||
              payer.status !== "active" ||
              payer.kind !== "medicaid" ||
              payer.stateCode !== serviceState
            ) {
              projectedProgramResponsibility = {
                status: "unavailable",
                programKind: "unresolved",
                canonicalPayerId: null,
                canonicalPayerName: null,
                reasonCode: canonicalPayerReader
                  ? "CANONICAL_PAYER_UNRESOLVED"
                  : "CANONICAL_PAYER_READER_UNBOUND",
              };
            } else {
              projectedProgramResponsibility = {
                ...projectedProgramResponsibility,
                canonicalPayerId: payer.id,
                canonicalPayerName: payer.displayName,
              };
            }
          }
          const enrollmentRows =
            serviceState && /^[A-Z]{2}$/.test(serviceState)
              ? await tx
                  .select()
                  .from(EE)
                  .where(
                    and(
                      eq(EE.organizationId, actor.organizationId),
                      eq(EE.providerEntityId, input.providerEntityId),
                      eq(EE.serviceState, serviceState),
                      lte(EE.effectiveFrom, rangeTo),
                      or(isNull(EE.effectiveTo), gte(EE.effectiveTo, rangeFrom)),
                    ),
                  )
                  .orderBy(EE.effectiveFrom, EE.id)
              : [];
          const routeRowsForProvider = enrollmentRows.filter(
            (row) =>
              row.evidenceKind === "clearinghouse_payer_route" &&
              row.canonicalPayerId === projectedProgramResponsibility.canonicalPayerId &&
              row.transactionType === "837I",
          );
          selectedClearinghouse = resolveProviderPayerRoute(
            routeRowsForProvider.map((row) => ({
              clearinghouse: row.clearinghouse,
              status: row.status,
              effectiveFrom: day(row.effectiveFrom),
              effectiveTo: row.effectiveTo ? day(row.effectiveTo) : null,
            })),
            input.serviceFrom,
            input.serviceTo,
            tenantClearinghouseAccount,
          );
          const routeMappingRows = enrollmentRows.filter(
            (row) =>
              row.evidenceKind === "clearinghouse_payer_route" &&
              row.canonicalPayerId === projectedProgramResponsibility.canonicalPayerId &&
              row.clearinghouse === selectedClearinghouse.vendor &&
              row.transactionType === "837I" &&
              day(row.effectiveFrom) <= input.serviceTo &&
              (!row.effectiveTo || day(row.effectiveTo) >= input.serviceFrom),
          );
          const vendorPayerId =
            routeMappingRows.length === 1 ? routeMappingRows[0]!.vendorPayerId : null;
          const projectedEnrollmentReadiness: AssemblyPreviewView["enrollmentReadiness"] =
            ENROLLMENT_REQUIREMENTS.map((kind) => ({
              ...enrollmentRequirementStatus(
                enrollmentRows,
                kind,
                input.serviceFrom,
                input.serviceTo,
                projectedProgramResponsibility.canonicalPayerId,
                projectedProgramResponsibility.programKind,
                selectedClearinghouse.vendor,
                kind === "835_era_enrollment"
                  ? "835"
                  : kind === "state_medicaid_provider_enrollment" || kind === "mco_participation"
                    ? null
                    : "837I",
              ),
              vendorPayerId: kind === "clearinghouse_payer_route" ? vendorPayerId : null,
            }));

          return {
            admissionSnapshot,
            serviceState,
            projectedTradingPartnerCredential,
            projectedEligibility,
            projectedProgramResponsibility,
            projectedEnrollmentReadiness,
            arrangementRows,
            dayRows,
          };
        });
        recordedEligibility = previewReads.projectedEligibility;
        programResponsibility = previewReads.projectedProgramResponsibility;
        enrollmentReadiness = previewReads.projectedEnrollmentReadiness;
        tradingPartnerCredential = previewReads.projectedTradingPartnerCredential;

        let rawPeriods: Awaited<
          ReturnType<LevelOfCarePeriodReaderPort["periodsForAdmission"]>
        > | null = null;
        if (locPeriodReader) {
          try {
            rawPeriods = await locPeriodReader.periodsForAdmission(
              actor.organizationId,
              input.admissionId,
            );
          } catch {
            rawPeriods = null;
          }
        }

        arrangements = previewReads.arrangementRows.map((arrangement) => {
          const arrangementError = arrangementIssue(
            arrangement,
            actor.organizationId,
            input.patientId,
            input.providerEntityId,
            input.serviceFrom,
            input.serviceTo,
          );
          let reasonCode = arrangementError?.code ?? null;
          let billableDayCount = 0;
          let status: AssemblyPreviewArrangement["status"] = reasonCode ? "blocked" : "candidate";
          if (!reasonCode && !rawPeriods) {
            status = "unresolved";
            reasonCode = "MEDICAID_LOC_PERIOD_READER_UNBOUND";
          }
          if (!reasonCode && rawPeriods) {
            const candidateInput: AssembleClaimInput = {
              ...input,
              kind: "rb_only",
              rbArrangementId: arrangement.id,
            };
            const deathDate =
              previewReads.admissionSnapshot.stayEndFacts.dischargeReason === "death"
                ? (previewReads.admissionSnapshot.stayEndFacts.deceasedDate ??
                  previewReads.admissionSnapshot.stayEndFacts.dischargeDate)
                : null;
            for (const rbDay of previewReads.dayRows) {
              if (rbDay.status === "billed" || rbDay.status === "pending") {
                reasonCode =
                  rbDay.status === "billed"
                    ? "MEDICAID_RB_DAYS_ALREADY_ASSIGNED"
                    : "MEDICAID_RB_DAYS_PENDING_RECONCILIATION";
                break;
              }
              if (rbDay.status === "voided" || rbDay.status === "excluded") {
                if (rbDay.medicaidClaimLineId !== null)
                  reasonCode = "MEDICAID_RB_DAY_SNAPSHOT_INVALID";
                if (reasonCode) break;
                continue;
              }
              const issue =
                rbDayIssue(rbDay, arrangement, actor.organizationId, candidateInput) ??
                rbDayAdmissionEndIssue(rbDay, previewReads.admissionSnapshot) ??
                rbDayLocSnapshotIssue(rbDay, rawPeriods, deathDate);
              if (issue) {
                reasonCode = issue.code;
                break;
              }
              billableDayCount += 1;
            }
            if (!reasonCode && billableDayCount === 0) reasonCode = "MEDICAID_NO_BILLABLE_RB_DAYS";
            if (reasonCode) status = "blocked";
          }
          return {
            id: arrangement.id,
            facilityName: arrangement.nfFacilityNameSnapshot,
            effectiveFrom: day(arrangement.effectiveFrom),
            effectiveTo: dayN(arrangement.effectiveTo),
            billableDayCount,
            status,
            reasonCode,
          };
        });
        arrangementListStatus = rawPeriods !== null ? "available" : "unavailable";
        // Only one configured service state is returned; eligibility remains a separate recorded fact.
        if (!recordedEligibility.serviceState) {
          recordedEligibility = {
            ...recordedEligibility,
            serviceState: previewReads.serviceState,
          };
        }
      }

      let medicareEvidence: AssemblyPreviewView["medicareEvidence"] = {
        match:
          primaryResolution?.status !== "uniform"
            ? "unresolved"
            : primaryResolution.coverage.coverageKind !== "medicare_ffs"
              ? "not_applicable"
              : "unavailable",
        evidenceStatus: null,
        rangeRelation: null,
        remittanceAdviceRecorded: null,
      };
      if (
        medicareClaimReader &&
        primaryResolution?.status === "uniform" &&
        primaryResolution.coverage.coverageKind === "medicare_ffs"
      ) {
        try {
          const matches = await medicareClaimReader().medicareSecondaryContext(
            actor.organizationId,
            input.patientId,
            { from: input.serviceFrom, to: input.serviceTo },
            {
              providerEntityId: input.providerEntityId,
              admissionId: input.admissionId,
              primaryCoverageId: primaryResolution.coverage.id,
            },
          );
          if (matches.length === 0) {
            medicareEvidence = { ...medicareEvidence, match: "none" };
          } else if (matches.length > 1) {
            medicareEvidence = { ...medicareEvidence, match: "ambiguous" };
          } else {
            const match = matches[0]!;
            medicareEvidence = {
              match: "single",
              evidenceStatus: match.evidenceStatus,
              rangeRelation: match.rangeRelation,
              remittanceAdviceRecorded: match.remittanceAdviceRecorded,
            };
          }
        } catch {
          medicareEvidence = { ...medicareEvidence, match: "unavailable" };
        }
      }

      const stateBillingPolicy: AssemblyPreviewView["stateBillingPolicy"] =
        payerResponsibility === "medicaid_primary"
          ? "not_applicable_to_primary_medicaid"
          : payerResponsibility === "unresolved"
            ? "unresolved"
            : "unconfirmed";
      return {
        primaryCoverage: primaryView,
        medicaidCoverage: medicaidView,
        payerResponsibility,
        recordedEligibility,
        claimKinds,
        rbArrangements: arrangements,
        arrangementListStatus,
        medicareEvidence,
        stateBillingPolicy,
        programResponsibility,
        enrollmentReadiness,
        selectedClearinghouse,
        tradingPartnerCredential,
        electronicSubmissionAvailable: false,
        isAdvisorySnapshot: true,
      };
    },

    // ── route 1 — assemble. The claim row needs three externally-owned values: `patient_payer_id` (M5),
    // `service_state` (the state-level service/credential scope; it does not classify FFS vs MCO) and
    // `state_plan_code_id` (WX-PR-011:
    // resolved from the M24-owned `medicaid_state_plan_code` platform catalog — see the schema file's
    // deviation note on why this is self-owned rather than routed through M40's entity-merge engine).
    // M5's §3.4 PatientCoverageReader gives coverage; the service state comes from the locked M6 admission
    // service-address snapshot. A trading-partner credential only configures transport after that state
    // is determined and cannot establish payer responsibility or permission to transmit.
    //
    // PER-LINE ASSEMBLY (WX-PR-011 follow-up, closed): walks M6 LOC periods into hospice-LOC lines
    // (RHC/CHC/IRC/GIP, one line per contiguous same-LOC segment clipped to the claim window, rate from
    // the M24-owned `medicaid_state_rate_schedule` platform catalog) and M24's own `rb_day` sweep output
    // into R&B lines (NF_RB, one line per billable day, rate = the facility's own contracted per-diem —
    // never the state schedule, per audit finding M24-F02). `kind` gates which family runs
    // (`hospice_only`/`rb_only` skip the other). Backing M8 encounter evidence links via
    // `medicaid_claim_line_encounter` when the signed-encounters reader is bound (optional — supplementary
    // audit evidence, not a structural input).
    async assembleClaim(actor: M24Actor, input: AssembleClaimInput): Promise<ClaimView> {
      assertAssemblyRequestShape(input);
      if (!coverage) {
        throw new DegradedError(
          "MEDICAID_COVERAGE_READER_UNBOUND",
          "claim assembly requires M5's PatientCoverageReader seam (not bound in this environment)",
        );
      }
      const preflight = await coverage.claimCoverageForRange({
        organizationId: actor.organizationId,
        patientId: input.patientId,
        from: input.serviceFrom,
        to: input.serviceTo,
      });
      const preflightMedicaid = requireUniformClaimCoverage(preflight.medicaid, "medicaid");
      const preflightPrimary = requireUniformClaimCoverage(preflight.primary, "primary");
      assertMedicaidPayerResponsibility(input.kind, preflightMedicaid, preflightPrimary);
      if (!admissionCadenceReader) {
        throw new DegradedError(
          "MEDICAID_ADMISSION_CADENCE_READER_UNBOUND",
          "claim assembly requires M6's admission status reader to derive the claim cadence (not bound in this environment)",
        );
      }
      return withOrgContext(db, actor, async (tx) => {
        // #877 — re-resolve under a row lock in the claim-write transaction. Coverage replacement
        // now waits until this claim commits, and a change already committed after the optimistic
        // preflight is refused before anything is inserted.
        const locked = await coverage.claimCoverageSnapshotInTransaction(tx, {
          organizationId: actor.organizationId,
          patientId: input.patientId,
          from: input.serviceFrom,
          to: input.serviceTo,
        });
        if (
          coverageResolutionKey(locked.medicaid) !== coverageResolutionKey(preflight.medicaid) ||
          coverageResolutionKey(locked.primary) !== coverageResolutionKey(preflight.primary)
        ) {
          throw new ConflictError(
            "MEDICAID_COVERAGE_CHANGED",
            "Primary or Medicaid coverage changed while this claim was being assembled. Reload coverage and assemble again.",
          );
        }
        const lockedMedicaid = requireUniformClaimCoverage(locked.medicaid, "medicaid");
        const lockedPrimary = requireUniformClaimCoverage(locked.primary, "primary");
        assertMedicaidPayerResponsibility(input.kind, lockedMedicaid, lockedPrimary);
        const patientLifecycleIssue = patientLifecycleServiceRangeIssue(
          locked.patientLifecycle,
          input.serviceTo,
        );
        if (patientLifecycleIssue) {
          throw new ConflictError(patientLifecycleIssue.code, patientLifecycleIssue.message);
        }
        // The M6 admission row is the per-admission serialization point. FOR UPDATE makes concurrent
        // assemblers derive cadence sequentially and also serializes against discharge writers.
        const admission = await admissionCadenceReader.cadenceSnapshotInTransaction(
          tx,
          actor.organizationId,
          input.admissionId,
        );
        if (!admission) {
          throw new NotFoundError("admission not found");
        }
        if (
          admission.patientId !== input.patientId ||
          admission.providerEntityId !== input.providerEntityId
        ) {
          throw new ConflictError(
            "MEDICAID_ADMISSION_IDENTITY_MISMATCH",
            "the admission does not belong to the selected patient and provider entity",
          );
        }
        const admissionIssue = admissionServiceRangeIssue(admission, input.serviceTo);
        if (admissionIssue) {
          throw new ConflictError(admissionIssue.code, admissionIssue.message);
        }
        const inclusiveLocEndDate = inclusiveLocEndDateForAdmission(admission);
        if (!locPeriodReader) {
          throw new DegradedError(
            "MEDICAID_LOC_PERIOD_READER_UNBOUND",
            "claim assembly requires the M6 level-of-care period reader (not bound in this environment)",
          );
        }
        const rawPeriods = await locPeriodReader.periodsForAdmission(
          actor.organizationId,
          input.admissionId,
        );
        let rbArrangement: RbArrangementRow | null = null;
        const selectedRbDays: (typeof schema.rbDay.$inferSelect)[] = [];
        if (input.kind !== "hospice_only") {
          const arrangementRows = await tx
            .select()
            .from(A)
            .where(
              and(eq(A.organizationId, actor.organizationId), eq(A.id, input.rbArrangementId!)),
            )
            .limit(1)
            .for("update");
          rbArrangement = arrangementRows[0] ?? null;
          if (!rbArrangement) throw new NotFoundError("R&B arrangement not found");
          const serviceFrom = day(input.serviceFrom);
          const serviceTo = day(input.serviceTo);
          const issue = arrangementIssue(
            rbArrangement,
            actor.organizationId,
            input.patientId,
            input.providerEntityId,
            serviceFrom,
            serviceTo,
          );
          if (issue) throwAssemblyIssue(issue);

          // Lock every patient day in the requested interval, not only the selected arrangement's
          // currently-billable rows. A day already owned by another claim or a conflicting arrangement
          // must not disappear from a partial assembly. Stable ordering keeps overlapping claims aligned.
          const dayRows = await tx
            .select()
            .from(RD)
            .where(
              and(
                eq(RD.organizationId, actor.organizationId),
                eq(RD.patientId, input.patientId),
                gte(RD.serviceDate, new Date(`${serviceFrom}T00:00:00.000Z`)),
                lte(RD.serviceDate, new Date(`${serviceTo}T00:00:00.000Z`)),
              ),
            )
            .orderBy(RD.serviceDate, RD.id)
            .for("update");
          if (dayRows.some((rbd) => rbd.status === "billed")) {
            throw new ConflictError(
              "MEDICAID_RB_DAYS_ALREADY_ASSIGNED",
              "One or more Room & Board days in this service range already belong to a claim. Reconcile the existing claim before assembling an overlapping claim.",
            );
          }
          if (dayRows.some((rbd) => rbd.status === "pending")) {
            throw new ConflictError(
              "MEDICAID_RB_DAYS_PENDING_RECONCILIATION",
              "One or more Room & Board days in this service range are not yet classified for billing. Reconcile the day records before assembling this claim.",
            );
          }
          for (const rbd of dayRows) {
            if (rbd.status === "voided") {
              if (rbd.medicaidClaimLineId !== null) {
                throw new ConflictError(
                  "MEDICAID_RB_DAY_SNAPSHOT_INVALID",
                  "A voided Room & Board day still references a claim line and requires reconciliation.",
                );
              }
              continue;
            }
            if (rbd.status === "excluded") {
              if (rbd.medicaidClaimLineId !== null) {
                throw new ConflictError(
                  "MEDICAID_RB_DAY_SNAPSHOT_INVALID",
                  "An excluded Room & Board day still references a claim line and requires reconciliation.",
                );
              }
              continue;
            }
            const dayIssue = rbDayIssue(rbd, rbArrangement, actor.organizationId, input);
            if (dayIssue) throwAssemblyIssue(dayIssue);
            const admissionEndIssue = rbDayAdmissionEndIssue(rbd, admission);
            if (admissionEndIssue) throwAssemblyIssue(admissionEndIssue);
            const inclusiveDeathDate =
              admission.stayEndFacts.dischargeReason === "death"
                ? (admission.stayEndFacts.deceasedDate ?? admission.stayEndFacts.dischargeDate)
                : null;
            const locIssue = rbDayLocSnapshotIssue(rbd, rawPeriods, inclusiveDeathDate);
            if (locIssue) throwAssemblyIssue(locIssue);
            selectedRbDays.push(rbd);
          }
          if (selectedRbDays.length === 0) {
            throw new ConflictError(
              "MEDICAID_NO_BILLABLE_RB_DAYS",
              "No available billable Room & Board days exist for the selected arrangement and service range.",
            );
          }
        }
        // Service jurisdiction comes from the locked M6 admission's recorded service address.
        // A trading-partner credential configures a route after jurisdiction is known; it cannot
        // make an otherwise unrelated service appear to be in its state.
        const serviceState = admission.serviceAddressState?.trim().toUpperCase() ?? null;
        if (!serviceState || !/^[A-Z]{2}$/.test(serviceState)) {
          throw new ConflictError(
            "MEDICAID_SERVICE_JURISDICTION_UNRESOLVED",
            "the admission has no valid service-address state; record the service location before assembling a Medicaid claim",
          );
        }
        const from = new Date(input.serviceFrom);
        const planRows = await tx
          .select({ id: SPC.id, planCode: SPC.planCode })
          .from(SPC)
          .where(
            and(
              eq(SPC.stateCode, serviceState),
              eq(SPC.isStateDefault, true),
              lte(SPC.effectiveFrom, from),
              or(isNull(SPC.effectiveTo), gte(SPC.effectiveTo, from)),
            ),
          )
          .orderBy(desc(SPC.effectiveFrom))
          .limit(1);
        const plan = planRows[0];
        if (!plan) {
          throw new DegradedError(
            "MEDICAID_STATE_PLAN_CODE_CATALOG_MISSING",
            `no active medicaid_state_plan_code default row is loaded for state ${serviceState} as of ${day(input.serviceFrom)} — load the platform catalog before assembling a ${serviceState} claim`,
          );
        }
        // Program identity is separate from M5's coverage row. Only verified assignments that
        // cover the complete inclusive claim window can produce a resolved payer snapshot.
        const programRows = await tx
          .select({
            id: PA.id,
            programKind: PA.programKind,
            canonicalPayerId: PA.canonicalPayerId,
            status: PA.status,
            effectiveFrom: PA.effectiveFrom,
            effectiveTo: PA.effectiveTo,
            payerSnapshot: PA.payerSnapshot,
          })
          .from(PA)
          .where(
            and(
              eq(PA.organizationId, actor.organizationId),
              eq(PA.patientId, input.patientId),
              eq(PA.patientPayerId, lockedMedicaid.id),
              eq(PA.admissionId, input.admissionId),
              eq(PA.providerEntityId, input.providerEntityId),
              eq(PA.serviceState, serviceState),
              lte(PA.effectiveFrom, new Date(input.serviceTo)),
              or(isNull(PA.effectiveTo), gte(PA.effectiveTo, new Date(input.serviceFrom))),
            ),
          )
          .orderBy(PA.effectiveFrom, PA.id)
          .for("share");
        let programResolution = resolveProgramResponsibility(
          programRows.map((row) => ({
            id: row.id,
            programKind: row.programKind as
              | "ffs_open_card"
              | "managed_care"
              | "other_managed_care"
              | "unsupported",
            canonicalPayerId: row.canonicalPayerId,
            status: row.status,
            effectiveFrom: day(row.effectiveFrom),
            effectiveTo: row.effectiveTo ? day(row.effectiveTo) : null,
          })),
          day(input.serviceFrom),
          day(input.serviceTo),
        );
        let canonicalPayer: Awaited<ReturnType<CanonicalPayerIdentityReader["resolvePayer"]>> =
          null;
        if (programResolution.status === "verified") {
          canonicalPayer = canonicalPayerReader
            ? await canonicalPayerReader.resolvePayer(
                actor.organizationId,
                programResolution.canonicalPayerId,
              )
            : null;
          if (!canonicalPayer) {
            programResolution = {
              status: "unavailable",
              programKind: "unresolved",
              canonicalPayerId: null,
              assignmentIds: programResolution.assignmentIds,
              reasonCode: canonicalPayerReader
                ? "CANONICAL_PAYER_UNRESOLVED"
                : "CANONICAL_PAYER_READER_UNBOUND",
            };
          } else if (
            canonicalPayer.kind !== "medicaid" ||
            canonicalPayer.stateCode !== serviceState ||
            canonicalPayer.status !== "active"
          ) {
            programResolution = {
              status: "unsupported",
              programKind: "unsupported",
              canonicalPayerId: null,
              assignmentIds: programResolution.assignmentIds,
              reasonCode: "CANONICAL_PAYER_STATE_OR_KIND_MISMATCH",
            };
            canonicalPayer = null;
          } else {
            programResolution = { ...programResolution, canonicalPayerId: canonicalPayer.id };
          }
        }
        const programAssignmentId =
          programResolution.status === "verified" && programResolution.assignmentIds.length === 1
            ? programResolution.assignmentIds[0]!
            : null;
        const selectedProgram =
          programResolution.status === "verified"
            ? programRows.find((row) => row.id === programResolution.assignmentIds[0])
            : null;
        if (!ccnReader) {
          throw new DegradedError(
            "MEDICAID_CCN_READER_UNBOUND",
            "claim assembly requires the provider-entity CCN reader (not bound in this environment)",
          );
        }
        const ccn = await ccnReader.ccnForProviderEntity(
          actor.organizationId,
          input.providerEntityId,
        );
        if (!ccn) {
          throw new ConflictError(
            "MEDICAID_PROVIDER_ENTITY_NOT_FOUND",
            "the provider entity on this claim does not exist or carries no CCN",
          );
        }
        const claimId = randomUUID();
        const controlNumber = deriveMedicaidControlNumber({
          ccn,
          serviceState,
          serviceFrom: day(input.serviceFrom),
          claimId,
          attemptIndex: 0,
        });
        const priorClaims = await tx
          .select({ state: C.state, tob: C.tob })
          .from(C)
          .where(
            and(eq(C.organizationId, actor.organizationId), eq(C.admissionId, input.admissionId)),
          );
        const hasPriorClaimForAdmission = priorClaims.some(isMedicaidCadenceBearingClaim);
        const tob = deriveMedicaidTobFromAdmission({
          hasPriorClaimForAdmission,
          dischargedAt: dayN(admission.dischargedAt),
          serviceTo: day(input.serviceTo),
        });
        const inserted = await tx
          .insert(C)
          .values({
            id: claimId,
            organizationId: actor.organizationId,
            providerEntityId: input.providerEntityId,
            patientId: input.patientId,
            patientPayerId: lockedMedicaid.id,
            admissionId: input.admissionId,
            serviceState,
            kind: input.kind,
            tob,
            serviceFrom: new Date(input.serviceFrom),
            serviceTo: new Date(input.serviceTo),
            statePlanCodeId: plan.id,
            statePlanCodeSnapshot: plan.planCode,
            medicaidProgramKind: programResolution.programKind,
            canonicalPayerId:
              programResolution.status === "verified" ? programResolution.canonicalPayerId : null,
            programAssignmentId,
            programResolutionSnapshot: {
              status: programResolution.status,
              reasonCode: programResolution.reasonCode,
              assignmentIds: programResolution.assignmentIds,
              serviceFrom: day(input.serviceFrom),
              serviceTo: day(input.serviceTo),
              serviceState,
              payerSnapshot: canonicalPayer
                ? {
                    id: canonicalPayer.id,
                    displayName: canonicalPayer.displayName,
                    stateCode: canonicalPayer.stateCode,
                    kind: canonicalPayer.kind,
                  }
                : (selectedProgram?.payerSnapshot ?? null),
            },
            mcoId:
              programResolution.status === "verified" &&
              programResolution.programKind === "managed_care"
                ? programResolution.canonicalPayerId
                : null,
            mcoSnapshot:
              programResolution.status === "verified" &&
              programResolution.programKind === "managed_care"
                ? canonicalPayer
                  ? {
                      id: canonicalPayer.id,
                      displayName: canonicalPayer.displayName,
                      stateCode: canonicalPayer.stateCode,
                      kind: canonicalPayer.kind,
                    }
                  : (selectedProgram?.payerSnapshot ?? null)
                : null,
            rbArrangementId: input.rbArrangementId ?? null,
            medicareClaimId: null,
            rbDayCountSnapshot: selectedRbDays.length,
            medicaidClaimControlNumber: controlNumber,
            state: "DRAFT",
            createdByMembershipId: actor.userId,
            updatedByMembershipId: actor.userId,
          })
          .returning();

        // ── per-line assembly (WX-PR-011 follow-up): walk M6 LOC periods into hospice-LOC lines
        // (RHC/CHC/IRC/GIP) and M24's own `rb_day` sweep output into R&B lines (NF_RB). Header-only
        // assembly (zero lines) was the prior scope cut; this closes it for real for both line families.
        let nextLineNumber = 1;
        if (input.kind !== "rb_only") {
          // place-of-service (WX-PR-011 follow-up #2): resolve the real facts per period BEFORE calling
          // the pure buildHospiceLines — one residence lookup + one batched facility-kind lookup, anchored
          // to each period's own start date (not the claim's), so a mid-claim LOC change resolves against
          // the address/facility that was actually current when that period began.
          const facilityIdsToResolve = new Set<string>();
          for (const p of rawPeriods) if (p.facilityId) facilityIdsToResolve.add(p.facilityId);
          const residenceByPeriod = new Map<
            string,
            { kind: PlaceOfServiceResidenceKind; facilityId: string | null } | null
          >();
          if (residenceReader) {
            for (const p of rawPeriods) {
              const residence = await residenceReader.residenceAt(
                actor.organizationId,
                input.patientId,
                day(p.effectiveAt),
              );
              residenceByPeriod.set(p.id, residence);
              if (residence?.facilityId) facilityIdsToResolve.add(residence.facilityId);
            }
          }
          const facilityKinds = facilityKindReader
            ? await facilityKindReader.kindsFor([...facilityIdsToResolve])
            : new Map<string, PlaceOfServiceFacilityKind>();
          const inclusiveDeathPeriodId = inclusiveDeathLocPeriodId(rawPeriods, inclusiveLocEndDate);
          const locPeriods = rawPeriods.map((p) => {
            const residence = residenceByPeriod.get(p.id) ?? null;
            return {
              levelOfCarePeriodId: p.id,
              levelOfCare: LOC_BY_M6_ENUM[p.levelOfCare],
              from: day(p.effectiveAt),
              to: m6LocClaimEndDate(
                p.endedAt,
                p.id === inclusiveDeathPeriodId ? inclusiveLocEndDate : null,
              ),
              placeOfService: {
                ownIpuBed: p.ipuBedAssignmentId !== null,
                locPeriodFacilityKind: p.facilityId
                  ? (facilityKinds.get(p.facilityId) ?? null)
                  : null,
                residenceKind: residence?.kind ?? null,
                residenceFacilityKind: residence?.facilityId
                  ? (facilityKinds.get(residence.facilityId) ?? null)
                  : null,
              },
            };
          });
          const encounters = signedEncounters
            ? await signedEncounters.encountersInWindow(
                actor.organizationId,
                input.patientId,
                input.serviceFrom,
                input.serviceTo,
              )
            : [];
          // This table does not yet carry the effective service CBSA, OHA's charge ceiling, provider
          // quality-reporting tier, or the election-day/CHC-hour units required by Oregon's published
          // rates. Until that policy context is implemented, no schedule row can price this claim safely.
          // In particular, never substitute an unverified statewide CMS-derived row or an EOCCO contract
          // price in the platform-shared reference table.
          const rateByLoc = new Map<string, { rateCents: number; scheduleId: string }>();
          const { lines: hospiceLines, missingRateSegments } = buildHospiceLines({
            serviceFrom: day(input.serviceFrom),
            serviceTo: day(input.serviceTo),
            locPeriods,
            rateFor: (loc) => rateByLoc.get(loc) ?? null,
            encounters,
            startingLineNumber: nextLineNumber,
          });
          if (missingRateSegments.length > 0) {
            throw new DegradedError(
              "MEDICAID_RATE_POLICY_UNRESOLVED",
              `no qualified payer-specific rate policy can price ${missingRateSegments
                .map((s) => `${s.levelOfCare} ${s.from}..${s.to}`)
                .join(
                  ", ",
                )} — resolve geography, billing units, payer scope, and effective rate source before priced assembly`,
            );
          }
          if (hospiceLines.length === 0) {
            throw new ConflictError(
              "MEDICAID_NO_BILLABLE_LOC_DAYS",
              "no M6 level-of-care period overlaps this claim's service window — nothing to bill",
            );
          }
          for (const ln of hospiceLines) {
            const insertedLine = await tx
              .insert(L)
              .values({
                organizationId: actor.organizationId,
                providerEntityId: input.providerEntityId,
                medicaidClaimId: claimId,
                lineNumber: ln.lineNumber,
                serviceDate: new Date(ln.serviceDate),
                serviceDateTo: new Date(ln.serviceDateTo),
                revenueCode: ln.revenueCode,
                qCode: ln.qCode,
                levelOfCare: ln.levelOfCare,
                locPeriodId: ln.locPeriodId,
                units: ln.units,
                rateAtAssemblyCents: ln.rateCents,
                stateRateScheduleIdSnapshot: ln.stateRateScheduleId,
                chargesCents: ln.chargesCents,
                isRb: false,
              })
              .returning({ id: L.id });
            for (const encounterId of ln.backingEncounterIds) {
              await tx.insert(LE).values({
                medicaidClaimLineId: insertedLine[0]!.id,
                encounterId,
                organizationId: actor.organizationId,
              });
            }
          }
          nextLineNumber += hospiceLines.length;
        }
        if (input.kind !== "hospice_only" && rbArrangement) {
          for (const rbd of selectedRbDays) {
            const insertedLine = await tx
              .insert(L)
              .values({
                organizationId: actor.organizationId,
                providerEntityId: input.providerEntityId,
                medicaidClaimId: claimId,
                lineNumber: nextLineNumber++,
                serviceDate: rbd.serviceDate,
                serviceDateTo: rbd.serviceDate,
                revenueCode: "0658",
                qCode: "Q5003",
                levelOfCare: "NF_RB",
                locPeriodId: rbd.locPeriodIdSnapshot,
                units: 1,
                rateAtAssemblyCents: rbd.perDiemCentsSnapshot,
                stateRateScheduleIdSnapshot: null,
                chargesCents: rbd.perDiemCentsSnapshot,
                isRb: true,
                rbDayId: rbd.id,
                locationId: rbd.locationId,
              })
              .returning({ id: L.id });
            const transitioned = await tx
              .update(RD)
              .set({
                status: "billed",
                medicaidClaimLineId: insertedLine[0]!.id,
                version: sql`${RD.version} + 1`,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(RD.id, rbd.id),
                  eq(RD.organizationId, actor.organizationId),
                  eq(RD.version, rbd.version),
                  eq(RD.status, "billable"),
                  isNull(RD.medicaidClaimLineId),
                ),
              )
              .returning({ id: RD.id });
            if (transitioned.length !== 1) {
              throw new ConflictError(
                "MEDICAID_RB_DAY_CONSUMPTION_CONFLICT",
                "A Room & Board day changed while this claim was being assembled. Reload the day records before retrying.",
              );
            }
          }
        }

        const assembledLineFlags = await tx
          .select({ isRb: L.isRb })
          .from(L)
          .where(
            and(
              eq(L.organizationId, actor.organizationId),
              eq(L.providerEntityId, input.providerEntityId),
              eq(L.medicaidClaimId, claimId),
            ),
          );
        const structureFailure = claimStructureFailure({
          kind: input.kind,
          hasRbArrangement: inserted[0]!.rbArrangementId !== null,
          hospiceLineCount: assembledLineFlags.filter((line) => !line.isRb).length,
          rbLineCount: assembledLineFlags.filter((line) => line.isRb).length,
        });
        const structureError = claimStructureError(structureFailure);
        if (structureError) throwAssemblyIssue(structureError);

        await recordHistory(
          tx,
          actor.organizationId,
          claimId,
          null,
          "DRAFT",
          actor.userId,
          "assemble",
        );
        await outbox.publish(tx, {
          eventName: "m24.medicaid_claim.draft_created",
          organizationId: actor.organizationId,
          aggregateKind: "medicaid_claim",
          aggregateId: claimId,
          payload: {
            organizationId: actor.organizationId,
            claimId,
            providerEntityId: input.providerEntityId,
            patientId: input.patientId,
            admissionId: input.admissionId,
            state: "DRAFT",
            kind: input.kind,
            tob,
            serviceFrom: new Date(input.serviceFrom).toISOString(),
            serviceTo: new Date(input.serviceTo).toISOString(),
          },
        });
        return toClaimView(inserted[0]!);
      });
    },

    async updateDraftClaim(actor, claimId, input: UpdateDraftClaimInput) {
      return withOrgContext(db, actor, async (tx) => {
        const claim = await loadClaim(tx, claimId);
        if (claim.state !== "DRAFT")
          throw new ConflictError("CLAIM_NOT_DRAFT", "only a DRAFT claim is editable");
        assertVersion(claim, input.expectedVersion);
        const updated = await tx
          .update(C)
          .set({
            version: claim.version + 1,
            updatedAt: new Date(),
            updatedByMembershipId: actor.userId,
          })
          .where(eq(C.id, claimId))
          .returning();
        return toClaimView(updated[0]!);
      });
    },

    async deleteDraftClaim(actor, claimId, expectedVersion) {
      await withOrgContext(db, actor, async (tx) => {
        const claim = await loadClaim(tx, claimId, true);
        if (claim.state !== "DRAFT")
          throw new ConflictError("CLAIM_NOT_DRAFT", "only a DRAFT claim is deletable");
        assertVersion(claim, expectedVersion);
        // The application role has no DELETE grant on claims and the assembly history is append-only.
        // Do not turn this DELETE endpoint into an undocumented soft delete; use the explicit lifecycle.
        throw new ConflictError(
          "MEDICAID_DRAFT_DELETE_UNSUPPORTED",
          "Assembled claims retain their lines and append-only history. Use the audited abandon action; an R&B draft with reserved days remains blocked until those days can be safely reconciled.",
        );
      });
    },

    async validateClaim(actor, claimId) {
      return withOrgContext(db, actor, async (tx) => {
        // Lock first so applyOverride (which locks the claim to check the latest run) serialises against this run.
        // Lock order is claim -> run/result inserts here; applyOverride takes only the claim lock, so no cycle.
        const claim = await loadClaim(tx, claimId, true);
        const lineRows = await tx
          .select()
          .from(schema.medicaidClaimLine)
          .where(eq(schema.medicaidClaimLine.medicaidClaimId, claimId))
          .orderBy(schema.medicaidClaimLine.lineNumber);
        const structureFailure = claimStructureFailure({
          kind: claim.kind,
          hasRbArrangement: claim.rbArrangementId !== null,
          hospiceLineCount: lineRows.filter((line) => !line.isRb).length,
          rbLineCount: lineRows.filter((line) => line.isRb).length,
        });
        if (lineRows.some((line) => !line.isRb && line.rbDayId !== null)) {
          throw new ConflictError(
            "MEDICAID_CLAIM_STRUCTURE_INVALID",
            "A non-R&B line references a Room & Board day. Reconcile the claim before validation.",
          );
        }
        const structureError = claimStructureError(structureFailure);
        if (structureError) {
          throw new ConflictError(
            "MEDICAID_CLAIM_STRUCTURE_INVALID",
            "This claim's line families do not match its claim kind. It cannot be validated for readiness.",
          );
        }
        if (
          claim.rbDayCountSnapshot !== null &&
          claim.rbDayCountSnapshot !== lineRows.filter((line) => line.isRb).length
        ) {
          throw new ConflictError(
            "MEDICAID_RB_DAY_COUNT_MISMATCH",
            "The claim's Room & Board day snapshot does not match its stored lines. Reconcile the claim before validation.",
          );
        }
        if (claim.medicareClaimId !== null) {
          throw new ConflictError(
            "MEDICAID_MEDICARE_LINKAGE_UNSUPPORTED",
            "A Medicare claim identifier alone is not adjudication or payment evidence. This unsupported COB claim cannot be validated.",
          );
        }

        if (!coverage) {
          throw new DegradedError(
            "MEDICAID_COVERAGE_READER_UNBOUND",
            "claim validation requires M5's range-wide coverage reader to recheck payer responsibility",
          );
        }
        const payerSnapshot = await coverage.claimCoverageSnapshotInTransaction(tx, {
          organizationId: actor.organizationId,
          patientId: claim.patientId,
          from: day(claim.serviceFrom),
          to: day(claim.serviceTo),
        });
        const patientLifecycleIssue = patientLifecycleServiceRangeIssue(
          payerSnapshot.patientLifecycle,
          day(claim.serviceTo),
        );
        if (patientLifecycleIssue) {
          throw new ConflictError(patientLifecycleIssue.code, patientLifecycleIssue.message);
        }
        const resolvedMedicaid = requireUniformClaimCoverage(payerSnapshot.medicaid, "medicaid");
        const resolvedPrimary = requireUniformClaimCoverage(payerSnapshot.primary, "primary");
        if (resolvedMedicaid.id !== claim.patientPayerId) {
          throw new ConflictError(
            "MEDICAID_COVERAGE_CHANGED",
            "The Medicaid coverage linked to this draft is no longer the coverage resolved for its full service period.",
          );
        }
        assertMedicaidPayerResponsibility(claim.kind, resolvedMedicaid, resolvedPrimary);
        if (!admissionCadenceReader) {
          throw new DegradedError(
            "MEDICAID_ADMISSION_CADENCE_READER_UNBOUND",
            "claim validation requires M6's admission status reader to recheck the stay-end facts",
          );
        }
        const admission = await admissionCadenceReader.cadenceSnapshotInTransaction(
          tx,
          actor.organizationId,
          claim.admissionId,
        );
        if (
          !admission ||
          admission.patientId !== claim.patientId ||
          admission.providerEntityId !== claim.providerEntityId
        ) {
          throw new ConflictError(
            "MEDICAID_ADMISSION_IDENTITY_MISMATCH",
            "The admission identity could not be verified for this claim. Reconcile the patient and provider scope before validation.",
          );
        }
        const admissionIssue = admissionServiceRangeIssue(admission, day(claim.serviceTo));
        if (admissionIssue) {
          throw new ConflictError(admissionIssue.code, admissionIssue.message);
        }
        const hospiceLines = lineRows.filter((line) => !line.isRb);
        const rbLines = lineRows.filter((line) => line.isRb);
        let currentLocPeriods: readonly CurrentLocPeriodForClaim[] | null = null;
        let hospiceClaimSnapshotVerified = claim.kind === "rb_only";
        if (claim.kind !== "rb_only") {
          if (!admissionCadenceReader.periodsForAdmissionInTransaction) {
            throw new DegradedError(
              "MEDICAID_LOC_PERIOD_TRANSACTION_READER_UNBOUND",
              "Hospice-line validation requires M6's current LOC snapshot on the claim transaction",
            );
          }
          currentLocPeriods = await admissionCadenceReader.periodsForAdmissionInTransaction(
            tx,
            actor.organizationId,
            claim.admissionId,
          );
          const snapshotIssue = hospiceClaimLineSnapshotIssue({
            lines: hospiceLines,
            periods: currentLocPeriods,
            organizationId: actor.organizationId,
            providerEntityId: claim.providerEntityId,
            claimId: claim.id,
            serviceFrom: day(claim.serviceFrom),
            serviceTo: day(claim.serviceTo),
            inclusiveEndDate: inclusiveLocEndDateForAdmission(admission),
          });
          if (snapshotIssue) throw new ConflictError(snapshotIssue.code, snapshotIssue.message);
          hospiceClaimSnapshotVerified = true;
        }
        if (rbLines.length > 0) {
          if (
            !claim.rbArrangementId ||
            claim.rbDayCountSnapshot !== rbLines.length ||
            rbLines.some((line) => line.rbDayId === null) ||
            new Set(rbLines.map((line) => line.rbDayId)).size !== rbLines.length
          ) {
            throw new ConflictError(
              "MEDICAID_RB_DAY_COUNT_MISMATCH",
              "The Room & Board lines do not identify a complete, unique billed-day snapshot. Reconcile the claim before validation.",
            );
          }
          if (!admissionCadenceReader.periodsForAdmissionInTransaction) {
            throw new DegradedError(
              "MEDICAID_LOC_PERIOD_TRANSACTION_READER_UNBOUND",
              "Room & Board validation requires M6's current LOC snapshot on the claim transaction",
            );
          }
          const [arrangement] = await tx
            .select()
            .from(A)
            .where(and(eq(A.organizationId, actor.organizationId), eq(A.id, claim.rbArrangementId)))
            .limit(1)
            .for("share");
          if (!arrangement) {
            throw new ConflictError(
              "MEDICAID_RB_ARRANGEMENT_IDENTITY_MISMATCH",
              "The Room & Board arrangement for this claim is unavailable in the current tenant scope.",
            );
          }
          currentLocPeriods ??= await admissionCadenceReader.periodsForAdmissionInTransaction(
            tx,
            actor.organizationId,
            claim.admissionId,
          );
          const rbDayIds = rbLines.map((line) => line.rbDayId as string);
          const rbDays = await tx
            .select()
            .from(RD)
            .where(
              and(
                eq(RD.organizationId, actor.organizationId),
                eq(RD.patientId, claim.patientId),
                inArray(RD.id, rbDayIds),
              ),
            )
            .orderBy(RD.serviceDate, RD.id)
            .for("share");
          const rbDayById = new Map(rbDays.map((rbDay) => [rbDay.id, rbDay]));
          if (rbDayById.size !== rbDayIds.length) {
            throw new ConflictError(
              "MEDICAID_RB_DAY_CLAIM_OWNERSHIP_MISMATCH",
              "One or more Room & Board lines no longer resolve to a billed day in this claim's tenant and patient scope.",
            );
          }
          for (const line of rbLines) {
            const rbDay = rbDayById.get(line.rbDayId as string);
            if (!rbDay) {
              throw new ConflictError(
                "MEDICAID_RB_DAY_CLAIM_OWNERSHIP_MISMATCH",
                "A Room & Board line no longer resolves to its billed day.",
              );
            }
            const issue = rbClaimLineIssue({
              line,
              rbDay,
              arrangement,
              organizationId: actor.organizationId,
              patientId: claim.patientId,
              providerEntityId: claim.providerEntityId,
              claimId: claim.id,
              arrangementId: claim.rbArrangementId,
              serviceFrom: day(claim.serviceFrom),
              serviceTo: day(claim.serviceTo),
              admission,
              locPeriods: currentLocPeriods,
            });
            if (issue) throw new ConflictError(issue.code, issue.message);
          }
        }
        const dualCoverageRecorded =
          resolvedPrimary.coverageKind === "medicare_ffs" &&
          resolvedPrimary.rank === 1 &&
          resolvedMedicaid.coverageKind === "medicaid" &&
          resolvedMedicaid.rank === 2;

        // M5 coverage is server-resolved inside this claim transaction. A Medicare claim id is not used as
        // a proxy for dual coverage; the secondary claim paths remain blocked by the payer-policy gate.
        const ctx: MedicaidValidationContext = {
          orgId: actor.organizationId,
          asOfDate: day(claim.serviceFrom),
          serviceState: claim.serviceState,
          claim: {
            claimId: claim.id,
            providerEntityId: claim.providerEntityId,
            patientId: claim.patientId,
            admissionId: claim.admissionId,
            serviceState: claim.serviceState,
            kind: claim.kind,
            tob: claim.tob as MedicaidValidationContext["claim"]["tob"],
            serviceFrom: day(claim.serviceFrom),
            serviceTo: day(claim.serviceTo),
            replacesClaimId: claim.replacesClaimId ?? null,
            medicareClaimId: claim.medicareClaimId ?? null,
            primaryPayerCoverageId: resolvedPrimary.id,
            rbArrangementId: claim.rbArrangementId ?? null,
            hasConcurrentMedicareAndMedicaidCoverage: dualCoverageRecorded,
          },
          lines: lineRows.map((l) => ({
            claimLineId: l.id,
            serviceDate: day(l.serviceDate),
            levelOfCare: l.levelOfCare,
            revenueCode: l.revenueCode,
            qCode: l.qCode,
            modifiers: [
              l.hcpcsModifier1,
              l.hcpcsModifier2,
              l.hcpcsModifier3,
              l.hcpcsModifier4,
            ].filter((m): m is string => typeof m === "string" && m.length > 0),
            rateAtAssemblyCents: l.rateAtAssemblyCents,
            isRb: l.isRb,
            backingEncounterIds: [],
          })),
          eligibility: null,
          recipientIdFormatValid: null,
          mcoRouting: null,
          nfResidentDays: [],
          rbArrangement: null,
          rbDays: [],
          // Every persisted R&B line above was matched to its current arrangement, billed day and M6 LOC snapshot.
          rbClaimSnapshotVerified: true,
          hospiceClaimSnapshotVerified,
          rateLookups: [],
          payerResponsibility: { status: "permitted", reasonCode: null },
          evvBrackets: [],
          capProjection: null,
          modifiersSatisfied: null,
          documentationSatisfied: null,
          adapterMetadata: {
            acceptsDocumentedMissingEvv: false,
            combinesHospiceAndRb: claim.kind === "combined_hospice_rb",
            supportedTobs: [claim.tob],
          },
          seams: {
            eligibilityBound: false,
            rbBound: false,
            rateScheduleBound: false,
            capProjectionBound: false,
            mdmBound: false,
            adapterBound: false,
          },
        };

        const summary = runMedicaidRules(DEFAULT_MEDICAID_RULES, ctx);
        const runId = randomUUID();
        const now = new Date();
        await tx.insert(VR).values({
          id: runId,
          organizationId: actor.organizationId,
          medicaidClaimId: claimId,
          ruleRegistryVersion: DEFAULT_MEDICAID_RULE_SET_VERSION,
          triggeredBy: "manual",
          claimStateAtTrigger: claim.state,
          idempotencyKey: `${claimId}:${now.getTime()}`,
          actorMembershipId: actor.userId,
          completedAt: now,
          totalResults: summary.results.length,
          failedResults: summary.failedCount,
          warnedResults: summary.warningCount,
        });
        const failedRuleKeys: string[] = [];
        for (const r of summary.results) {
          const skipReason = r.annotations?.skipReason;
          const outcome = skipReason
            ? ("skip_not_applicable" as const)
            : r.passed
              ? ("pass" as const)
              : r.severity === "warn"
                ? ("warn" as const)
                : r.severity === "info"
                  ? ("info" as const)
                  : ("fail" as const);
          if (outcome === "fail") failedRuleKeys.push(r.ruleKey);
          await tx.insert(VRES).values({
            organizationId: actor.organizationId,
            medicaidValidationRunId: runId,
            ruleKey: r.ruleKey,
            ruleVersion: RULES_BY_KEY.get(r.ruleKey)?.version ?? 1,
            outcome,
            remediationSummary: r.message.length > 0 ? r.message : null,
          });
        }

        const nextState = summary.blockingFailures === 0 ? "READY" : "FAILED_VALIDATION";
        await tx
          .update(C)
          .set({
            state: nextState,
            validationRunIdLatest: runId,
            updatedAt: now,
            updatedByMembershipId: actor.userId,
          })
          .where(eq(C.id, claimId));
        await recordHistory(
          tx,
          actor.organizationId,
          claimId,
          claim.state,
          "VALIDATING",
          actor.userId,
          "validate",
        );
        await recordHistory(
          tx,
          actor.organizationId,
          claimId,
          "VALIDATING",
          nextState,
          actor.userId,
          null,
        );

        await outbox.publish(tx, {
          eventName: "m24.medicaid_claim.validation_started",
          organizationId: actor.organizationId,
          aggregateKind: "medicaid_claim",
          aggregateId: claimId,
          payload: {
            organizationId: actor.organizationId,
            claimId,
            validationRunId: runId,
            trigger: "manual",
          },
        });
        await outbox.publish(
          tx,
          nextState === "READY"
            ? {
                eventName: "m24.medicaid_claim.ready_for_submission",
                organizationId: actor.organizationId,
                aggregateKind: "medicaid_claim",
                aggregateId: claimId,
                payload: { organizationId: actor.organizationId, claimId, validationRunId: runId },
              }
            : {
                eventName: "m24.medicaid_claim.validation_failed",
                organizationId: actor.organizationId,
                aggregateKind: "medicaid_claim",
                aggregateId: claimId,
                payload: {
                  organizationId: actor.organizationId,
                  claimId,
                  validationRunId: runId,
                  failedRuleKeys,
                },
              },
        );
        return { validationRunId: runId };
      });
    },

    async submitClaim(actor, claimId, input: SubmitClaimInput) {
      return withOrgContext(db, actor, async (tx) => {
        // Serialize against pre-submission abandonment. A READY claim must not be abandoned while a
        // concurrent submit path is deciding whether it can create a durable attempt.
        const claim = await loadClaim(tx, claimId, true);
        assertVersion(claim, input.expectedVersion);
        const reduced = medicaidClaimMachine.reduce(claim.state, "submit", {
          unresolvedBlockingFailures: 0,
        });
        if (reduced.error)
          throw new ConflictError("INVALID_TRANSITION", `cannot submit from ${claim.state}`);
        // S11 (#711): refuse BEFORE any state change, submission row or outbox event, so no submit job is enqueued.
        const refusal = electronicSubmissionRefusal(
          claim.serviceState,
          isGatewayBound(claim.serviceState),
          claim.mcoId ?? null,
          claim.medicaidProgramKind ?? "unresolved",
          (claim.programResolutionSnapshot as { status?: unknown } | null)?.status === "verified",
        );
        if (refusal) throw new ChartWardenError(refusal.code, refusal.message, 422);
        const submissionId = randomUUID();
        const submittedAt = new Date();
        // Client hints cannot select or authorize a destination. This is reached only if the readiness
        // gate can prove a sendable route; all routes in the current registry are blocked above.
        const channel = claim.mcoId ? "cco_clearinghouse" : "direct_mmis";
        // Adapter wire I/O is DEFERRED — the submission row is created in `pending` and the per-state submit
        // worker drives the real envelope when the adapter binds (§4.5/§4.9). The state advances to SUBMITTED.
        await tx.insert(SUB).values({
          id: submissionId,
          organizationId: actor.organizationId,
          medicaidClaimId: claimId,
          providerEntityId: claim.providerEntityId,
          serviceState: claim.serviceState,
          channel,
          mcoIdSnapshot: claim.mcoId ?? null,
          medicaidClaimControlNumber: claim.medicaidClaimControlNumber,
          attemptIndex: 0,
          adapterVendor: "deferred",
          adapterVersion: "0",
          result: "pending",
          createdByMembershipId: actor.userId,
        });
        const updated = await tx
          .update(C)
          .set({
            state: "SUBMITTED",
            version: claim.version + 1,
            updatedAt: submittedAt,
            updatedByMembershipId: actor.userId,
          })
          .where(eq(C.id, claimId))
          .returning();
        await recordHistory(
          tx,
          actor.organizationId,
          claimId,
          claim.state,
          "SUBMITTED",
          actor.userId,
          "submit",
        );
        await outbox.publish(tx, {
          eventName: "m24.medicaid_claim.submit_requested",
          organizationId: actor.organizationId,
          aggregateKind: "medicaid_claim",
          aggregateId: claimId,
          payload: {
            organizationId: actor.organizationId,
            claimId,
            submissionId,
            medicaidClaimControlNumber: claim.medicaidClaimControlNumber,
            attemptIndex: 0,
            channel,
            mcoId: claim.mcoId ?? null,
          },
        });
        await outbox.publish(tx, {
          eventName: "m24.medicaid_claim.submitted",
          organizationId: actor.organizationId,
          aggregateKind: "medicaid_claim",
          aggregateId: claimId,
          payload: {
            organizationId: actor.organizationId,
            claimId,
            submissionId,
            medicaidClaimControlNumber: claim.medicaidClaimControlNumber,
            state: "SUBMITTED",
            channel,
            mcoId: claim.mcoId ?? null,
            submittedAt: submittedAt.toISOString(),
          },
        });
        return toClaimView(updated[0]!);
      });
    },

    async replaceClaim(actor, claimId, input: ReplaceClaimInput) {
      return buildSuccessorClaim(actor, claimId, input.expectedVersion, "817", input.reason);
    },
    async voidClaim(actor, claimId, input: VoidClaimInput) {
      return buildSuccessorClaim(actor, claimId, input.expectedVersion, "818", input.reason);
    },

    async abandonClaim(actor, claimId, expectedVersion) {
      return withOrgContext(db, actor, async (tx) => {
        const claim = await loadClaim(tx, claimId, true);
        assertVersion(claim, expectedVersion);
        const updated = await abandonPreSubmissionClaim(tx, actor, claim);
        return toClaimView(updated);
      });
    },

    async applyOverride(actor, resultId, input: ApplyOverrideInput) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(VRES).where(eq(VRES.id, resultId)).limit(1);
        const result = rows[0];
        if (!result) throw new NotFoundError("validation result not found");
        const runRows = await tx
          .select({ claimId: VR.medicaidClaimId })
          .from(VR)
          .where(eq(VR.id, result.medicaidValidationRunId))
          .limit(1);
        const claimId = runRows[0]?.claimId;
        if (!claimId) throw new NotFoundError("validation run");
        // The applied role is server-derived, never the client's claim: the actor must HOLD the claimed role and it
        // must be the role the rule requires (a rule with no required role cannot be overridden).
        const rule = RULES_BY_KEY.get(result.ruleKey);
        if (!rule) {
          throw new UnprocessableError(
            "OVERRIDE_RULE_UNKNOWN",
            `rule ${result.ruleKey} is not in the rules registry and cannot be overridden`,
          );
        }
        const requiredRole = rule.overrideRoleRequired;
        if (
          !requiredRole ||
          input.overrideRoleClaimed !== requiredRole ||
          !actor.roles.includes(requiredRole)
        ) {
          throw new ForbiddenError("override role not held or not the role this rule requires");
        }
        if (result.outcome !== "fail") {
          throw new UnprocessableError(
            "OVERRIDE_RESULT_NOT_FAILED",
            `only a failed validation result can be overridden (outcome is ${result.outcome})`,
          );
        }
        // Lock the claim row: a concurrent revalidate updates it (validationRunIdLatest), so it cannot supersede the run
        // between this check and the insert.
        const claimRows = await tx
          .select({ latestRunId: C.validationRunIdLatest })
          .from(C)
          .where(eq(C.id, claimId))
          .limit(1)
          .for("update");
        if (claimRows[0]?.latestRunId !== result.medicaidValidationRunId) {
          throw new ConflictError(
            "OVERRIDE_RESULT_SUPERSEDED",
            "the validation result is not in the claim's latest validation run",
          );
        }
        const overrideId = randomUUID();
        // ON CONFLICT DO NOTHING (not catch-and-rethrow): a unique violation would abort the tx.
        const inserted = await tx
          .insert(VOV)
          .values({
            id: overrideId,
            organizationId: actor.organizationId,
            medicaidValidationResultId: resultId,
            medicaidClaimId: claimId,
            ruleKey: result.ruleKey,
            overrideRoleApplied: requiredRole,
            reason: input.reason,
            stepUpAuthTokenAt: new Date(),
            actorMembershipId: actor.userId,
          })
          .onConflictDoNothing({ target: VOV.medicaidValidationResultId })
          .returning({ id: VOV.id });
        if (inserted.length === 0) {
          throw new ConflictError(
            "OVERRIDE_ALREADY_APPLIED",
            "this validation result already has an override",
          );
        }
        await outbox.publish(tx, {
          eventName: "m24.medicaid_claim.override_applied",
          organizationId: actor.organizationId,
          aggregateKind: "medicaid_claim",
          aggregateId: claimId,
          payload: {
            organizationId: actor.organizationId,
            claimId,
            validationRunId: result.medicaidValidationRunId,
            resultId,
            overrideId,
            ruleKey: result.ruleKey,
            overrideRoleApplied: requiredRole,
          },
        });
        return { overrideId };
      });
    },

    async editRuleConfig(actor, ruleKey, input: EditRuleConfigInput) {
      await withOrgContext(db, actor, async (tx) => {
        const existing = await tx
          .select()
          .from(RC)
          .where(and(eq(RC.ruleKey, ruleKey), eq(RC.organizationId, actor.organizationId)))
          .limit(1);
        const regReq = RULES_BY_KEY.get(ruleKey)?.regulatoryRequired ?? false;
        if (existing[0]) {
          assertVersion(existing[0], input.expectedVersion);
          await tx
            .update(RC)
            .set({
              enabled: input.enabled ?? existing[0].enabled,
              parametersOverlay: input.parametersOverlay ?? existing[0].parametersOverlay,
              version: existing[0].version + 1,
              updatedAt: new Date(),
              updatedByMembershipId: actor.userId,
            })
            .where(eq(RC.id, existing[0].id));
        } else {
          await tx.insert(RC).values({
            organizationId: actor.organizationId,
            ruleKey,
            enabled: input.enabled ?? true,
            parametersOverlay: input.parametersOverlay ?? null,
            isCustom: false,
            regulatoryRequiredSnapshot: regReq,
            updatedByMembershipId: actor.userId,
          });
        }
      });
    },

    async createCustomRule(actor, input: CreateCustomRuleInput) {
      await withOrgContext(db, actor, async (tx) => {
        await tx.insert(RC).values({
          organizationId: actor.organizationId,
          ruleKey: input.ruleKey,
          enabled: true,
          isCustom: true,
          customPredicateDsl: input.customPredicateDsl,
          customSeverity: input.customSeverity,
          customOverrideRole: input.customOverrideRole ?? null,
          regulatoryRequiredSnapshot: false,
          updatedByMembershipId: actor.userId,
        });
      });
      return { ruleKey: input.ruleKey };
    },

    async deleteCustomRule(actor, ruleKey, expectedVersion) {
      await withOrgContext(db, actor, async (tx) => {
        const existing = await tx
          .select()
          .from(RC)
          .where(
            and(
              eq(RC.ruleKey, ruleKey),
              eq(RC.organizationId, actor.organizationId),
              eq(RC.isCustom, true),
            ),
          )
          .limit(1);
        if (!existing[0]) throw new NotFoundError("custom rule not found");
        assertVersion(existing[0], expectedVersion);
        await tx.delete(RC).where(eq(RC.id, existing[0].id));
      });
    },

    // ── route 22 — refresh eligibility (DEFERRED: the M5 MedicaidIdUnlockReader + the per-state 270/271
    // adapter are unbound; the row's service_state comes from M5. Degrades to a typed 503; the route exists). ──
    // The per-state 270/271 adapter is still unbound (no live MMIS to ask), but that is no reason to
    // refuse to record a check. M5's §3.4 coverage read supplies the payer + the masked recipient-id tail,
    // so the row is written with outcome `unknown` — an honest "we could not confirm", which the §11
    // freshness rule then treats as a finding. Previously this 503'd and no row existed at all, so the
    // eligibility history and MCO timeline could never populate.
    async refreshEligibility(actor, input: RefreshEligibilityInput) {
      if (!coverage) {
        throw new DegradedError(
          "MEDICAID_COVERAGE_READER_UNBOUND",
          "eligibility refresh requires M5's PatientCoverageReader seam (not bound in this environment)",
        );
      }
      const resolved = await coverage.activeMedicaidCoverage({
        organizationId: actor.organizationId,
        patientId: input.patientId,
        onDate: input.asOfServiceDate,
      });
      if (!resolved) {
        throw new ConflictError(
          "MEDICAID_COVERAGE_NOT_IN_FORCE",
          "this patient holds no Medicaid coverage in force on the requested service date",
        );
      }
      // GAP-196: the state comes from the credentials in force on the service date (narrowed to the named
      // provider entity when the caller gives one), not from whichever row `LIMIT 1` returned.
      const asOf = new Date(input.asOfServiceDate);
      const credentials = await withOrgContext(db, actor, async (tx) =>
        tx
          .select({
            serviceState: TP.serviceState,
            activeFrom: TP.activeFrom,
            activeTo: TP.activeTo,
          })
          .from(TP)
          .where(
            and(
              eq(TP.organizationId, actor.organizationId),
              input.providerEntityId ? eq(TP.providerEntityId, input.providerEntityId) : undefined,
            ),
          ),
      );
      const stateResolution = resolveServiceState(credentials, asOf);
      if (stateResolution.kind === "none") {
        throw new ConflictError(
          "MEDICAID_NO_ACTIVE_TRADING_PARTNER",
          "no state trading-partner credential is configured — the service state cannot be determined",
        );
      }
      if (stateResolution.kind === "ambiguous") {
        throw new ConflictError(
          "MEDICAID_SERVICE_STATE_AMBIGUOUS",
          `trading-partner credentials are active in several states (${stateResolution.states.join(", ")}) — name the provider entity to check eligibility against`,
        );
      }
      const serviceState = stateResolution.state;
      // Only the last 4 of the member id is ever persisted (D12 / §3.6) — the full recipient id is read
      // from the seam, used to derive the tail, and dropped on this line.
      const maskedTail = resolved.subscriberId.slice(-4);
      const checkedAt = new Date();
      const staleAt = new Date(checkedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
      const checkId = randomUUID();
      await withOrgContext(db, actor, async (tx) => {
        await tx.insert(schema.medicaidEligibilityCheck).values({
          id: checkId,
          organizationId: actor.organizationId,
          providerEntityId: input.providerEntityId ?? null,
          patientId: input.patientId,
          patientPayerId: resolved.id,
          serviceState,
          asOfServiceDate: new Date(input.asOfServiceDate),
          outcome: "unknown",
          recipientIdMaskedAtCheck: maskedTail,
          checkedAt,
          staleAt,
          errorMessage:
            "no state eligibility adapter is wired for this service state — coverage was resolved from the record, not confirmed with the state",
        });
        // The payload must match the REGISTERED §4.11 payloadSchema exactly — the catalog-validating
        // publisher throws on a mismatch and rolls this insert back with it.
        await outbox.publish(tx, {
          eventName: "m24.medicaid_eligibility.checked",
          organizationId: actor.organizationId,
          aggregateKind: "medicaid_eligibility_check",
          aggregateId: checkId,
          payload: {
            organizationId: actor.organizationId,
            checkId,
            patientId: input.patientId,
            asOfServiceDate: new Date(input.asOfServiceDate).toISOString(),
            outcome: "unknown",
            mcoId: null,
            checkedAt: checkedAt.toISOString(),
            staleAt: staleAt.toISOString(),
          },
        });
      });
      return { checkId, outcome: "unknown" };
    },

    async createRbArrangement(actor, input: CreateRbArrangementInput) {
      // GAP-040 — snapshot the NF's canonical name from M40 BEFORE the transaction opens: the seam runs
      // its own org-scoped read, and holding a write tx across it would pin a pooled connection for the
      // duration of someone else's query.
      const nfFacilityNameSnapshot = await resolveNfFacilityName(
        actor.organizationId,
        input.nfFacilityMdmId,
      );
      return withOrgContext(db, actor, async (tx) => {
        const inserted = await tx
          .insert(A)
          .values({
            organizationId: actor.organizationId,
            patientId: input.patientId,
            providerEntityId: input.providerEntityId,
            nfFacilityMdmId: input.nfFacilityMdmId,
            nfFacilityNameSnapshot,
            effectiveFrom: new Date(input.effectiveFrom),
            effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
            nfPerDiemRoutineCents: input.nfPerDiemRoutineCents,
            nfPerDiemRespCents: input.nfPerDiemRespCents,
            nfPerDiemGipCents: input.nfPerDiemGipCents,
            passThroughPct: input.passThroughPct,
            retentionPct: input.retentionPct,
            contractDocumentId: input.contractDocumentId ?? null,
            state: "DRAFT",
            createdByMembershipId: actor.userId,
            updatedByMembershipId: actor.userId,
          })
          .returning();
        return toArrangementView(inserted[0]!);
      });
    },

    async editRbArrangement(actor, arrangementId, input: EditRbArrangementInput) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(A)
          .where(and(eq(A.organizationId, actor.organizationId), eq(A.id, arrangementId)))
          .limit(1)
          .for("update");
        const arr = rows[0];
        if (!arr) throw new NotFoundError("R&B arrangement not found");
        if (arr.state !== "DRAFT")
          throw new ConflictError("ARRANGEMENT_NOT_DRAFT", "only a DRAFT arrangement is editable");
        assertVersion(arr, input.expectedVersion);
        const updated = await tx
          .update(A)
          .set({
            effectiveTo:
              input.effectiveTo === undefined ? arr.effectiveTo : new Date(input.effectiveTo),
            nfPerDiemRoutineCents: input.nfPerDiemRoutineCents ?? arr.nfPerDiemRoutineCents,
            nfPerDiemRespCents: input.nfPerDiemRespCents ?? arr.nfPerDiemRespCents,
            nfPerDiemGipCents: input.nfPerDiemGipCents ?? arr.nfPerDiemGipCents,
            version: arr.version + 1,
            updatedAt: new Date(),
            updatedByMembershipId: actor.userId,
          })
          .where(eq(A.id, arrangementId))
          .returning();
        return toArrangementView(updated[0]!);
      });
    },

    async activateRbArrangement(actor, arrangementId, expectedVersion) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(A)
          .where(and(eq(A.organizationId, actor.organizationId), eq(A.id, arrangementId)))
          .limit(1)
          .for("update");
        const arr = rows[0];
        if (!arr) throw new NotFoundError("R&B arrangement not found");
        assertVersion(arr, expectedVersion);
        const reduced = rbArrangementMachine.reduce(arr.state, "activate");
        if (reduced.error)
          throw new ConflictError("INVALID_TRANSITION", `cannot activate from ${arr.state}`);
        const updated = await tx
          .update(A)
          .set({
            state: "ACTIVE",
            contractStartedAt: new Date(),
            version: arr.version + 1,
            updatedAt: new Date(),
            updatedByMembershipId: actor.userId,
          })
          .where(eq(A.id, arrangementId))
          .returning();
        const row = updated[0]!;
        await outbox.publish(tx, {
          eventName: "m24.rb_arrangement.activated",
          organizationId: actor.organizationId,
          aggregateKind: "rb_arrangement",
          aggregateId: row.id,
          payload: {
            organizationId: actor.organizationId,
            rbArrangementId: row.id,
            patientId: row.patientId,
            nfFacilityMdmId: row.nfFacilityMdmId,
            effectiveFrom: day(row.effectiveFrom),
            effectiveTo: dayN(row.effectiveTo),
          },
        });
        return toArrangementView(row);
      });
    },

    async terminateRbArrangement(actor, arrangementId, input: TerminateRbArrangementInput) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(A)
          .where(and(eq(A.organizationId, actor.organizationId), eq(A.id, arrangementId)))
          .limit(1)
          .for("update");
        const arr = rows[0];
        if (!arr) throw new NotFoundError("R&B arrangement not found");
        assertVersion(arr, input.expectedVersion);
        const reduced = rbArrangementMachine.reduce(arr.state, "terminate");
        if (reduced.error)
          throw new ConflictError("INVALID_TRANSITION", `cannot terminate from ${arr.state}`);
        const terminatedAt = new Date();
        const updated = await tx
          .update(A)
          .set({
            state: "TERMINATED",
            contractTerminatedAt: terminatedAt,
            terminationReason: input.reason,
            version: arr.version + 1,
            updatedAt: terminatedAt,
            updatedByMembershipId: actor.userId,
          })
          .where(eq(A.id, arrangementId))
          .returning();
        const row = updated[0]!;
        await outbox.publish(tx, {
          eventName: "m24.rb_arrangement.ended",
          organizationId: actor.organizationId,
          aggregateKind: "rb_arrangement",
          aggregateId: row.id,
          payload: {
            organizationId: actor.organizationId,
            rbArrangementId: row.id,
            endedState: "TERMINATED",
            endedAt: terminatedAt.toISOString(),
            reason: input.reason,
          },
        });
        return toArrangementView(row);
      });
    },

    async overrideRbDay(actor, rbDayId, input: OverrideRbDayInput) {
      await withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(RD)
          .where(and(eq(RD.organizationId, actor.organizationId), eq(RD.id, rbDayId)))
          .limit(1)
          .for("update");
        const rbDay = rows[0];
        if (!rbDay) throw new NotFoundError("R&B day not found");
        assertVersion(rbDay, input.expectedVersion);
        if (rbDay.status === "billed" || rbDay.medicaidClaimLineId !== null) {
          throw new ConflictError(
            "MEDICAID_RB_DAY_CLAIM_OWNED",
            "This Room & Board day is attached to a claim. Reconcile the claim lifecycle before changing the day.",
          );
        }
        const updated = await tx
          .update(RD)
          .set({
            status: input.status,
            exclusionReason: input.exclusionReason ?? rbDay.exclusionReason,
            version: rbDay.version + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(RD.organizationId, actor.organizationId),
              eq(RD.id, rbDayId),
              eq(RD.version, rbDay.version),
              isNull(RD.medicaidClaimLineId),
              inArray(RD.status, ["pending", "billable", "excluded", "voided"]),
            ),
          )
          .returning({ id: RD.id });
        if (!updated[0]) throw new NotFoundError("R&B day not found");
      });
    },

    async upsertCredential(actor, input: UpsertCredentialInput) {
      return withOrgContext(db, actor, (tx) => upsertCredentialRow(tx, actor, input));
    },

    // The SAME upsert on the CALLER'S transaction (`tx` already scoped to `actor.organizationId`): the platform
    // onboarding route keeps the write, its tenant-status check and its audit row in one unit of work.
    async upsertCredentialOnTx(tx, actor, input: UpsertCredentialInput) {
      await assertTxScopedToOrg(tx, actor.organizationId);
      return upsertCredentialRow(tx as Tx, actor, input);
    },

    // ── route 34 — test credential (DEFERRED: the per-state sandbox adapter is unbound; records the attempt
    // result as deferred, never throws). ──
    async testCredential(actor, credentialId) {
      return withOrgContext(db, actor, async (tx) => {
        const updated = await tx
          .update(TP)
          .set({
            lastSandboxTestAt: new Date(),
            lastSandboxTestResult: "deferred",
            lastSandboxTestError: "state sandbox adapter not wired (deferred, §4.5)",
          })
          .where(eq(TP.id, credentialId))
          .returning({ id: TP.id });
        if (!updated[0]) throw new NotFoundError("credential not found");
        return { ok: false, errorMessage: "state sandbox adapter not wired (deferred)" };
      });
    },

    // ── route 37 — register platform rule (the §4.6 rule registry is the FROZEN code-defined
    // DEFAULT_MEDICAID_RULES; there is no platform-rule table. Accepted as a no-op until a dynamic
    // platform-rule store lands — the M26 platform-constant posture). ──
    async registerPlatformRule(_actor, _input: RegisterPlatformRuleInput) {
      return;
    },

    // ── route 38 — load rate schedule (platform-only; delegates to the M40 loader, which is unbound.
    // Accepted as a queued no-op — the M40 delegation binds later). ──
    async loadRateSchedule(_actor, _input: LoadRateScheduleInput) {
      return { queued: true };
    },

    async recordProgramAssignment(actor, input) {
      const membershipId = actor.membershipId;
      if (!membershipId) throw new ForbiddenError("an active membership is required");
      if (input.programKind === "ffs_open_card" && !input.canonicalPayerId) {
        throw new ConflictError(
          "MEDICAID_FFS_PAYER_REQUIRED",
          "an explicit M40 payer identity is required to record FFS/Open Card",
        );
      }
      if (!coverage)
        throw new DegradedError(
          "MEDICAID_COVERAGE_READER_UNBOUND",
          "M5 coverage verification is unavailable",
        );
      return withOrgContext(db, actor, async (tx) => {
        const snapshot = await coverage.claimCoverageSnapshotInTransaction(tx, {
          organizationId: actor.organizationId,
          patientId: input.patientId,
          from: input.effectiveFrom,
          to: input.effectiveTo ?? input.effectiveFrom,
        });
        const medicaid = requireUniformClaimCoverage(snapshot.medicaid, "medicaid");
        if (medicaid.id !== input.patientPayerId) {
          throw new ConflictError(
            "MEDICAID_PROGRAM_COVERAGE_MISMATCH",
            "the selected patient coverage is not the M5 Medicaid coverage active for the assignment date",
          );
        }
        const admission = admissionCadenceReader
          ? await admissionCadenceReader.cadenceSnapshotInTransaction(
              tx,
              actor.organizationId,
              input.admissionId,
            )
          : null;
        if (!admission)
          throw new DegradedError(
            "MEDICAID_ADMISSION_CADENCE_READER_UNBOUND",
            "M6 admission validation is unavailable",
          );
        if (
          admission.patientId !== input.patientId ||
          admission.providerEntityId !== input.providerEntityId ||
          admission.serviceAddressState?.trim().toUpperCase() !== input.serviceState
        ) {
          throw new ConflictError(
            "MEDICAID_PROGRAM_ADMISSION_MISMATCH",
            "the assignment does not match the admission patient, provider entity, and service jurisdiction",
          );
        }
        const inserted = await tx
          .insert(PA)
          .values({
            organizationId: actor.organizationId,
            patientId: input.patientId,
            patientPayerId: input.patientPayerId,
            admissionId: input.admissionId,
            providerEntityId: input.providerEntityId,
            serviceState: input.serviceState,
            programKind: input.programKind,
            canonicalPayerId: input.canonicalPayerId ?? null,
            status: "pending",
            effectiveFrom: new Date(input.effectiveFrom),
            effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
            sourceKind: input.sourceKind,
            evidenceReference: input.evidenceReference ?? null,
            recordedByMembershipId: membershipId,
            version: 1,
          })
          .returning({ id: PA.id });
        return { id: inserted[0]!.id, status: "pending" as const };
      });
    },

    async recordEnrollmentEvidence(actor, input) {
      const membershipId = actor.membershipId;
      if (!membershipId) throw new ForbiddenError("an active membership is required");
      return withOrgContext(db, actor, async (tx) => {
        const inserted = await tx
          .insert(EE)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: input.providerEntityId,
            serviceState: input.serviceState,
            programKind: input.programKind ?? null,
            canonicalPayerId: input.canonicalPayerId ?? null,
            clearinghouse: input.clearinghouse ?? null,
            vendorPayerId: input.vendorPayerId ?? null,
            transactionType: input.transactionType ?? null,
            evidenceKind: input.evidenceKind,
            status: "pending",
            effectiveFrom: new Date(input.effectiveFrom),
            effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
            recordedByMembershipId: membershipId,
            version: 1,
          })
          .returning({ id: EE.id });
        return { id: inserted[0]!.id, status: "pending" as const };
      });
    },

    async verifyProgramAssignment(actor, id, input) {
      const membershipId = actor.membershipId;
      if (!membershipId) throw new ForbiddenError("an active membership is required");
      if (!verificationSourceAllowed("program_assignment", input.verificationSource, true)) {
        throw new ConflictError(
          "MEDICAID_ASSIGNMENT_VERIFICATION_SOURCE_INVALID",
          "program responsibility must be verified against state or payer evidence",
        );
      }
      if (!canonicalPayerReader)
        throw new DegradedError(
          "MEDICAID_CANONICAL_PAYER_READER_UNBOUND",
          "M40 payer verification is unavailable",
        );
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(PA)
          .where(and(eq(PA.organizationId, actor.organizationId), eq(PA.id, id)))
          .limit(1)
          .for("update");
        const row = rows[0];
        if (!row) throw new NotFoundError("program assignment not found");
        if (row.providerEntityId !== input.providerEntityId || row.patientId !== input.patientId)
          throw new NotFoundError("program assignment not found");
        if (row.version !== input.expectedVersion)
          throw new ConflictError(
            "STALE_VERSION",
            "the program assignment changed; reload it before verification",
          );
        if (row.recordedByMembershipId === membershipId)
          throw new ForbiddenError("the person who recorded an assignment cannot verify it");
        const payer = await canonicalPayerReader.resolvePayer(
          actor.organizationId,
          row.canonicalPayerId ?? "",
        );
        if (
          !payer ||
          payer.status !== "active" ||
          payer.kind !== "medicaid" ||
          payer.stateCode !== row.serviceState
        ) {
          throw new ConflictError(
            "MEDICAID_CANONICAL_PAYER_MISMATCH",
            "the selected M40 payer is not an active Medicaid payer for this service state",
          );
        }
        const updated = await tx
          .update(PA)
          .set({
            status: "verified",
            verifiedAt: new Date(),
            verifiedByMembershipId: membershipId,
            verificationSource: input.verificationSource,
            evidenceReference: input.evidenceReference,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(PA.organizationId, actor.organizationId),
              eq(PA.id, id),
              eq(PA.version, input.expectedVersion),
            ),
          )
          .returning({ version: PA.version });
        if (!updated[0])
          throw new ConflictError(
            "STALE_VERSION",
            "the program assignment changed during verification",
          );
        return { status: "verified" as const, version: updated[0].version };
      });
    },

    async verifyEnrollmentEvidence(actor, id, input) {
      const membershipId = actor.membershipId;
      if (!membershipId) throw new ForbiddenError("an active membership is required");
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(EE)
          .where(and(eq(EE.organizationId, actor.organizationId), eq(EE.id, id)))
          .limit(1)
          .for("update");
        const row = rows[0];
        if (!row) throw new NotFoundError("enrollment evidence not found");
        if (row.providerEntityId !== input.providerEntityId)
          throw new NotFoundError("enrollment evidence not found");
        if (row.version !== input.expectedVersion)
          throw new ConflictError(
            "STALE_VERSION",
            "the enrollment evidence changed; reload it before verification",
          );
        if (row.recordedByMembershipId === membershipId)
          throw new ForbiddenError("the person who recorded evidence cannot verify it");
        if (!verificationSourceAllowed(row.evidenceKind, input.verificationSource)) {
          throw new ConflictError(
            "MEDICAID_EVIDENCE_VERIFICATION_SOURCE_INVALID",
            "the verification source is not acceptable for this evidence type",
          );
        }
        if (row.canonicalPayerId) {
          const payer = await canonicalPayerReader?.resolvePayer(
            actor.organizationId,
            row.canonicalPayerId,
          );
          if (
            !payer ||
            payer.status !== "active" ||
            payer.kind !== "medicaid" ||
            payer.stateCode !== row.serviceState
          ) {
            throw new ConflictError(
              "MEDICAID_CANONICAL_PAYER_MISMATCH",
              "the selected M40 payer is not an active Medicaid payer for this service state",
            );
          }
        }
        if (
          (row.evidenceKind === "clearinghouse_payer_route" ||
            row.evidenceKind === "institutional_format_qualification" ||
            row.evidenceKind === "payer_transport_certification") &&
          (!row.clearinghouse || !row.canonicalPayerId || !row.transactionType)
        ) {
          throw new ConflictError(
            "MEDICAID_ROUTE_EVIDENCE_INCOMPLETE",
            "a verified route must name the clearinghouse, canonical payer, and transaction type",
          );
        }
        if (
          row.evidenceKind === "clearinghouse_payer_route" &&
          (!row.vendorPayerId || !row.transactionType)
        ) {
          throw new ConflictError(
            "MEDICAID_VENDOR_PAYER_MAPPING_REQUIRED",
            "a verified payer route must name the vendor payer identifier and transaction type",
          );
        }
        if (
          row.evidenceKind === "production_activation_approval" &&
          (!row.clearinghouse || !row.canonicalPayerId)
        ) {
          throw new ConflictError(
            "MEDICAID_ACTIVATION_EVIDENCE_INCOMPLETE",
            "production approval must name the clearinghouse and canonical payer",
          );
        }
        if (
          (row.evidenceKind === "837i_enrollment" ||
            row.evidenceKind === "institutional_format_qualification") &&
          row.transactionType !== "837I"
        ) {
          throw new ConflictError(
            "MEDICAID_837I_EVIDENCE_TRANSACTION_MISMATCH",
            "institutional enrollment and format qualification must name transaction 837I",
          );
        }
        if (row.evidenceKind === "835_era_enrollment" && row.transactionType !== "835") {
          throw new ConflictError(
            "MEDICAID_835_EVIDENCE_TRANSACTION_MISMATCH",
            "ERA enrollment must name transaction 835",
          );
        }
        const updated = await tx
          .update(EE)
          .set({
            status: "verified",
            verificationSource: input.verificationSource,
            evidenceReference: input.evidenceReference,
            verifiedAt: new Date(),
            verifiedByMembershipId: membershipId,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(EE.organizationId, actor.organizationId),
              eq(EE.id, id),
              eq(EE.version, input.expectedVersion),
            ),
          )
          .returning({ version: EE.version });
        if (!updated[0])
          throw new ConflictError(
            "STALE_VERSION",
            "the enrollment evidence changed during verification",
          );
        return { status: "verified" as const, version: updated[0].version };
      });
    },

    async revokeProgramAssignment(actor, id, input) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(PA)
          .where(and(eq(PA.organizationId, actor.organizationId), eq(PA.id, id)))
          .limit(1)
          .for("update");
        const row = rows[0];
        if (
          !row ||
          row.providerEntityId !== input.providerEntityId ||
          row.patientId !== input.patientId
        )
          throw new NotFoundError("program assignment not found");
        if (row.version !== input.expectedVersion)
          throw new ConflictError(
            "STALE_VERSION",
            "the program assignment changed; reload it before revocation",
          );
        if (row.status !== "verified")
          throw new ConflictError(
            "MEDICAID_ASSIGNMENT_NOT_VERIFIED",
            "only a verified program assignment can be revoked",
          );
        const updated = await tx
          .update(PA)
          .set({
            status: "revoked",
            revocationReason: input.reasonCode,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(PA.organizationId, actor.organizationId),
              eq(PA.id, id),
              eq(PA.version, input.expectedVersion),
            ),
          )
          .returning({ version: PA.version });
        if (!updated[0])
          throw new ConflictError(
            "STALE_VERSION",
            "the program assignment changed during revocation",
          );
        return { status: "revoked" as const, version: updated[0].version };
      });
    },

    async revokeEnrollmentEvidence(actor, id, input) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(EE)
          .where(and(eq(EE.organizationId, actor.organizationId), eq(EE.id, id)))
          .limit(1)
          .for("update");
        const row = rows[0];
        if (!row || row.providerEntityId !== input.providerEntityId)
          throw new NotFoundError("enrollment evidence not found");
        if (row.version !== input.expectedVersion)
          throw new ConflictError(
            "STALE_VERSION",
            "the enrollment evidence changed; reload it before revocation",
          );
        if (row.status !== "verified")
          throw new ConflictError(
            "MEDICAID_ENROLLMENT_NOT_VERIFIED",
            "only verified enrollment evidence can be revoked",
          );
        const updated = await tx
          .update(EE)
          .set({
            status: "revoked",
            revocationReason: input.reasonCode,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(EE.organizationId, actor.organizationId),
              eq(EE.id, id),
              eq(EE.version, input.expectedVersion),
            ),
          )
          .returning({ version: EE.version });
        if (!updated[0])
          throw new ConflictError(
            "STALE_VERSION",
            "the enrollment evidence changed during revocation",
          );
        return { status: "revoked" as const, version: updated[0].version };
      });
    },
  };

  /** Build a TOB 817 replacement / 818 void successor DRAFT claim by copying the original (D13 §2.5). */
  async function buildSuccessorClaim(
    actor: M24Actor,
    originalClaimId: string,
    expectedVersion: number | null,
    tob: "817" | "818",
    reason: string,
  ): Promise<ClaimView> {
    return withOrgContext(db, actor, async (tx) => {
      const original = await loadClaim(tx, originalClaimId);
      assertVersion(original, expectedVersion);
      if (!["ACK_ACCEPTED", "ACK_PARTIAL", "PAID"].includes(original.state)) {
        throw new ConflictError(
          "CLAIM_NOT_REPLACEABLE",
          `cannot build a ${tob} from state ${original.state}`,
        );
      }
      const newId = randomUUID();
      const parsed = parseMedicaidControlNumber(original.medicaidClaimControlNumber);
      if (!parsed) {
        throw new ConflictError(
          "MEDICAID_CONTROL_NUMBER_INVALID",
          "the original claim control number is malformed; replacement or void creation is blocked until it is corrected",
        );
      }
      const controlNumber = deriveMedicaidControlNumber({
        ccn: parsed.ccn,
        serviceState: original.serviceState,
        serviceFrom: day(original.serviceFrom),
        claimId: newId,
        attemptIndex: 0,
      });
      const adapter = adjustmentAdapters?.adapterForState(original.serviceState) ?? null;
      if (!adapter) {
        throw new DegradedError(
          "MEDICAID_ADJUSTMENT_ADAPTER_UNAVAILABLE",
          `no Medicaid adapter is available to derive the ${tob} adjustment TOB for ${original.serviceState}`,
        );
      }
      const successorTob =
        tob === "817" ? adapter.replacementTob(original.tob) : adapter.voidTob(original.tob);
      const inserted = await tx
        .insert(C)
        .values({
          id: newId,
          organizationId: actor.organizationId,
          providerEntityId: original.providerEntityId,
          locationId: original.locationId ?? null,
          patientId: original.patientId,
          patientPayerId: original.patientPayerId,
          admissionId: original.admissionId,
          serviceState: original.serviceState,
          kind: original.kind,
          tob: successorTob,
          serviceFrom: original.serviceFrom,
          serviceTo: original.serviceTo,
          statePlanCodeId: original.statePlanCodeId,
          statePlanCodeSnapshot: original.statePlanCodeSnapshot,
          mcoId: original.mcoId ?? null,
          mcoSnapshot: original.mcoSnapshot ?? null,
          medicareClaimId: original.medicareClaimId ?? null,
          medicareSecondaryContextSnapshot: original.medicareSecondaryContextSnapshot ?? null,
          rbArrangementId: original.rbArrangementId ?? null,
          medicaidClaimControlNumber: controlNumber,
          state: "DRAFT",
          replacesClaimId: original.id,
          createdByMembershipId: actor.userId,
          updatedByMembershipId: actor.userId,
        })
        .returning();
      await tx
        .update(C)
        .set({ replacedByClaimId: newId, updatedAt: new Date() })
        .where(eq(C.id, originalClaimId));
      await recordHistory(
        tx,
        actor.organizationId,
        newId,
        null,
        "DRAFT",
        actor.userId,
        `${tob}:${reason}`,
      );
      return toClaimView(inserted[0]!);
    });
  }
}
