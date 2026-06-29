// @wardenx/billing — the FIVE published seam interfaces (§4.3) + the consumed-seam name catalog (§4.4).
// M23 publishes read-only reader/admin contracts; consumers import only the interface type, never an M23
// schema/table. Registration into the M1 SeamRegistry is port-injected at the backend composition root
// (see ./seam-registration) — NOT here (the M27/M30 `seams.ts` precedent). Every projection is aggregate
// or id-keyed; NO PHI / NO MBI ever crosses a seam (D13 / §3.6 / §8.7).
import type {
  AcceptedSubmissionDto,
  ArAgingDto,
  CapYear,
  ClaimFhirProjectionDto,
  ClaimId,
  ClaimSummaryDto,
  DaysByLevelOfCareDto,
  FiscalYear,
  HciFeatureSetDto,
  IsoDate,
  IsoDateTime,
  MacCredentialId,
  MacCredentialSummaryDto,
  MacPortalAvailabilityDto,
  MedicareSecondaryContextDto,
  MembershipId,
  MetricsBucket,
  OrgCapAccrualDto,
  OrgFyDaysDto,
  OrgId,
  PatientId,
  ProviderEntityId,
  SubmissionDto,
  UpsertMacCredentialsDto,
} from "./contracts";

// -----------------------------------------------------------------------------
// Seam 1: ClaimReader — single-claim accessors + the M28 FHIR projection + M30 HCI feature inputs +
//   M37 GIP-day census + M24 Medicare-secondary context. Consumers: M28, M30, M37, M24.
// -----------------------------------------------------------------------------
export interface ClaimReader {
  /** M28 FHIR Gateway projection (R4 Claim/ClaimResponse/EOB per US Core 6.0 hospice). */
  fhirProjection(orgId: OrgId, claimId: ClaimId): Promise<ClaimFhirProjectionDto | null>;

  /** M30 HQRP — HCI feature inputs per patient per measurement period. */
  measureFeatureSetForPatient(
    orgId: OrgId,
    patientId: PatientId,
    measurementPeriod: { from: IsoDate; to: IsoDate },
  ): Promise<HciFeatureSetDto>;

  /** M37 IPU census — GIP day count. */
  gipDaysForPatientInPeriod(
    orgId: OrgId,
    patientId: PatientId,
    range: { from: IsoDate; to: IsoDate },
  ): Promise<{ gipDays: number; chgipTransitionCount: number }>;

  /** M24 Medicaid coordination-of-benefits — Medicare-primary EOB context. */
  medicareSecondaryContext(
    orgId: OrgId,
    patientId: PatientId,
    range: { from: IsoDate; to: IsoDate },
  ): Promise<MedicareSecondaryContextDto[]>;

  /** Single-claim accessors (used widely). */
  claimById(orgId: OrgId, claimId: ClaimId): Promise<ClaimSummaryDto | null>;
  claimByControlNumber(orgId: OrgId, controlNumber: string): Promise<ClaimSummaryDto | null>;
}

// -----------------------------------------------------------------------------
// Seam 2: ClaimDayProjectionProvider — per-patient / org day rollups by LOC. Consumers: M26 (cap),
//   M27 (cost-report statistical data, worksheet S-3). M23 PUBLISHES this to feed M26 (D8 non-circular).
// -----------------------------------------------------------------------------
export interface ClaimDayProjectionProvider {
  /** M26 cap projection — per-patient day rollup by LOC within a cap year (Nov 1 – Oct 31). */
  daysForPatientInCapYear(orgId: OrgId, patientId: PatientId, capYear: CapYear): Promise<DaysByLevelOfCareDto>;

  /** M26 cap projection — org-wide aggregate. */
  aggregateForOrgInCapYear(
    orgId: OrgId,
    providerEntityId: ProviderEntityId,
    capYear: CapYear,
  ): Promise<OrgCapAccrualDto>;

  /** M27 cost report — per-fiscal-year statistical data (worksheet S-3). */
  aggregateForOrgInFiscalYear(
    orgId: OrgId,
    providerEntityId: ProviderEntityId,
    fyEnd: IsoDate,
  ): Promise<OrgFyDaysDto>;
  daysAtLevelOfCareInFiscalYear(
    orgId: OrgId,
    providerEntityId: ProviderEntityId,
    fyEnd: IsoDate,
  ): Promise<DaysByLevelOfCareDto>;
}

// -----------------------------------------------------------------------------
// Seam 3: ClaimSubmissionReader — accepted-submission lookups for M25 835-to-claim matching.
// -----------------------------------------------------------------------------
export interface ClaimSubmissionReader {
  /** M25 — to match 835 line items back to originating claims. */
  acceptedSubmissionsInWindow(
    orgId: OrgId,
    providerEntityId: ProviderEntityId,
    windowIso: { from: IsoDateTime; to: IsoDateTime },
  ): Promise<AcceptedSubmissionDto[]>;

  submissionByControlNumber(orgId: OrgId, controlNumber: string): Promise<SubmissionDto | null>;
}

// -----------------------------------------------------------------------------
// Seam 4: ClaimMetricsProvider — M33 operational dashboards (aggregate-only).
// -----------------------------------------------------------------------------
export type MetricsDimension =
  | "state"
  | "tob"
  | "denial_reason"
  | "rule_failure"
  | "override_role"
  | "mac_jurisdiction";

export interface ClaimMetricsProvider {
  windowAggregate(
    orgId: OrgId,
    providerEntityId: ProviderEntityId | "all",
    windowIso: { from: IsoDateTime; to: IsoDateTime },
    dim: MetricsDimension,
  ): Promise<MetricsBucket[]>;
  arAgingBuckets(orgId: OrgId, providerEntityId: ProviderEntityId | "all"): Promise<ArAgingDto>;
  denialRateForWindow(orgId: OrgId, windowIso: { from: IsoDateTime; to: IsoDateTime }): Promise<number>;
  noeWindowBreachRate(orgId: OrgId, windowIso: { from: IsoDateTime; to: IsoDateTime }): Promise<number>;
  macPortalAvailabilityRolling(
    orgId: OrgId,
    providerEntityId: ProviderEntityId,
  ): Promise<MacPortalAvailabilityDto>;
}

// -----------------------------------------------------------------------------
// Seam 5: MacCredentialAdmin — M34 MAC setup wizard (secrets masked on read, §3.6).
// -----------------------------------------------------------------------------
export interface MacCredentialAdmin {
  listForOrg(orgId: OrgId): Promise<MacCredentialSummaryDto[]>;
  upsertCredentials(
    orgId: OrgId,
    providerEntityId: ProviderEntityId,
    payload: UpsertMacCredentialsDto,
    actorId: MembershipId,
  ): Promise<MacCredentialSummaryDto>;
  testAgainstSandbox(
    orgId: OrgId,
    credentialId: MacCredentialId,
    actorId: MembershipId,
  ): Promise<{ ok: boolean; lastSandboxTestAt: IsoDateTime; errorMessage?: string }>;
}

/** The §4.3 published-seam names — the boot registration + `validateSeams()` assert key on this tuple. */
export const M23_PUBLISHED_SEAM_NAMES = [
  "ClaimReader",
  "ClaimDayProjectionProvider",
  "ClaimSubmissionReader",
  "ClaimMetricsProvider",
  "MacCredentialAdmin",
] as const;

export type M23PublishedSeamName = (typeof M23_PUBLISHED_SEAM_NAMES)[number];

// -----------------------------------------------------------------------------
// CONSUMED forward-seam interfaces (§4.4) — the producer modules own the canonical interface; M23
// declares only the MINIMAL shape its deny-stub + rule executor type against until the producer locks.
// -----------------------------------------------------------------------------

/**
 * M26 cap projection (D8). M23 consumes this to drive the §11.A `aggregate_cap_projection` /
 * `ipu_cap_projection` rules. DENY-STUB until M26 locks — the stub returns `status: "unavailable"`
 * so the rule degrades to `warn` (NOT a hard throw, per D8); it tightens to `error` when M26 lands.
 */
export type CapProjectionStatus = "ok" | "unavailable";

export interface CapPatientProjectionResult {
  readonly status: CapProjectionStatus;
  readonly projectedCapCents: number | null;
  readonly capLimitCents: number | null;
  readonly withinCap: boolean | null;
}

export interface CapOrgProjectionResult {
  readonly status: CapProjectionStatus;
  readonly aggregateProjectedCents: number | null;
  readonly aggregateCapCents: number | null;
  readonly pctOfCap: number | null;
  /** Inpatient (GIP+IRC) projection within the 20% cap for the period — drives `ipu_cap_projection`.
   *  Absent inpatient days = within cap (true); null only when the org projection itself is unavailable. */
  readonly ipuWithinCap: boolean | null;
}

export interface CapProjectionProvider {
  projectionForPatient(orgId: OrgId, patientId: PatientId, capYear: CapYear): Promise<CapPatientProjectionResult>;
  projectionForOrg(
    orgId: OrgId,
    providerEntityId: ProviderEntityId,
    capYear: CapYear,
  ): Promise<CapOrgProjectionResult>;
}

/**
 * M5-published, M23-ONLY-consumer (§4.4 / §3.6). Returns the decrypted MBI for the duration of the
 * request only; the caller (the HETS `eligibility-270` builder) is contractually obligated NOT to
 * persist it and zeroes it after the 270 is built. DENY-STUB (fail-closed THROW) until M5's post-M23
 * lock revision publishes it — MBI is security-sensitive, so this stub NEVER degrades-open.
 */
export interface MbiUnlockReader {
  /** Returns the decrypted MBI string for a single in-memory request; never persisted. */
  unlockMbiForRequest(orgId: OrgId, patientPayerId: string): Promise<string>;
}
