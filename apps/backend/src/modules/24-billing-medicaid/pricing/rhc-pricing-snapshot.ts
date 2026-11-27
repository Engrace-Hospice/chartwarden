import { createHash } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import type { MedicaidClaimLinePricingSnapshotPayload } from "@chartwarden/db/schema";
import type { MedicaidPayerProgramClassification } from "@chartwarden/mdm";
import type { PayerRatePolicyFact } from "@chartwarden/medicaid-adapters";
import { assessHospicePricing } from "@chartwarden/medicaid-adapters";
import { ChartWardenError, DegradedError } from "@chartwarden/types";
import { and, eq, lte, sql } from "drizzle-orm";
import type { MedicaidElectionHistoryFacts } from "../../06-admission/seams/medicaid-election-history";
import { inclusiveDeathLocPeriodId, m6LocClaimEndDate } from "../claim-hospice-line-snapshot";
import { qualifyMedicaidProgramClassification } from "../medicaid-payer-classification";
import { resolveProgramResponsibility } from "../routes/program-responsibility";
import { resolveBillingEvidenceLineage } from "./billing-evidence-lineage";
import { resolveRhcElectionDayRange } from "./rhc-election-day";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type BillingEvidence = typeof schema.medicaidHospiceBillingEvidence.$inferSelect;
type RateRow = typeof schema.medicaidPayerRatePolicy.$inferSelect;

export interface RHCServiceLocPeriod {
  readonly id: string;
  readonly version?: number;
  readonly levelOfCare:
    | "routine_home_care"
    | "continuous_home_care"
    | "inpatient_respite_care"
    | "general_inpatient_care";
  readonly effectiveAt: Date;
  readonly endedAt: Date | null;
  readonly facilityId?: string | null;
  readonly updatedAt?: Date;
  readonly ipuBedAssignmentId?: string | null;
}

export interface RHCServiceResidenceSpan {
  readonly addressId: string;
  readonly kind: string;
  readonly facilityId: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface RHCServiceResidenceReader {
  residencesBetweenInTransaction(
    transaction: unknown,
    organizationId: string,
    patientId: string,
    from: string,
    to: string,
  ): Promise<readonly RHCServiceResidenceSpan[]>;
}

export interface RHCFacilityKindReader {
  kindsFor(facilityIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  kindsForInTransaction?(
    transaction: unknown,
    facilityIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}

export interface RHCPriceScope {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly admissionVersion: number | undefined;
  readonly canonicalPayerId: string;
  readonly programKind: "oregon_ffs" | "managed_care";
  readonly serviceState: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly assessedAt: string;
  /**
   * The M6 stay's inclusive date of death (only for a matching death discharge). M6 LOC windows are
   * half-open, so without it the terminal RHC period ends the day before and a claim through the death
   * date can never be priced. Set from `inclusiveLocEndDateForAdmission`; omitted/null otherwise.
   */
  readonly inclusiveEndDate?: string | null;
}

export interface RHCPriceLinePlan {
  readonly snapshotSchemaVersion: 1 | 2 | 3 | 4 | 5;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly locPeriodId: string;
  readonly units: number;
  readonly rateCents: number;
  readonly baseReimbursementCents: number;
  readonly chargesCents: number;
  readonly reimbursementEstimateCents: number;
  readonly appliedCeilings: readonly {
    method: "lower_of_rate_and_usual_charge" | "contract_maximum";
    amountCents: number;
    boundary: "service_day" | "segment";
  }[];
  readonly revenueCode: string;
  readonly hcpcsCode: string;
  readonly rate: PayerRatePolicyFact;
  readonly evidence: BillingEvidence;
  readonly integrityFacts: Record<string, unknown>;
}

/** Validate the explicit persisted daily-RHC snapshot profile before handing JSON to Drizzle. */
export function assertSupportedRhcPricingSnapshotPayload(
  snapshot: Record<string, unknown>,
  expectedVersion: 1 | 2 | 3 | 4 | 5,
): MedicaidClaimLinePricingSnapshotPayload {
  const location = snapshot.serviceLocation;
  const hasCommonIdentity =
    typeof snapshot.assessmentTimestamp === "string" &&
    typeof snapshot.organizationId === "string" &&
    typeof snapshot.providerEntityId === "string" &&
    typeof snapshot.patientId === "string" &&
    typeof snapshot.admissionId === "string" &&
    typeof snapshot.medicaidClaimId === "string" &&
    typeof snapshot.claimLineId === "string" &&
    typeof snapshot.billingEvidenceId === "string" &&
    typeof snapshot.payerRatePolicyId === "string";
  if (
    !hasCommonIdentity ||
    snapshot.schemaVersion !== expectedVersion ||
    snapshot.postingAuthorized !== false ||
    snapshot.levelOfCare !==
      (expectedVersion === 4 ? "IRC" : expectedVersion === 5 ? "GIP" : "RHC") ||
    snapshot.programKind !== "managed_care" ||
    !location ||
    typeof location !== "object"
  ) {
    throw new ChartWardenError(
      "RHC_PRICING_SNAPSHOT_PROFILE_UNSUPPORTED",
      "unsupported or incomplete local daily RHC pricing snapshot",
      500,
    );
  }
  const serviceLocation = location as Record<string, unknown>;
  if (
    expectedVersion === 1 &&
    snapshot.hcpcsCode === "Q5001" &&
    serviceLocation.kind === "home" &&
    serviceLocation.facilityId === null &&
    !Object.hasOwn(snapshot, "localBillingProfile")
  ) {
    return snapshot as MedicaidClaimLinePricingSnapshotPayload;
  }
  if (
    expectedVersion === 2 &&
    snapshot.hcpcsCode === "Q5002" &&
    snapshot.localBillingProfile === "rhc_assisted_living_q5002_daily_v1" &&
    serviceLocation.kind === "facility" &&
    typeof serviceLocation.facilityId === "string" &&
    serviceLocation.facilityKind === "alf"
  ) {
    return snapshot as MedicaidClaimLinePricingSnapshotPayload;
  }
  if (
    expectedVersion === 3 &&
    snapshot.hcpcsCode === "Q5001" &&
    snapshot.localBillingProfile === "rhc_home_election_bucket_daily_v1" &&
    serviceLocation.kind === "home" &&
    serviceLocation.facilityId === null &&
    snapshot.electionDay !== null &&
    typeof snapshot.electionDay === "object"
  ) {
    return snapshot as MedicaidClaimLinePricingSnapshotPayload;
  }
  const episode = snapshot.episode;
  const quantity = snapshot.quantity;
  if (
    expectedVersion === 4 &&
    snapshot.schemaVersion === 4 &&
    snapshot.profile === "irc_hospital_q5005_daily_local_v1" &&
    snapshot.localBillingProfile === "irc_hospital_q5005_daily_local_v1" &&
    snapshot.institutionalFormatQualified === false &&
    snapshot.revenueCode === "0655" &&
    snapshot.hcpcsCode === "Q5005" &&
    typeof serviceLocation.facilityId === "string" &&
    serviceLocation.kind === "facility" &&
    serviceLocation.facilityKind === "hospital" &&
    episode !== null &&
    typeof episode === "object" &&
    quantity !== null &&
    typeof quantity === "object" &&
    (quantity as Record<string, unknown>).basis === "per_day" &&
    Number.isSafeInteger((quantity as Record<string, unknown>).units) &&
    ((quantity as Record<string, unknown>).units as number) > 0
  ) {
    const episodeFacts = episode as Record<string, unknown>;
    if (
      typeof episodeFacts.episodeId === "string" &&
      typeof episodeFacts.ipuAdmissionId === "string" &&
      typeof episodeFacts.remoteStayId === "string" &&
      typeof episodeFacts.serviceTimeZone === "string" &&
      Number.isSafeInteger(episodeFacts.consecutiveDayFrom) &&
      Number.isSafeInteger(episodeFacts.consecutiveDayTo) &&
      (episodeFacts.consecutiveDayFrom as number) > 0 &&
      (episodeFacts.consecutiveDayTo as number) >= (episodeFacts.consecutiveDayFrom as number)
    ) {
      return snapshot as MedicaidClaimLinePricingSnapshotPayload;
    }
  }
  const gipStay = snapshot.gipStay;
  if (
    expectedVersion === 5 &&
    snapshot.schemaVersion === 5 &&
    snapshot.profile === "gip_own_ipu_q5006_daily_local_v1" &&
    snapshot.localBillingProfile === "gip_own_ipu_q5006_daily_local_v1" &&
    snapshot.institutionalFormatQualified === false &&
    snapshot.revenueCode === "0656" &&
    snapshot.hcpcsCode === "Q5006" &&
    gipStay !== null &&
    typeof gipStay === "object" &&
    quantity !== null &&
    typeof quantity === "object" &&
    (quantity as Record<string, unknown>).basis === "per_day" &&
    Number.isSafeInteger((quantity as Record<string, unknown>).units) &&
    ((quantity as Record<string, unknown>).units as number) > 0
  ) {
    const stay = gipStay as Record<string, unknown>;
    if (
      typeof stay.ipuAdmissionId === "string" &&
      typeof stay.unitId === "string" &&
      typeof stay.bedAssignmentId === "string" &&
      typeof stay.facilityId === "string" &&
      stay.facilityKind === "ipu" &&
      typeof stay.serviceTimeZone === "string" &&
      typeof stay.criteriaId === "string" &&
      Array.isArray(stay.dailyEvidence) &&
      stay.dailyEvidence.length === (quantity as Record<string, unknown>).units
    ) {
      return snapshot as MedicaidClaimLinePricingSnapshotPayload;
    }
  }
  throw new ChartWardenError(
    "RHC_PRICING_SNAPSHOT_PROFILE_UNSUPPORTED",
    "pricing snapshot does not match its supported daily RHC profile",
    500,
  );
}

export type RHCPricePlanResult =
  | { readonly status: "resolved"; readonly lines: readonly RHCPriceLinePlan[] }
  | { readonly status: "unresolved" | "ambiguous" | "unsupported"; readonly reasonCode: string };

export interface IrcPricingEpisodeFacts {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly locPeriodId: string;
  readonly ipuAdmissionId: string;
  readonly ipuAdmissionVersion: number;
  readonly ipuAdmissionUpdatedAt: Date;
  readonly ipuAdmissionKind: string;
  readonly ipuAdmissionState: string;
  readonly ipuAdmissionClosedAt: Date | null;
  readonly ipuAdmissionClosedLocalDate: string | null;
  readonly episodeId: string;
  readonly episodeVersion: number;
  readonly episodeState: string;
  readonly episodeStartedAt: Date;
  readonly episodeUpdatedAt: Date;
  readonly episodeStartedLocalDate: string;
  readonly episodeExpectedEndAt: Date;
  readonly episodeExpectedEndLocalDate: string;
  readonly episodeClosedAt: Date | null;
  readonly episodeClosedLocalDate: string | null;
  readonly consecutiveDayCount: number;
  readonly carriedOverDays: number;
  readonly capOverrideInvoked: boolean;
  readonly remoteStayId: string;
  readonly remoteStayVersion: number;
  readonly facilityId: string;
  readonly remoteStayStartedAt: Date;
  readonly remoteStayUpdatedAt: Date;
  readonly remoteStayStartedLocalDate: string;
  readonly remoteStayEndedAt: Date | null;
  readonly remoteStayEndLocalDate: string | null;
  readonly agreementDocumentId: string | null;
  readonly arrangementBillingBasis: string;
  readonly serviceTimeZone: string;
  readonly transitionBeforeServiceEnd: boolean;
}

export interface IrcPricingEpisodeReader {
  readInTransaction(
    transaction: unknown,
    scope: Pick<
      RHCPriceScope,
      | "organizationId"
      | "providerEntityId"
      | "patientId"
      | "admissionId"
      | "serviceFrom"
      | "serviceTo"
    > & { readonly locPeriodId: string },
  ): Promise<IrcPricingEpisodeFacts | null>;
}

/** Minimal M37 owner projection for one continuous own-IPU GIP daily service window. */
export interface GipPricingStayFacts {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly locPeriodId: string;
  readonly ipuAdmissionId: string;
  readonly ipuAdmissionVersion: number;
  readonly ipuAdmissionUpdatedAt: Date;
  readonly ipuAdmissionKind: string;
  readonly ipuAdmissionState: string;
  readonly activatedAt: Date;
  readonly closedAt: Date | null;
  readonly unitId: string;
  readonly unitVersion: number;
  readonly unitFacilityId: string;
  readonly bedId: string;
  readonly bedAssignmentId: string;
  readonly bedAssignmentVersion: number;
  readonly bedAssignedAt: Date;
  readonly bedEndedAt: Date | null;
  readonly facilityId: string;
  readonly facilityKind: "ipu";
  readonly locationId: string;
  readonly serviceTimeZone: string;
  readonly criteriaId: string;
  readonly criteriaVersion: number;
  readonly criteriaKind: string;
  readonly criteriaAttestedAt: Date;
  readonly dailyEvidence: readonly {
    readonly serviceDate: string;
    readonly sourceId: string;
    readonly sourceVersion: number;
    readonly verifiedAt: Date;
    readonly stillMet: true;
  }[];
  readonly serviceFrom: string;
  readonly serviceTo: string;
}

export interface GipPricingStayReader {
  readInTransaction(
    transaction: unknown,
    scope: Pick<
      RHCPriceScope,
      | "organizationId"
      | "providerEntityId"
      | "patientId"
      | "admissionId"
      | "serviceFrom"
      | "serviceTo"
    > & { readonly locPeriodId: string; readonly assessedAt: string },
  ): Promise<GipPricingStayFacts | null>;
}

/** M8-owned current delivered in-home respite facts; M24 may only use this to hold pricing. */
export interface InHomeRespiteEvidenceReaderPort {
  readInTransaction(
    transaction: unknown,
    scope: {
      readonly organizationId: string;
      readonly providerEntityId: string;
      readonly patientId: string;
      readonly admissionId: string;
      readonly serviceFrom: string;
      readonly serviceTo: string;
    },
  ): Promise<{
    readonly status: "none" | "current" | "incomplete" | "ambiguous" | "scope_conflict";
    readonly serviceCount: number;
    readonly evidenceVersions: readonly unknown[];
  }>;
}

export interface CurrentPayerIdentityReader {
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
  medicaidProgramClassifications(
    organizationId: string,
    canonicalPayerId: string,
    serviceState: string,
    serviceFrom: string,
    serviceTo: string,
  ): Promise<readonly MedicaidPayerProgramClassification[]>;
}

function ratePolicyLockKey(scope: {
  organizationId: string;
  providerEntityId: string;
  canonicalPayerId: string;
  serviceState: string;
}): string {
  return `m24-rate-policy:${scope.organizationId}:${scope.providerEntityId}:${scope.canonicalPayerId}:${scope.serviceState}`;
}

export async function lockMedicaidRatePolicyScope(
  tx: Tx,
  scope: Parameters<typeof ratePolicyLockKey>[0],
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${ratePolicyLockKey(scope)}, 0))`,
  );
}

/**
 * Lock several rate-policy scopes in one fixed total order (their lock keys, sorted). A worker that holds the
 * rate locks of many claims in one transaction takes them through this, so two workers whose claims touch the
 * same payers in opposite order cannot deadlock.
 */
export async function lockMedicaidRatePolicyScopes(
  tx: Tx,
  scopes: readonly Parameters<typeof ratePolicyLockKey>[0][],
): Promise<void> {
  const byKey = new Map(scopes.map((scope) => [ratePolicyLockKey(scope), scope]));
  for (const key of [...byKey.keys()].sort()) {
    await lockMedicaidRatePolicyScope(tx, byKey.get(key)!);
  }
}

/**
 * Lock order is FIXED everywhere (assembly, validation, revalidation): the claim's M6 admission row (FOR UPDATE)
 * first, then the rate-policy scope advisory lock, then the billing-evidence scope advisory lock. (Preview takes
 * no admission row lock; it starts at the rate lock. Assembly and validation also take the M5 patient and payer
 * coverage FOR SHARE locks before the admission row: share locks are compatible with each other, and no
 * FOR UPDATE holder of those rows waits on an admission or claim afterwards, so they add no cycle.) Two paths
 * taking the locks above in opposite orders can deadlock (40P01). Every path reads evidence through `readMedicaidHospiceBillingEvidence` and rate
 * lineage through `readMedicaidRatePolicyLineage`, so taking the rate lock here before the evidence lock makes
 * the order rate -> evidence regardless of which read a caller issues first (advisory xact locks are
 * re-entrant). A path that holds the locks of several claims at once (the revalidation job) takes all its rate
 * locks first through `lockMedicaidRatePolicyScopes`. Assembly takes both locks here, before it reads the
 * clock, so a correction that committed while it waited is already part of the instant it assesses.
 */
export async function lockHospiceBillingEvidenceScope(
  tx: Tx,
  scope: Pick<
    RHCPriceScope,
    | "organizationId"
    | "providerEntityId"
    | "patientId"
    | "admissionId"
    | "canonicalPayerId"
    | "programKind"
    | "serviceState"
  >,
  serviceCategory: "RHC" | "CHC" | "IRC" | "GIP" = "RHC",
): Promise<void> {
  await lockMedicaidRatePolicyScope(tx, scope);
  const key = `m24-hospice-evidence:${scope.organizationId}:${scope.providerEntityId}:${scope.patientId}:${scope.admissionId}:${scope.canonicalPayerId}:${scope.programKind}:${scope.serviceState}:${serviceCategory}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/**
 * A typed refusal the caller degrades on (a history cap, an unbound reader, a conflict): a 4xx, or the 503
 * DegradedError. A 5xx ChartWardenError is a defect (TENANT_SCOPE_MISMATCH is a wiring bug), never a refusal.
 */
function isExpectedRefusal(error: unknown): boolean {
  return error instanceof ChartWardenError && (error.statusCode < 500 || error.statusCode === 503);
}

export function logPricingRefusal(event: string, error: unknown): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      event,
      errorClass: error instanceof Error ? error.name : typeof error,
      errorCode: error instanceof ChartWardenError ? error.code : null,
    }),
  );
}

/**
 * Handler for a `catch` around pricing reads/verification. An expected refusal is logged by class and code
 * only and the caller degrades. Anything else is unexpected and may have aborted the surrounding transaction,
 * so it is logged and rethrown. Never log the message: it can carry record content.
 */
export function rethrowUnlessDomainError(event: string, error: unknown): void {
  logPricingRefusal(event, error);
  if (!isExpectedRefusal(error)) throw error;
}

/** A connection, deadlock, serialization or shutdown failure: retrying the job is right, degrading is not. */
const TRANSACTION_FATAL_SQLSTATE = /^(08|40001|40P01|53|57P)/;

export function isTransactionFatalError(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; cause && depth < 4; depth += 1) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && TRANSACTION_FATAL_SQLSTATE.test(code)) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Run one read inside a savepoint, so a database error rolls back only that read and not the unit of work
 * around it (a worker revalidating many claims in one transaction). `ok: false` means the read did not
 * produce a value and the caller fails closed. A connection or deadlock class error, and a typed 5xx defect,
 * are rethrown: the job retries or parks instead of marking every claim unverified.
 */
export async function readInSavepoint<T>(
  tx: Tx,
  event: string,
  read: (savepoint: Tx) => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  try {
    return { ok: true, value: await tx.transaction(read) };
  } catch (error) {
    logPricingRefusal(event, error);
    if (isTransactionFatalError(error)) throw error;
    if (error instanceof ChartWardenError && !isExpectedRefusal(error)) throw error;
    return { ok: false };
  }
}

export async function databasePricingSnapshotFingerprint(
  tx: Tx,
  snapshot: Record<string, unknown>,
): Promise<string> {
  const serialized = JSON.stringify(snapshot);
  const result = await tx.execute<{ fingerprint: string }>(sql`
    SELECT encode(digest((${serialized}::jsonb - 'assessmentTimestamp')::text, 'sha256'), 'hex') AS fingerprint
  `);
  const fingerprint = result.rows[0]?.fingerprint;
  if (!fingerprint) {
    throw new DegradedError(
      "m24-pricing-snapshot",
      "the database did not return a pricing snapshot fingerprint",
    );
  }
  return fingerprint;
}

export interface StoredRhcClaimFacts {
  readonly id: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly patientPayerId: string;
  readonly canonicalPayerId: string | null;
  readonly medicaidProgramKind: string | null;
  readonly serviceState: string;
  readonly serviceFrom: Date | string;
  readonly serviceTo: Date | string;
  readonly kind: string;
}

export interface StoredRhcClaimLine {
  readonly id: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly medicaidClaimId: string;
  readonly serviceDate: Date | string;
  readonly serviceDateTo: Date | string | null;
  readonly revenueCode: string;
  readonly qCode: string;
  readonly levelOfCare: string;
  readonly locPeriodId: string | null;
  readonly units: number;
  readonly rateAtAssemblyCents: number;
  readonly stateRateScheduleIdSnapshot: string | null;
  readonly payerRatePolicyIdSnapshot: string | null;
  readonly chargesCents: number;
  readonly isRb: boolean;
}

/** Current assignment and M40 classification are re-read before a stored pricing snapshot can pass. */
async function currentManagedCarePayerIsVerified(
  tx: Tx,
  claim: StoredRhcClaimFacts,
  reader: CurrentPayerIdentityReader,
  serviceFrom: string,
  serviceTo: string,
): Promise<boolean> {
  if (!claim.canonicalPayerId || claim.medicaidProgramKind !== "managed_care") return false;
  const assignment = schema.medicaidProgramAssignment;
  const rows = await tx
    .select({
      id: assignment.id,
      programKind: assignment.programKind,
      canonicalPayerId: assignment.canonicalPayerId,
      status: assignment.status,
      effectiveFrom: assignment.effectiveFrom,
      effectiveTo: assignment.effectiveTo,
    })
    .from(assignment)
    .where(
      and(
        eq(assignment.organizationId, claim.organizationId),
        eq(assignment.providerEntityId, claim.providerEntityId),
        eq(assignment.patientId, claim.patientId),
        eq(assignment.patientPayerId, claim.patientPayerId),
        eq(assignment.admissionId, claim.admissionId),
        eq(assignment.serviceState, claim.serviceState),
        lte(assignment.effectiveFrom, serviceTo),
      ),
    )
    .orderBy(assignment.effectiveFrom, assignment.id)
    .for("share");
  const usableRows = rows.filter(
    (row) => row.effectiveTo === null || row.effectiveTo >= serviceFrom,
  );
  const resolution = resolveProgramResponsibility(
    usableRows.map((row) => ({
      id: row.id,
      programKind: row.programKind as
        | "ffs_open_card"
        | "managed_care"
        | "other_managed_care"
        | "unsupported",
      canonicalPayerId: row.canonicalPayerId,
      status: row.status,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    })),
    serviceFrom,
    serviceTo,
  );
  if (
    resolution.status !== "verified" ||
    resolution.programKind !== "managed_care" ||
    resolution.canonicalPayerId !== claim.canonicalPayerId
  ) {
    return false;
  }
  const payer = await reader.resolvePayer(claim.organizationId, claim.canonicalPayerId);
  if (
    !payer ||
    payer.id !== claim.canonicalPayerId ||
    payer.kind !== "medicaid" ||
    payer.status !== "active" ||
    payer.stateCode !== claim.serviceState
  )
    return false;
  const classifications = await reader.medicaidProgramClassifications(
    claim.organizationId,
    claim.canonicalPayerId,
    claim.serviceState,
    serviceFrom,
    serviceTo,
  );
  return qualifyMedicaidProgramClassification(
    classifications,
    "managed_care",
    claim.canonicalPayerId,
    claim.serviceState,
    serviceFrom,
    serviceTo,
  ).qualified;
}

/** Re-evaluate current facts and verify stored line snapshots without rewriting them. */
export interface StoredRhcPricingVerification {
  readonly pricingSnapshotVerified: boolean;
  readonly institutionalFormatQualified: boolean;
}

export async function verifyStoredRhcPricingSnapshots(input: {
  readonly tx: Tx;
  readonly claim: StoredRhcClaimFacts;
  readonly lines: readonly StoredRhcClaimLine[];
  readonly locPeriods: readonly RHCServiceLocPeriod[];
  readonly admissionVersion: number | undefined;
  /** The M6 stay's inclusive date of death for a matching death discharge, else null/omitted. */
  readonly inclusiveEndDate?: string | null;
  readonly rateRows: readonly RateRow[];
  readonly payerReader: CurrentPayerIdentityReader | undefined;
  readonly residenceReader: RHCServiceResidenceReader | undefined;
  readonly facilityKindReader?: RHCFacilityKindReader;
  readonly electionHistory?: MedicaidElectionHistoryFacts | null;
  readonly ircEpisodeReader?: IrcPricingEpisodeReader;
  readonly gipPricingStayReader?: GipPricingStayReader;
  readonly inHomeRespiteEvidenceReader?: InHomeRespiteEvidenceReaderPort;
  readonly assessedAt: string;
}): Promise<StoredRhcPricingVerification> {
  const hospiceLines = input.lines.filter((line) => !line.isRb);
  if (hospiceLines.length === 0) {
    return { pricingSnapshotVerified: true, institutionalFormatQualified: true };
  }
  if (
    !input.payerReader ||
    input.claim.serviceState !== "OR" ||
    input.claim.medicaidProgramKind !== "managed_care" ||
    !input.claim.canonicalPayerId ||
    !(await currentManagedCarePayerIsVerified(
      input.tx,
      input.claim,
      input.payerReader,
      isoValue(input.claim.serviceFrom),
      isoValue(input.claim.serviceTo),
    ))
  ) {
    return { pricingSnapshotVerified: false, institutionalFormatQualified: false };
  }
  const scope: RHCPriceScope = {
    organizationId: input.claim.organizationId,
    providerEntityId: input.claim.providerEntityId,
    patientId: input.claim.patientId,
    admissionId: input.claim.admissionId,
    admissionVersion: input.admissionVersion,
    canonicalPayerId: input.claim.canonicalPayerId,
    programKind: "managed_care",
    serviceState: input.claim.serviceState,
    serviceFrom: isoValue(input.claim.serviceFrom),
    serviceTo: isoValue(input.claim.serviceTo),
    assessedAt: input.assessedAt,
    inclusiveEndDate: input.inclusiveEndDate ?? null,
  };
  if (!input.inHomeRespiteEvidenceReader) {
    return { pricingSnapshotVerified: false, institutionalFormatQualified: false };
  }
  const respite = await input.inHomeRespiteEvidenceReader.readInTransaction(input.tx, {
    organizationId: input.claim.organizationId,
    providerEntityId: input.claim.providerEntityId,
    patientId: input.claim.patientId,
    admissionId: input.claim.admissionId,
    serviceFrom: scope.serviceFrom,
    serviceTo: scope.serviceTo,
  });
  if (respite.status !== "none") {
    return { pricingSnapshotVerified: false, institutionalFormatQualified: false };
  }
  if (hospiceLines.every((line) => line.levelOfCare === "IRC")) {
    return verifyStoredIrcPricingSnapshots({ ...input, scope, hospiceLines });
  }
  if (hospiceLines.every((line) => line.levelOfCare === "GIP")) {
    return verifyStoredGipPricingSnapshots({ ...input, scope, hospiceLines });
  }
  if (hospiceLines.some((line) => line.levelOfCare !== "RHC")) {
    return { pricingSnapshotVerified: false, institutionalFormatQualified: false };
  }
  const evidence = await readMedicaidHospiceBillingEvidence(input.tx, scope);
  if (evidence.status !== "verified" && evidence.status !== "segmentation_required") {
    return { pricingSnapshotVerified: false, institutionalFormatQualified: false };
  }
  if (!input.residenceReader) {
    return { pricingSnapshotVerified: false, institutionalFormatQualified: false };
  }
  const residenceSpans = await input.residenceReader.residencesBetweenInTransaction(
    input.tx,
    input.claim.organizationId,
    input.claim.patientId,
    isoValue(input.claim.serviceFrom),
    isoValue(input.claim.serviceTo),
  );
  const facilityIds = [
    ...new Set(residenceSpans.flatMap((span) => (span.facilityId ? [span.facilityId] : []))),
  ];
  // Only the locked, in-transaction read is allowed to price a facility residence: the unlocked
  // `kindsFor` is neither status-filtered nor serialised against an M40 merge or deactivation.
  const facilityKinds = input.facilityKindReader?.kindsForInTransaction
    ? await input.facilityKindReader.kindsForInTransaction(input.tx, facilityIds)
    : new Map<string, string>();
  const plan = resolveRhcDailyPricingPlan({
    scope,
    evidence: evidence.status === "verified" ? evidence.row : evidence.rows,
    locPeriods: input.locPeriods,
    rates: input.rateRows.map(rateRowAsFact),
    residenceSpans,
    facilityKinds,
    electionHistory: input.electionHistory ?? null,
  });
  if (plan.status !== "resolved" || plan.lines.length !== hospiceLines.length) {
    return { pricingSnapshotVerified: false, institutionalFormatQualified: false };
  }

  const snapshotsTable = schema.medicaidClaimLinePricingSnapshot;
  // Immutable snapshots are protected by append-only triggers and least-privilege grants. Row-locking a
  // read-only table would require granting UPDATE solely for SELECT FOR SHARE.
  const storedSnapshots = await input.tx
    .select()
    .from(snapshotsTable)
    .where(
      and(
        eq(snapshotsTable.organizationId, input.claim.organizationId),
        eq(snapshotsTable.providerEntityId, input.claim.providerEntityId),
        eq(snapshotsTable.medicaidClaimId, input.claim.id),
      ),
    )
    .orderBy(snapshotsTable.medicaidClaimLineId);
  if (storedSnapshots.length !== hospiceLines.length) {
    return { pricingSnapshotVerified: false, institutionalFormatQualified: false };
  }
  const linesById = new Map(hospiceLines.map((line) => [line.id, line]));
  const plans = [...plan.lines].sort((a, b) => a.serviceFrom.localeCompare(b.serviceFrom));
  const persistedLines = [...hospiceLines].sort((a, b) =>
    isoValue(a.serviceDate).localeCompare(isoValue(b.serviceDate)),
  );
  if (plans.length !== persistedLines.length) {
    return { pricingSnapshotVerified: false, institutionalFormatQualified: false };
  }

  let institutionalFormatQualified = true;
  for (let index = 0; index < plans.length; index += 1) {
    const current = plans[index]!;
    const line = persistedLines[index]!;
    const snapshot = storedSnapshots.find((row) => row.medicaidClaimLineId === line.id);
    if (
      !snapshot ||
      !linesById.has(snapshot.medicaidClaimLineId) ||
      line.organizationId !== input.claim.organizationId ||
      line.providerEntityId !== input.claim.providerEntityId ||
      line.medicaidClaimId !== input.claim.id ||
      line.serviceDateTo === null ||
      isoValue(line.serviceDate) !== current.serviceFrom ||
      isoValue(line.serviceDateTo) !== current.serviceTo ||
      line.locPeriodId !== current.locPeriodId ||
      line.levelOfCare !== "RHC" ||
      line.units !== current.units ||
      line.rateAtAssemblyCents !== current.rateCents ||
      line.chargesCents !== current.chargesCents ||
      line.revenueCode !== current.revenueCode ||
      line.qCode !== current.hcpcsCode ||
      line.payerRatePolicyIdSnapshot !== current.rate.id ||
      line.stateRateScheduleIdSnapshot !== null ||
      snapshot.payerRatePolicyId !== current.rate.id ||
      snapshot.billingEvidenceId !== current.evidence.id ||
      snapshot.snapshotSchemaVersion !== current.snapshotSchemaVersion
    ) {
      return { pricingSnapshotVerified: false, institutionalFormatQualified: false };
    }
    const material = {
      ...current.integrityFacts,
      medicaidClaimId: input.claim.id,
      claimLineId: line.id,
    };
    const saved = snapshot.snapshot as Record<string, unknown>;
    const { assessmentTimestamp: _assessmentTimestamp, ...savedMaterial } = saved;
    if (
      saved.claimLineId !== line.id ||
      saved.medicaidClaimId !== input.claim.id ||
      (await databasePricingSnapshotFingerprint(input.tx, saved)) !== snapshot.fingerprint ||
      canonicalPricingSnapshotJson(savedMaterial) !== canonicalPricingSnapshotJson(material)
    ) {
      return { pricingSnapshotVerified: false, institutionalFormatQualified: false };
    }
    if (current.evidence.codingProfile !== "qualified_institutional") {
      institutionalFormatQualified = false;
    }
  }
  return { pricingSnapshotVerified: true, institutionalFormatQualified };
}

async function verifyStoredGipPricingSnapshots(input: {
  readonly tx: Tx;
  readonly claim: StoredRhcClaimFacts;
  readonly hospiceLines: readonly StoredRhcClaimLine[];
  readonly scope: RHCPriceScope;
  readonly locPeriods: readonly RHCServiceLocPeriod[];
  readonly rateRows: readonly RateRow[];
  readonly facilityKindReader?: RHCFacilityKindReader;
  readonly gipPricingStayReader?: GipPricingStayReader;
  readonly assessedAt: string;
}): Promise<StoredRhcPricingVerification> {
  const refuse = { pricingSnapshotVerified: false, institutionalFormatQualified: false } as const;
  if (!input.gipPricingStayReader || !input.facilityKindReader?.kindsForInTransaction)
    return refuse;
  const overlapping = input.locPeriods.filter((period) => {
    const from = isoDate(period.effectiveAt);
    const to =
      m6LocClaimEndDate(period.endedAt, input.scope.inclusiveEndDate ?? null) ??
      input.scope.serviceTo;
    return from <= input.scope.serviceTo && to >= input.scope.serviceFrom;
  });
  if (
    overlapping.length !== 1 ||
    overlapping[0]!.levelOfCare !== "general_inpatient_care" ||
    overlapping[0]!.id !== input.hospiceLines[0]?.locPeriodId
  )
    return refuse;
  const period = overlapping[0]!;
  const stay = await input.gipPricingStayReader.readInTransaction(input.tx, {
    organizationId: input.claim.organizationId,
    providerEntityId: input.claim.providerEntityId,
    patientId: input.claim.patientId,
    admissionId: input.claim.admissionId,
    locPeriodId: period.id,
    serviceFrom: input.scope.serviceFrom,
    serviceTo: input.scope.serviceTo,
    assessedAt: input.assessedAt,
  });
  if (!stay) return refuse;
  const facilityKinds = await input.facilityKindReader.kindsForInTransaction(input.tx, [
    stay.facilityId,
  ]);
  const evidence = await readMedicaidGipBillingEvidence(input.tx, input.scope);
  if (evidence.status !== "verified") return refuse;
  const plan = resolveGipDailyPricingPlan({
    scope: input.scope,
    evidence: evidence.row,
    locPeriods: input.locPeriods,
    rates: input.rateRows.map(rateRowAsFact),
    stay,
    facilityKinds,
  });
  if (plan.status !== "resolved" || plan.lines.length !== input.hospiceLines.length) return refuse;
  const snapshots = await input.tx
    .select()
    .from(schema.medicaidClaimLinePricingSnapshot)
    .where(
      and(
        eq(schema.medicaidClaimLinePricingSnapshot.organizationId, input.claim.organizationId),
        eq(schema.medicaidClaimLinePricingSnapshot.providerEntityId, input.claim.providerEntityId),
        eq(schema.medicaidClaimLinePricingSnapshot.medicaidClaimId, input.claim.id),
      ),
    );
  if (snapshots.length !== input.hospiceLines.length) return refuse;
  const expectedLines = [...plan.lines].sort((a, b) => a.serviceFrom.localeCompare(b.serviceFrom));
  const actualLines = [...input.hospiceLines].sort((a, b) =>
    isoValue(a.serviceDate).localeCompare(isoValue(b.serviceDate)),
  );
  for (let index = 0; index < expectedLines.length; index += 1) {
    const expected = expectedLines[index]!;
    const actual = actualLines[index]!;
    const snapshot = snapshots.find((candidate) => candidate.medicaidClaimLineId === actual.id);
    if (
      !snapshot ||
      actual.organizationId !== input.claim.organizationId ||
      actual.providerEntityId !== input.claim.providerEntityId ||
      actual.medicaidClaimId !== input.claim.id ||
      actual.levelOfCare !== "GIP" ||
      actual.locPeriodId !== expected.locPeriodId ||
      actual.serviceDateTo === null ||
      isoValue(actual.serviceDate) !== expected.serviceFrom ||
      isoValue(actual.serviceDateTo) !== expected.serviceTo ||
      actual.units !== expected.units ||
      actual.rateAtAssemblyCents !== expected.rateCents ||
      actual.chargesCents !== expected.chargesCents ||
      actual.revenueCode !== "0656" ||
      actual.qCode !== "Q5006" ||
      actual.payerRatePolicyIdSnapshot !== expected.rate.id ||
      actual.stateRateScheduleIdSnapshot !== null ||
      snapshot.payerRatePolicyId !== expected.rate.id ||
      snapshot.billingEvidenceId !== expected.evidence.id ||
      snapshot.snapshotSchemaVersion !== 5
    )
      return refuse;
    const saved = snapshot.snapshot as Record<string, unknown>;
    const { assessmentTimestamp: _savedAssessmentTimestamp, ...savedMaterial } = saved;
    const expectedMaterial: Record<string, unknown> = {
      ...expected.integrityFacts,
      medicaidClaimId: input.claim.id,
      claimLineId: actual.id,
    };
    const {
      assessmentTimestamp: _expectedAssessmentTimestamp,
      ...expectedMaterialWithoutAssessment
    } = expectedMaterial;
    if (
      saved.claimLineId !== actual.id ||
      saved.medicaidClaimId !== input.claim.id ||
      saved.postingAuthorized !== false ||
      saved.institutionalFormatQualified !== false ||
      (await databasePricingSnapshotFingerprint(input.tx, saved)) !== snapshot.fingerprint ||
      canonicalPricingSnapshotJson(savedMaterial) !==
        canonicalPricingSnapshotJson(expectedMaterialWithoutAssessment)
    )
      return refuse;
  }
  return { pricingSnapshotVerified: true, institutionalFormatQualified: false };
}

async function verifyStoredIrcPricingSnapshots(input: {
  readonly tx: Tx;
  readonly claim: StoredRhcClaimFacts;
  readonly lines: readonly StoredRhcClaimLine[];
  readonly hospiceLines: readonly StoredRhcClaimLine[];
  readonly scope: RHCPriceScope;
  readonly locPeriods: readonly RHCServiceLocPeriod[];
  readonly rateRows: readonly RateRow[];
  readonly facilityKindReader?: RHCFacilityKindReader;
  readonly ircEpisodeReader?: IrcPricingEpisodeReader;
  readonly assessedAt: string;
}): Promise<StoredRhcPricingVerification> {
  const refuse = { pricingSnapshotVerified: false, institutionalFormatQualified: false } as const;
  if (!input.ircEpisodeReader || !input.facilityKindReader?.kindsForInTransaction) return refuse;
  const overlapping = input.locPeriods.filter((period) => {
    const from = isoDate(period.effectiveAt);
    const to = m6LocClaimEndDate(period.endedAt) ?? input.scope.serviceTo;
    return from <= input.scope.serviceTo && to >= input.scope.serviceFrom;
  });
  if (
    overlapping.length !== 1 ||
    overlapping[0]!.levelOfCare !== "inpatient_respite_care" ||
    overlapping[0]!.id !== input.hospiceLines[0]?.locPeriodId
  ) {
    return refuse;
  }
  const episode = await input.ircEpisodeReader.readInTransaction(input.tx, {
    organizationId: input.claim.organizationId,
    providerEntityId: input.claim.providerEntityId,
    patientId: input.claim.patientId,
    admissionId: input.claim.admissionId,
    locPeriodId: overlapping[0]!.id,
    serviceFrom: input.scope.serviceFrom,
    serviceTo: input.scope.serviceTo,
  });
  if (!episode) return refuse;
  const facilityKinds = await input.facilityKindReader.kindsForInTransaction(input.tx, [
    episode.facilityId,
  ]);
  const evidence = await readMedicaidIrcBillingEvidence(input.tx, input.scope);
  if (evidence.status !== "verified") return refuse;
  const plan = resolveIrcDailyPricingPlan({
    scope: input.scope,
    evidence: evidence.row,
    locPeriods: input.locPeriods,
    rates: input.rateRows.map(rateRowAsFact),
    episode,
    facilityKinds,
  });
  if (plan.status !== "resolved" || plan.lines.length !== input.hospiceLines.length) return refuse;
  const snapshots = await input.tx
    .select()
    .from(schema.medicaidClaimLinePricingSnapshot)
    .where(
      and(
        eq(schema.medicaidClaimLinePricingSnapshot.organizationId, input.claim.organizationId),
        eq(schema.medicaidClaimLinePricingSnapshot.providerEntityId, input.claim.providerEntityId),
        eq(schema.medicaidClaimLinePricingSnapshot.medicaidClaimId, input.claim.id),
      ),
    );
  if (snapshots.length !== input.hospiceLines.length) return refuse;
  const expectedLines = [...plan.lines].sort((a, b) => a.serviceFrom.localeCompare(b.serviceFrom));
  const actualLines = [...input.hospiceLines].sort((a, b) =>
    isoValue(a.serviceDate).localeCompare(isoValue(b.serviceDate)),
  );
  for (let index = 0; index < expectedLines.length; index += 1) {
    const expected = expectedLines[index]!;
    const actual = actualLines[index]!;
    const snapshot = snapshots.find((candidate) => candidate.medicaidClaimLineId === actual.id);
    if (
      !snapshot ||
      actual.organizationId !== input.claim.organizationId ||
      actual.providerEntityId !== input.claim.providerEntityId ||
      actual.medicaidClaimId !== input.claim.id ||
      actual.levelOfCare !== "IRC" ||
      actual.locPeriodId !== expected.locPeriodId ||
      actual.serviceDateTo === null ||
      isoValue(actual.serviceDate) !== expected.serviceFrom ||
      isoValue(actual.serviceDateTo) !== expected.serviceTo ||
      actual.units !== expected.units ||
      actual.rateAtAssemblyCents !== expected.rateCents ||
      actual.chargesCents !== expected.chargesCents ||
      actual.revenueCode !== "0655" ||
      actual.qCode !== "Q5005" ||
      actual.payerRatePolicyIdSnapshot !== expected.rate.id ||
      actual.stateRateScheduleIdSnapshot !== null ||
      snapshot.payerRatePolicyId !== expected.rate.id ||
      snapshot.billingEvidenceId !== expected.evidence.id ||
      snapshot.snapshotSchemaVersion !== 4
    )
      return refuse;
    const saved = snapshot.snapshot as Record<string, unknown>;
    const { assessmentTimestamp: _savedAssessmentTimestamp, ...savedMaterial } = saved;
    const expectedMaterial: Record<string, unknown> = {
      ...expected.integrityFacts,
      medicaidClaimId: input.claim.id,
      claimLineId: actual.id,
    };
    const {
      assessmentTimestamp: _expectedAssessmentTimestamp,
      ...expectedMaterialWithoutAssessment
    } = expectedMaterial;
    if (
      saved.claimLineId !== actual.id ||
      saved.medicaidClaimId !== input.claim.id ||
      (await databasePricingSnapshotFingerprint(input.tx, saved)) !== snapshot.fingerprint ||
      canonicalPricingSnapshotJson(savedMaterial) !==
        canonicalPricingSnapshotJson(expectedMaterialWithoutAssessment)
    )
      return refuse;
  }
  return { pricingSnapshotVerified: true, institutionalFormatQualified: false };
}

function isoValue(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

/**
 * Read the assessment-time evidence lineage for exactly this patient/admission/payer. Corrections are
 * applied only after verification, and the resolver refuses partial overlaps rather than allowing a
 * full-window row to conceal a conflicting narrower row.
 */
export async function readMedicaidHospiceBillingEvidence(
  tx: Tx,
  scope: RHCPriceScope,
): Promise<
  | { readonly status: "verified"; readonly row: BillingEvidence }
  | { readonly status: "segmentation_required"; readonly rows: readonly BillingEvidence[] }
  | { readonly status: "unresolved" | "ambiguous"; readonly reasonCode: string }
> {
  const table = schema.medicaidHospiceBillingEvidence;
  await lockHospiceBillingEvidenceScope(tx, scope);
  // The profile is append-only and its insert trigger takes the same advisory scope lock. No UPDATE
  // grant is needed to make this read stable through the surrounding transaction.
  const rows = await tx
    .select()
    .from(table)
    .where(
      and(
        eq(table.organizationId, scope.organizationId),
        eq(table.providerEntityId, scope.providerEntityId),
        eq(table.patientId, scope.patientId),
        eq(table.admissionId, scope.admissionId),
        eq(table.canonicalPayerId, scope.canonicalPayerId),
        eq(table.programKind, scope.programKind),
        eq(table.serviceState, scope.serviceState),
        eq(table.serviceCategory, "RHC"),
        lte(table.effectiveFrom, scope.serviceTo),
      ),
    )
    .orderBy(table.effectiveFrom, table.id)
    .limit(1001);
  if (rows.length > 1000)
    return { status: "ambiguous", reasonCode: "BILLING_EVIDENCE_HISTORY_LIMIT_EXCEEDED" };
  if (rows.length === 0) return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_MISSING" };
  const lineage = resolveBillingEvidenceLineage({
    rows,
    serviceFrom: scope.serviceFrom,
    serviceTo: scope.serviceTo,
    assessedAt: scope.assessedAt,
  });
  if (lineage.status !== "verified" && lineage.status !== "segmentation_required") return lineage;
  const lineageRows = lineage.status === "verified" ? [lineage.row] : lineage.rows;
  const assessedAt = Date.parse(scope.assessedAt);
  for (const row of lineageRows) {
    if (scope.admissionVersion === undefined || row.admissionVersion !== scope.admissionVersion) {
      return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_ADMISSION_VERSION_STALE" };
    }
    if (
      !Number.isFinite(assessedAt) ||
      !row.verifiedAt ||
      row.verifiedAt.getTime() > assessedAt ||
      row.effectiveFrom > scope.serviceTo ||
      (row.effectiveTo !== null && row.effectiveTo < scope.serviceFrom)
    ) {
      return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_NOT_CURRENT_FOR_ASSESSMENT" };
    }
    if (
      row.programKind !== "managed_care" ||
      row.serviceState !== "OR" ||
      row.serviceCategory !== "RHC" ||
      row.quantityPolicy !== "active_rhc_loc_calendar_day" ||
      row.quantityEvidenceOwner !== "m6_level_of_care_period" ||
      row.billingUnit !== "daily" ||
      row.codingProfile !== "local_draft_only" ||
      (row.hcpcsCode !== "Q5001" && row.hcpcsCode !== "Q5002") ||
      row.revenueCode !== "0651" ||
      row.billedChargeCentsPerUnit <= 0
    ) {
      return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_UNSUPPORTED" };
    }
  }
  return lineage.status === "verified"
    ? { status: "verified", row: lineageRows[0]! }
    : { status: "segmentation_required", rows: lineageRows };
}

/** The narrow CHC local-hourly profile shares the append-only evidence lineage, not the RHC code rules. */
export async function readMedicaidChcBillingEvidence(
  tx: Tx,
  scope: RHCPriceScope,
): Promise<
  | { readonly status: "verified"; readonly row: BillingEvidence }
  | { readonly status: "unresolved" | "ambiguous"; readonly reasonCode: string }
> {
  const table = schema.medicaidHospiceBillingEvidence;
  await lockHospiceBillingEvidenceScope(tx, scope, "CHC");
  const rows = await tx
    .select()
    .from(table)
    .where(
      and(
        eq(table.organizationId, scope.organizationId),
        eq(table.providerEntityId, scope.providerEntityId),
        eq(table.patientId, scope.patientId),
        eq(table.admissionId, scope.admissionId),
        eq(table.canonicalPayerId, scope.canonicalPayerId),
        eq(table.programKind, "managed_care"),
        eq(table.serviceState, scope.serviceState),
        eq(table.serviceCategory, "CHC"),
        lte(table.effectiveFrom, scope.serviceTo),
      ),
    )
    .orderBy(table.effectiveFrom, table.id)
    .limit(1001);
  if (rows.length > 1000) {
    return { status: "ambiguous", reasonCode: "BILLING_EVIDENCE_HISTORY_LIMIT_EXCEEDED" };
  }
  if (rows.length === 0) return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_MISSING" };
  const lineage = resolveBillingEvidenceLineage({
    rows,
    serviceFrom: scope.serviceFrom,
    serviceTo: scope.serviceTo,
    assessedAt: scope.assessedAt,
  });
  if (lineage.status === "segmentation_required") {
    return { status: "ambiguous", reasonCode: "CHC_BILLING_EVIDENCE_SEGMENTATION_UNSUPPORTED" };
  }
  if (lineage.status !== "verified") return lineage;
  const row = lineage.row;
  const assessedAt = Date.parse(scope.assessedAt);
  if (scope.admissionVersion === undefined || row.admissionVersion !== scope.admissionVersion) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_ADMISSION_VERSION_STALE" };
  }
  if (
    !Number.isFinite(assessedAt) ||
    !row.verifiedAt ||
    row.verifiedAt.getTime() > assessedAt ||
    row.effectiveFrom > scope.serviceFrom ||
    (row.effectiveTo !== null && row.effectiveTo < scope.serviceTo)
  ) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_NOT_CURRENT_FOR_ASSESSMENT" };
  }
  if (
    row.organizationId !== scope.organizationId ||
    row.providerEntityId !== scope.providerEntityId ||
    row.patientId !== scope.patientId ||
    row.admissionId !== scope.admissionId ||
    row.canonicalPayerId !== scope.canonicalPayerId ||
    row.programKind !== "managed_care" ||
    row.serviceState !== "OR" ||
    row.serviceCategory !== "CHC" ||
    row.quantityPolicy !== "m6_symptom_crisis_plus_signed_m8_rn_intervals_v1" ||
    row.quantityEvidenceOwner !== "m6_loc_m8_encounter" ||
    row.billingUnit !== "hourly" ||
    row.revenueCode !== null ||
    row.hcpcsCode !== null ||
    row.codingProfile !== "local_draft_only" ||
    row.billedChargeCentsPerUnit <= 0
  ) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_UNSUPPORTED" };
  }
  return { status: "verified", row };
}

/** Source-backed daily IRC local coding/charge profile. It deliberately admits only one complete evidence row. */
export async function readMedicaidIrcBillingEvidence(
  tx: Tx,
  scope: RHCPriceScope,
): Promise<
  | { readonly status: "verified"; readonly row: BillingEvidence }
  | { readonly status: "unresolved" | "ambiguous"; readonly reasonCode: string }
> {
  const table = schema.medicaidHospiceBillingEvidence;
  await lockHospiceBillingEvidenceScope(tx, scope, "IRC");
  const rows = await tx
    .select()
    .from(table)
    .where(
      and(
        eq(table.organizationId, scope.organizationId),
        eq(table.providerEntityId, scope.providerEntityId),
        eq(table.patientId, scope.patientId),
        eq(table.admissionId, scope.admissionId),
        eq(table.canonicalPayerId, scope.canonicalPayerId),
        eq(table.programKind, "managed_care"),
        eq(table.serviceState, scope.serviceState),
        eq(table.serviceCategory, "IRC"),
        lte(table.effectiveFrom, scope.serviceTo),
      ),
    )
    .orderBy(table.effectiveFrom, table.id)
    .limit(1001);
  if (rows.length > 1000) {
    return { status: "ambiguous", reasonCode: "BILLING_EVIDENCE_HISTORY_LIMIT_EXCEEDED" };
  }
  if (rows.length === 0) return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_MISSING" };
  const lineage = resolveBillingEvidenceLineage({
    rows,
    serviceFrom: scope.serviceFrom,
    serviceTo: scope.serviceTo,
    assessedAt: scope.assessedAt,
  });
  if (lineage.status === "segmentation_required") {
    return { status: "ambiguous", reasonCode: "IRC_BILLING_EVIDENCE_SEGMENTATION_UNSUPPORTED" };
  }
  if (lineage.status !== "verified") return lineage;
  const row = lineage.row;
  const assessedAt = Date.parse(scope.assessedAt);
  if (
    scope.admissionVersion === undefined ||
    row.admissionVersion !== scope.admissionVersion ||
    !Number.isFinite(assessedAt) ||
    !row.verifiedAt ||
    row.verifiedAt.getTime() > assessedAt ||
    row.effectiveFrom > scope.serviceFrom ||
    (row.effectiveTo !== null && row.effectiveTo < scope.serviceTo)
  ) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_NOT_CURRENT_FOR_ASSESSMENT" };
  }
  if (
    row.organizationId !== scope.organizationId ||
    row.providerEntityId !== scope.providerEntityId ||
    row.patientId !== scope.patientId ||
    row.admissionId !== scope.admissionId ||
    row.canonicalPayerId !== scope.canonicalPayerId ||
    row.programKind !== "managed_care" ||
    row.serviceState !== "OR" ||
    row.serviceCategory !== "IRC" ||
    row.quantityPolicy !== "m37_irc_episode_daily_v1" ||
    row.quantityEvidenceOwner !== "m37_irc_episode_and_remote_stay" ||
    row.billingUnit !== "daily" ||
    row.revenueCode !== "0655" ||
    row.hcpcsCode !== "Q5005" ||
    row.codingProfile !== "local_draft_only" ||
    row.billedChargeCentsPerUnit <= 0
  ) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_UNSUPPORTED" };
  }
  return { status: "verified", row };
}

/** Source-backed local GIP daily coding and charge profile. It never qualifies payer transmission. */
export async function readMedicaidGipBillingEvidence(
  tx: Tx,
  scope: RHCPriceScope,
): Promise<
  | { readonly status: "verified"; readonly row: BillingEvidence }
  | { readonly status: "unresolved" | "ambiguous"; readonly reasonCode: string }
> {
  const table = schema.medicaidHospiceBillingEvidence;
  await lockHospiceBillingEvidenceScope(tx, scope, "GIP");
  const rows = await tx
    .select()
    .from(table)
    .where(
      and(
        eq(table.organizationId, scope.organizationId),
        eq(table.providerEntityId, scope.providerEntityId),
        eq(table.patientId, scope.patientId),
        eq(table.admissionId, scope.admissionId),
        eq(table.canonicalPayerId, scope.canonicalPayerId),
        eq(table.programKind, "managed_care"),
        eq(table.serviceState, scope.serviceState),
        eq(table.serviceCategory, "GIP"),
        lte(table.effectiveFrom, scope.serviceTo),
      ),
    )
    .orderBy(table.effectiveFrom, table.id)
    .limit(1001);
  if (rows.length > 1000)
    return { status: "ambiguous", reasonCode: "BILLING_EVIDENCE_HISTORY_LIMIT_EXCEEDED" };
  if (rows.length === 0) return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_MISSING" };
  const lineage = resolveBillingEvidenceLineage({
    rows,
    serviceFrom: scope.serviceFrom,
    serviceTo: scope.serviceTo,
    assessedAt: scope.assessedAt,
  });
  if (lineage.status === "segmentation_required")
    return { status: "ambiguous", reasonCode: "GIP_BILLING_EVIDENCE_SEGMENTATION_UNSUPPORTED" };
  if (lineage.status !== "verified") return lineage;
  const row = lineage.row;
  const assessedAt = Date.parse(scope.assessedAt);
  if (
    scope.admissionVersion === undefined ||
    row.admissionVersion !== scope.admissionVersion ||
    !Number.isFinite(assessedAt) ||
    !row.verifiedAt ||
    row.verifiedAt.getTime() > assessedAt ||
    row.effectiveFrom > scope.serviceFrom ||
    (row.effectiveTo !== null && row.effectiveTo < scope.serviceTo)
  ) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_NOT_CURRENT_FOR_ASSESSMENT" };
  }
  if (
    row.organizationId !== scope.organizationId ||
    row.providerEntityId !== scope.providerEntityId ||
    row.patientId !== scope.patientId ||
    row.admissionId !== scope.admissionId ||
    row.canonicalPayerId !== scope.canonicalPayerId ||
    row.programKind !== "managed_care" ||
    row.serviceState !== "OR" ||
    row.serviceCategory !== "GIP" ||
    row.quantityPolicy !== "m37_gip_own_unit_daily_v1" ||
    row.quantityEvidenceOwner !== "m37_gip_admission_criteria_and_confirmed_bed_history" ||
    row.billingUnit !== "daily" ||
    row.revenueCode !== "0656" ||
    row.hcpcsCode !== "Q5006" ||
    row.codingProfile !== "local_draft_only" ||
    row.billedChargeCentsPerUnit <= 0
  ) {
    return { status: "unresolved", reasonCode: "GIP_BILLING_EVIDENCE_UNSUPPORTED" };
  }
  return { status: "verified", row };
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function safeProduct(left: number, right: number): number | null {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left <= 0 || right <= 0)
    return null;
  const value = BigInt(left) * BigInt(right);
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= 2_147_483_647 ? number : null;
}

/**
 * Deterministic serializer used only for the snapshot integrity fingerprint. Object keys sort recursively;
 * unsupported values are rejected instead of normalized into a potentially colliding representation.
 */
export function canonicalPricingSnapshotJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("pricing snapshot contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalPricingSnapshotJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalPricingSnapshotJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("pricing snapshot contains an unsupported value");
}

export function pricingSnapshotFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalPricingSnapshotJson(value), "utf8").digest("hex");
}

/** The supported local RHC code is Q5001, so every billed service date must be a complete home span. */
export function resolveRhcHomeResidence(
  spans: readonly RHCServiceResidenceSpan[],
  serviceFrom: string,
  serviceTo: string,
):
  | { readonly status: "resolved"; readonly span: RHCServiceResidenceSpan }
  | { readonly status: "unresolved" | "ambiguous" | "unsupported"; readonly reasonCode: string } {
  const overlapping = spans.filter(
    (span) =>
      span.effectiveFrom <= serviceTo &&
      (span.effectiveTo === null || span.effectiveTo >= serviceFrom),
  );
  if (overlapping.length === 0) {
    return { status: "unresolved", reasonCode: "RHC_SERVICE_RESIDENCE_MISSING" };
  }
  if (overlapping.length !== 1) {
    return { status: "ambiguous", reasonCode: "RHC_SERVICE_RESIDENCE_AMBIGUOUS" };
  }
  const span = overlapping[0]!;
  if (
    span.effectiveFrom > serviceFrom ||
    (span.effectiveTo !== null && span.effectiveTo < serviceTo)
  ) {
    return { status: "unresolved", reasonCode: "RHC_SERVICE_RESIDENCE_PERIOD_INCOMPLETE" };
  }
  if (span.kind !== "home" || span.facilityId !== null) {
    return { status: "unsupported", reasonCode: "RHC_Q5001_REQUIRES_HOME_RESIDENCE" };
  }
  if (!span.addressId) {
    return { status: "unresolved", reasonCode: "RHC_SERVICE_RESIDENCE_ID_MISSING" };
  }
  return { status: "resolved", span };
}

/** A facility-based daily RHC profile requires an effective M5 facility residence and M40 kind. */
export function resolveRhcAssistedLivingResidence(
  spans: readonly RHCServiceResidenceSpan[],
  facilityKinds: ReadonlyMap<string, string>,
  serviceFrom: string,
  serviceTo: string,
):
  | {
      readonly status: "resolved";
      readonly span: RHCServiceResidenceSpan;
      readonly facilityKind: "alf";
    }
  | { readonly status: "unresolved" | "ambiguous" | "unsupported"; readonly reasonCode: string } {
  const overlapping = spans.filter(
    (span) =>
      span.effectiveFrom <= serviceTo &&
      (span.effectiveTo === null || span.effectiveTo >= serviceFrom),
  );
  if (overlapping.length === 0) {
    return { status: "unresolved", reasonCode: "RHC_SERVICE_RESIDENCE_MISSING" };
  }
  if (overlapping.length !== 1) {
    return { status: "ambiguous", reasonCode: "RHC_SERVICE_RESIDENCE_AMBIGUOUS" };
  }
  const span = overlapping[0]!;
  if (
    span.effectiveFrom > serviceFrom ||
    (span.effectiveTo !== null && span.effectiveTo < serviceTo)
  ) {
    return { status: "unresolved", reasonCode: "RHC_SERVICE_RESIDENCE_PERIOD_INCOMPLETE" };
  }
  if (span.kind !== "facility" || !span.facilityId || !span.addressId) {
    return { status: "unsupported", reasonCode: "RHC_Q5002_REQUIRES_FACILITY_RESIDENCE" };
  }
  const facilityKind = facilityKinds.get(span.facilityId);
  if (!facilityKind) {
    return { status: "unresolved", reasonCode: "RHC_FACILITY_KIND_UNRESOLVED" };
  }
  if (facilityKind !== "alf") {
    return { status: "unsupported", reasonCode: "RHC_Q5002_REQUIRES_ASSISTED_LIVING" };
  }
  return { status: "resolved", span, facilityKind };
}

/** Shared single-evidence daily price resolver used inside the shared segmented planner. */
function resolveSingleRhcDailyPricingPlan(input: {
  readonly scope: RHCPriceScope;
  readonly evidence: BillingEvidence;
  readonly locPeriods: readonly RHCServiceLocPeriod[];
  readonly rates: readonly PayerRatePolicyFact[];
  readonly residenceSpans: readonly RHCServiceResidenceSpan[];
  readonly facilityKinds: ReadonlyMap<string, string>;
  readonly electionHistory: MedicaidElectionHistoryFacts | null;
}): RHCPricePlanResult {
  const { scope, evidence } = input;
  if (
    evidence.organizationId !== scope.organizationId ||
    evidence.providerEntityId !== scope.providerEntityId ||
    evidence.patientId !== scope.patientId ||
    evidence.admissionId !== scope.admissionId ||
    evidence.canonicalPayerId !== scope.canonicalPayerId ||
    evidence.programKind !== scope.programKind ||
    evidence.serviceState !== scope.serviceState ||
    evidence.verificationStatus !== "verified"
  ) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_SCOPE_MISMATCH" };
  }
  if (scope.programKind !== "managed_care") {
    return { status: "unsupported", reasonCode: "RHC_PRICING_PROGRAM_UNSUPPORTED" };
  }
  if (evidence.hcpcsCode !== "Q5001" && evidence.hcpcsCode !== "Q5002") {
    return { status: "unsupported", reasonCode: "RHC_DAILY_LOCAL_PROFILE_UNSUPPORTED" };
  }
  if (
    !evidence.revenueCode ||
    !evidence.hcpcsCode ||
    evidence.effectiveFrom > scope.serviceFrom ||
    (evidence.effectiveTo !== null && evidence.effectiveTo < scope.serviceTo) ||
    evidence.admissionVersion !== scope.admissionVersion
  ) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_STALE_OR_OUT_OF_RANGE" };
  }
  const residence =
    evidence.hcpcsCode === "Q5001"
      ? resolveRhcHomeResidence(input.residenceSpans, scope.serviceFrom, scope.serviceTo)
      : resolveRhcAssistedLivingResidence(
          input.residenceSpans,
          input.facilityKinds,
          scope.serviceFrom,
          scope.serviceTo,
        );
  if (residence.status !== "resolved") {
    return { status: residence.status, reasonCode: residence.reasonCode };
  }
  const electionDays = resolveRhcElectionDayRange({
    history: input.electionHistory,
    rateRows: input.rates,
    organizationId: scope.organizationId,
    providerEntityId: scope.providerEntityId,
    patientId: scope.patientId,
    admissionId: scope.admissionId,
    admissionVersion: scope.admissionVersion,
    programKind: scope.programKind,
    serviceFrom: scope.serviceFrom,
    serviceTo: scope.serviceTo,
    assessedAt: scope.assessedAt,
  });
  if (
    electionDays.status === "unresolved" ||
    electionDays.status === "ambiguous" ||
    electionDays.status === "unsupported"
  ) {
    return {
      status: electionDays.status,
      reasonCode: electionDays.reasonCode ?? "RHC_ELECTION_HISTORY_UNRESOLVED",
    };
  }

  const inclusiveEndDate = scope.inclusiveEndDate ?? null;
  const deathPeriodId = inclusiveDeathLocPeriodId(input.locPeriods, inclusiveEndDate);
  const periods = input.locPeriods
    .map((period) => ({
      period,
      from: isoDate(period.effectiveAt),
      to:
        m6LocClaimEndDate(period.endedAt, period.id === deathPeriodId ? inclusiveEndDate : null) ??
        scope.serviceTo,
    }))
    .filter(({ from, to }) => from <= scope.serviceTo && to >= scope.serviceFrom)
    .map(({ period, from, to }) => ({
      period,
      from: from < scope.serviceFrom ? scope.serviceFrom : from,
      to: to > scope.serviceTo ? scope.serviceTo : to,
    }))
    .sort((a, b) => a.from.localeCompare(b.from));
  if (periods.length === 0) return { status: "unresolved", reasonCode: "M6_LOC_EVIDENCE_MISSING" };

  const lines: RHCPriceLinePlan[] = [];
  let nextExpected = scope.serviceFrom;
  for (const period of periods) {
    if (period.from !== nextExpected || period.to < period.from) {
      return { status: "ambiguous", reasonCode: "M6_LOC_SERVICE_DAYS_CONFLICT" };
    }
    if (period.period.levelOfCare !== "routine_home_care") {
      return { status: "unsupported", reasonCode: "RHC_DAILY_PATH_ONLY" };
    }
    if (
      !Number.isSafeInteger(period.period.version) ||
      period.period.version! < 0 ||
      !period.period.updatedAt
    ) {
      return { status: "unresolved", reasonCode: "M6_LOC_VERSION_UNAVAILABLE" };
    }
    const days: Parameters<typeof assessHospicePricing>[0]["days"][number][] = [];
    for (
      let time = Date.parse(`${period.from}T00:00:00.000Z`);
      time <= Date.parse(`${period.to}T00:00:00.000Z`);
      time += 86_400_000
    ) {
      const serviceDate = new Date(time).toISOString().slice(0, 10);
      const electionDayEvidence = electionDays.days.get(serviceDate) ?? null;
      if (electionDays.status === "resolved" && !electionDayEvidence) {
        return { status: "unresolved", reasonCode: "RHC_ELECTION_SERVICE_DAYS_INCOMPLETE" };
      }
      days.push({
        serviceDate,
        serviceCategory: "RHC",
        unitBasis: "per_day",
        localityCode: evidence.localityCode,
        localityEvidence: {
          localityCode: evidence.localityCode,
          serviceState: evidence.serviceState,
          sourceReference: evidence.localityEvidenceReference,
          version: evidence.localityEvidenceVersion,
          verifiedAt: evidence.verifiedAt!.toISOString(),
          effectiveFrom: evidence.effectiveFrom,
          effectiveTo: evidence.effectiveTo,
        },
        electionDayEvidence,
        inpatientRespiteDayEvidence: null,
        quantity: { unitBasis: "per_day", units: 1 },
        quantityEvidence: {
          serviceDate,
          providerEntityId: scope.providerEntityId,
          serviceCategory: "RHC",
          unitBasis: "per_day",
          sourceReference: `m6:level-of-care-period:${period.period.id}`,
          version: period.period.version!,
          verifiedAt: period.period.updatedAt.toISOString(),
        },
        providerUsualCharge: null,
        payerContext: {
          organizationId: scope.organizationId,
          providerEntityId: scope.providerEntityId,
          canonicalPayerId: scope.canonicalPayerId,
          programKind: scope.programKind,
          serviceState: scope.serviceState,
          assessedAt: scope.assessedAt,
          qualityReporting: {
            applicability: evidence.qualityReportingApplicability as "required" | "not_required",
            providerStatus: evidence.qualityReportingStatus as
              | "not_applicable"
              | "meets"
              | "does_not_meet",
            evidenceReference: evidence.qualityEvidenceReference,
            evidenceVersion: evidence.qualityEvidenceVersion,
            verifiedAt: evidence.verifiedAt!.toISOString(),
            effectiveFrom: evidence.effectiveFrom,
            effectiveTo: evidence.effectiveTo,
          },
        },
      });
    }
    const assessment = assessHospicePricing({
      serviceFrom: period.from,
      serviceTo: period.to,
      assessedAt: scope.assessedAt,
      days,
      rates: input.rates,
    });
    if (assessment.status !== "fully_resolved" || !assessment.coversRequestedPeriod) {
      return {
        status: assessment.status === "ambiguous" ? "ambiguous" : "unresolved",
        reasonCode:
          assessment.segments.flatMap((segment) => segment.reasonCodes)[0] ??
          "MEDICAID_RATE_POLICY_UNRESOLVED",
      };
    }
    let expectedDate = period.from;
    for (const segment of assessment.segments) {
      if (
        segment.status !== "resolved" ||
        segment.serviceFrom !== expectedDate ||
        segment.serviceTo < segment.serviceFrom ||
        !segment.rateEvidence ||
        segment.rateEvidence.unitBasis !== "per_day" ||
        segment.quantity?.unitBasis !== "per_day" ||
        !Number.isSafeInteger(segment.quantity.units) ||
        segment.quantity.units <= 0 ||
        segment.reimbursementEstimateCents === null ||
        segment.baseReimbursementCents === null
      ) {
        return { status: "unresolved", reasonCode: "MEDICAID_RATE_POLICY_UNRESOLVED" };
      }
      const rate = input.rates.find((row) => row.id === segment.rateEvidence!.id);
      if (!rate || rate.version !== segment.rateEvidence.version) {
        return { status: "unresolved", reasonCode: "MEDICAID_RATE_POLICY_VERSION_MISMATCH" };
      }
      const chargesCents = safeProduct(evidence.billedChargeCentsPerUnit, segment.quantity.units);
      if (chargesCents === null)
        return { status: "unresolved", reasonCode: "BILLED_CHARGE_OVERFLOW" };
      // The residence is bound to the CLAIMED days only (its span clipped to this line), like the LOC facts
      // below: the planner already refused a span that does not cover them, so a later move-out that
      // closes the open address row does not touch a single claimed day and must not stale the draft.
      const electionDaySnapshot = electionDays.snapshot;
      const electionDayFrom = electionDays.days.get(segment.serviceFrom);
      const electionDayTo = electionDays.days.get(segment.serviceTo);
      const snapshotSchemaVersion: 1 | 2 | 3 = electionDaySnapshot
        ? 3
        : evidence.hcpcsCode === "Q5002"
          ? 2
          : 1;
      const serviceLocation =
        evidence.hcpcsCode === "Q5002"
          ? {
              patientAddressId: residence.span.addressId,
              kind: residence.span.kind,
              facilityId: residence.span.facilityId,
              facilityKind: "alf",
              effectiveFrom: segment.serviceFrom,
              effectiveTo: segment.serviceTo,
            }
          : {
              patientAddressId: residence.span.addressId,
              kind: residence.span.kind,
              facilityId: residence.span.facilityId,
              effectiveFrom: segment.serviceFrom,
              effectiveTo: segment.serviceTo,
            };
      const facts: Record<string, unknown> = {
        schemaVersion: snapshotSchemaVersion,
        postingAuthorized: false,
        organizationId: scope.organizationId,
        providerEntityId: scope.providerEntityId,
        patientId: scope.patientId,
        admissionId: scope.admissionId,
        canonicalPayerId: scope.canonicalPayerId,
        programKind: scope.programKind,
        serviceState: scope.serviceState,
        serviceFrom: segment.serviceFrom,
        serviceTo: segment.serviceTo,
        levelOfCare: "RHC",
        // Bound to the facts that govern the CLAIMED days (period identity and its extent clipped to the
        // claimed range), not to the M6 row's version/updated_at: closing the open period after the
        // claimed range bumps both without touching any claimed day. Any real change to a claimed day
        // (its period, bounds within the range, or level of care) still fails verification.
        locPeriodId: period.period.id,
        locEffectiveFrom: period.from,
        locEffectiveTo: period.to,
        quantity: {
          basis: "per_day",
          units: segment.quantity.units,
          source: "M6_active_RHC_calendar_days",
        },
        locality: {
          code: evidence.localityCode,
          evidenceReference: evidence.localityEvidenceReference,
          evidenceVersion: evidence.localityEvidenceVersion,
        },
        serviceLocation,
        qualityReporting: {
          applicability: evidence.qualityReportingApplicability,
          status: evidence.qualityReportingStatus,
          evidenceReference: evidence.qualityEvidenceReference,
          evidenceVersion: evidence.qualityEvidenceVersion,
        },
        billingEvidenceId: evidence.id,
        billingEvidenceVersion: evidence.version,
        rateCents: rate.rateCents,
        rateVersion: rate.version,
        payerRatePolicyId: rate.id,
        rateSourceKind: rate.sourceKind,
        rateDocumentReference: rate.sourceDocumentRef,
        pricingMethod: rate.pricingMethod,
        methodologyVersion: rate.methodologyVersion,
        quantityConversionMethod: rate.quantityConversionMethod,
        roundingMode: rate.roundingMode,
        roundingBoundary: rate.roundingBoundary,
        chargeCeilingMethod: rate.chargeCeilingMethod,
        chargeCeilingBoundary: rate.chargeCeilingBoundary,
        reimbursementEstimateCents: segment.reimbursementEstimateCents,
        baseReimbursementCents: segment.baseReimbursementCents,
        appliedCeilings: segment.appliedCeilings,
        billedChargeCentsPerUnit: evidence.billedChargeCentsPerUnit,
        billedChargeCents: chargesCents,
        chargeEvidenceReference: evidence.chargeEvidenceReference,
        chargeEvidenceVersion: evidence.chargeEvidenceVersion,
        revenueCode: evidence.revenueCode,
        hcpcsCode: evidence.hcpcsCode,
        codingProfile: evidence.codingProfile,
        codingEvidenceReference: evidence.codingEvidenceReference,
        codingEvidenceVersion: evidence.codingEvidenceVersion,
      };
      if (snapshotSchemaVersion === 2) {
        facts.localBillingProfile = "rhc_assisted_living_q5002_daily_v1";
      }
      if (snapshotSchemaVersion === 3) {
        const attestation = input.electionHistory?.historyEvidence;
        if (
          !electionDaySnapshot ||
          !electionDayFrom ||
          !electionDayTo ||
          !attestation ||
          rate.bucketFrom === null
        ) {
          return { status: "unresolved", reasonCode: "RHC_ELECTION_BUCKET_SNAPSHOT_INCOMPLETE" };
        }
        facts.localBillingProfile = "rhc_home_election_bucket_daily_v1";
        facts.admissionVersion = scope.admissionVersion;
        facts.electionDay = {
          ...electionDaySnapshot,
          sourceReference: attestation.sourceReference,
          sourceVersion: attestation.sourceVersion,
          dayFrom: electionDayFrom.electionDayNumber,
          dayTo: electionDayTo.electionDayNumber,
          rateBucketFrom: rate.bucketFrom,
          rateBucketTo: rate.bucketTo,
        };
      }
      lines.push({
        snapshotSchemaVersion,
        serviceFrom: segment.serviceFrom,
        serviceTo: segment.serviceTo,
        locPeriodId: period.period.id,
        units: segment.quantity.units,
        rateCents: rate.rateCents,
        baseReimbursementCents: segment.baseReimbursementCents,
        chargesCents,
        reimbursementEstimateCents: segment.reimbursementEstimateCents,
        appliedCeilings: segment.appliedCeilings,
        revenueCode: evidence.revenueCode,
        hcpcsCode: evidence.hcpcsCode,
        rate,
        evidence,
        integrityFacts: facts,
      });
      expectedDate = new Date(Date.parse(`${segment.serviceTo}T00:00:00.000Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
    }
    const periodNext = new Date(Date.parse(`${period.to}T00:00:00.000Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    if (expectedDate !== periodNext)
      return { status: "unresolved", reasonCode: "PRICED_SEGMENT_COVERAGE_GAP" };
    nextExpected = periodNext;
  }
  if (
    nextExpected !==
    new Date(Date.parse(`${scope.serviceTo}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)
  ) {
    return { status: "unresolved", reasonCode: "M6_LOC_SERVICE_DAYS_INCOMPLETE" };
  }
  return { status: "resolved", lines };
}

/**
 * Shared pricing pipeline for preview, assembly, and revalidation. Adjacent verified billing-evidence
 * heads are evaluated independently, then joined in date order. A segment-level contract ceiling is
 * applied once across the contiguous lines of ONE M6 level-of-care period that use the same rate
 * identity (the segment the engine caps; a second period is a second segment), and its result is
 * allocated in integer minor units so evidence segmentation cannot multiply the ceiling.
 */
export function resolveRhcDailyPricingPlan(input: {
  readonly scope: RHCPriceScope;
  readonly evidence: BillingEvidence | readonly BillingEvidence[];
  readonly locPeriods: readonly RHCServiceLocPeriod[];
  readonly rates: readonly PayerRatePolicyFact[];
  readonly residenceSpans: readonly RHCServiceResidenceSpan[];
  readonly facilityKinds?: ReadonlyMap<string, string>;
  readonly electionHistory?: MedicaidElectionHistoryFacts | null;
}): RHCPricePlanResult {
  const rows: readonly BillingEvidence[] = Array.isArray(input.evidence)
    ? input.evidence
    : [input.evidence as BillingEvidence];
  if (rows.length === 0) return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_MISSING" };
  const sorted = [...rows].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const lines: RHCPriceLinePlan[] = [];
  let expected = input.scope.serviceFrom;
  for (const row of sorted) {
    const from =
      row.effectiveFrom < input.scope.serviceFrom ? input.scope.serviceFrom : row.effectiveFrom;
    const to =
      row.effectiveTo === null || row.effectiveTo > input.scope.serviceTo
        ? input.scope.serviceTo
        : row.effectiveTo;
    if (from < expected)
      return { status: "ambiguous", reasonCode: "BILLING_EVIDENCE_OVERLAPPING_HEADS" };
    if (from > expected || to < from) {
      return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_PERIOD_INCOMPLETE" };
    }
    const result = resolveSingleRhcDailyPricingPlan({
      scope: { ...input.scope, serviceFrom: from, serviceTo: to },
      evidence: row,
      locPeriods: input.locPeriods,
      rates: input.rates,
      residenceSpans: input.residenceSpans,
      facilityKinds: input.facilityKinds ?? new Map(),
      electionHistory: input.electionHistory ?? null,
    });
    if (result.status !== "resolved") return result;
    lines.push(...result.lines);
    const nextExpected = nextCalendarDate(to);
    if (nextExpected === null)
      return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_PERIOD_INVALID" };
    expected = nextExpected;
  }
  const afterScope = nextCalendarDate(input.scope.serviceTo);
  if (expected !== afterScope) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_PERIOD_INCOMPLETE" };
  }
  const ceilingAdjusted = applySegmentCeilingAcrossEvidence(lines);
  if (!ceilingAdjusted)
    return { status: "unresolved", reasonCode: "RHC_SEGMENT_CEILING_ALLOCATION_UNRESOLVED" };
  return { status: "resolved", lines: ceilingAdjusted };
}

/**
 * Narrow, source-backed local IRC daily planner. It consumes the shared M24 evidence lineage and the
 * existing payer pricing engine; only a single fresh M37 episode, remote stay, M6 LOC and active M40
 * hospital facility are supported. Resumption, transfer, overrides and mixed LOC remain holds.
 */
export function resolveIrcDailyPricingPlan(input: {
  readonly scope: RHCPriceScope;
  readonly evidence: BillingEvidence;
  readonly locPeriods: readonly RHCServiceLocPeriod[];
  readonly rates: readonly PayerRatePolicyFact[];
  readonly episode: IrcPricingEpisodeFacts | null;
  readonly facilityKinds: ReadonlyMap<string, string>;
}): RHCPricePlanResult {
  const { scope, evidence, episode } = input;
  const refuse = (status: "unresolved" | "ambiguous" | "unsupported", reasonCode: string) =>
    ({
      status,
      reasonCode,
    }) as const;
  if (!episode) return refuse("unresolved", "IRC_EPISODE_OR_STAY_UNAVAILABLE");
  if (
    scope.programKind !== "managed_care" ||
    scope.serviceState !== "OR" ||
    evidence.organizationId !== scope.organizationId ||
    evidence.providerEntityId !== scope.providerEntityId ||
    evidence.patientId !== scope.patientId ||
    evidence.admissionId !== scope.admissionId ||
    evidence.canonicalPayerId !== scope.canonicalPayerId ||
    evidence.programKind !== scope.programKind ||
    evidence.serviceState !== scope.serviceState ||
    evidence.verificationStatus !== "verified" ||
    evidence.serviceCategory !== "IRC" ||
    evidence.quantityPolicy !== "m37_irc_episode_daily_v1" ||
    evidence.quantityEvidenceOwner !== "m37_irc_episode_and_remote_stay" ||
    evidence.billingUnit !== "daily" ||
    evidence.revenueCode !== "0655" ||
    evidence.hcpcsCode !== "Q5005" ||
    evidence.codingProfile !== "local_draft_only" ||
    evidence.billedChargeCentsPerUnit <= 0 ||
    evidence.admissionVersion !== scope.admissionVersion ||
    evidence.effectiveFrom > scope.serviceFrom ||
    (evidence.effectiveTo !== null && evidence.effectiveTo < scope.serviceTo)
  ) {
    return refuse("unresolved", "IRC_BILLING_EVIDENCE_SCOPE_OR_PROFILE_UNSUPPORTED");
  }
  const assessedAt = Date.parse(scope.assessedAt);
  const evidenceTimes = [
    evidence.verifiedAt?.getTime() ?? Number.NaN,
    episode.ipuAdmissionUpdatedAt.getTime(),
    episode.episodeUpdatedAt.getTime(),
    episode.remoteStayUpdatedAt.getTime(),
  ];
  if (
    !Number.isFinite(assessedAt) ||
    evidenceTimes.some((time) => !Number.isFinite(time) || time > assessedAt)
  ) {
    return refuse("unresolved", "IRC_EVIDENCE_NOT_CURRENT_AT_ASSESSMENT");
  }
  if (
    episode.organizationId !== scope.organizationId ||
    episode.providerEntityId !== scope.providerEntityId ||
    episode.patientId !== scope.patientId ||
    episode.admissionId !== scope.admissionId ||
    episode.locPeriodId === "" ||
    episode.ipuAdmissionId === "" ||
    episode.ipuAdmissionKind !== "arranged" ||
    !["active", "discharged", "closed"].includes(episode.ipuAdmissionState) ||
    episode.episodeId === "" ||
    !Number.isSafeInteger(episode.episodeVersion) ||
    !Number.isSafeInteger(episode.ipuAdmissionVersion) ||
    !Number.isSafeInteger(episode.remoteStayVersion) ||
    episode.episodeState === "breached" ||
    !["active", "approaching_cap", "closed"].includes(episode.episodeState) ||
    (episode.episodeState === "closed") !== (episode.episodeClosedAt !== null) ||
    ["discharged", "closed"].includes(episode.ipuAdmissionState) !==
      (episode.ipuAdmissionClosedAt !== null) ||
    episode.carriedOverDays !== 0 ||
    episode.capOverrideInvoked ||
    !Number.isSafeInteger(episode.consecutiveDayCount) ||
    episode.consecutiveDayCount < 1 ||
    !episode.agreementDocumentId ||
    episode.transitionBeforeServiceEnd ||
    !episode.serviceTimeZone.trim() ||
    episode.episodeStartedLocalDate > scope.serviceFrom ||
    episode.remoteStayStartedLocalDate !== episode.episodeStartedLocalDate ||
    episode.remoteStayStartedLocalDate > scope.serviceFrom ||
    (episode.remoteStayEndLocalDate !== null &&
      episode.remoteStayEndLocalDate < nextCalendarDate(scope.serviceTo)!) ||
    (episode.episodeClosedLocalDate !== null &&
      episode.episodeClosedLocalDate < nextCalendarDate(scope.serviceTo)!) ||
    (episode.ipuAdmissionClosedLocalDate !== null &&
      episode.ipuAdmissionClosedLocalDate < nextCalendarDate(scope.serviceTo)!)
  ) {
    return refuse("unresolved", "IRC_EPISODE_CONTINUITY_UNQUALIFIED");
  }
  if (episode.consecutiveDayCount > 5) {
    return refuse("unsupported", "INPATIENT_RESPITE_LIMIT_EXCEEDED");
  }
  const dayFrom =
    Math.floor(
      (Date.parse(`${scope.serviceFrom}T00:00:00.000Z`) -
        Date.parse(`${episode.episodeStartedLocalDate}T00:00:00.000Z`)) /
        86_400_000,
    ) + 1;
  const dayTo =
    Math.floor(
      (Date.parse(`${scope.serviceTo}T00:00:00.000Z`) -
        Date.parse(`${episode.episodeStartedLocalDate}T00:00:00.000Z`)) /
        86_400_000,
    ) + 1;
  if (
    !Number.isSafeInteger(dayFrom) ||
    !Number.isSafeInteger(dayTo) ||
    dayFrom < 1 ||
    dayTo < dayFrom ||
    dayTo > 5 ||
    dayTo > episode.consecutiveDayCount
  ) {
    return refuse(
      "unsupported",
      dayTo > 5 ? "INPATIENT_RESPITE_LIMIT_EXCEEDED" : "IRC_SEQUENCE_UNRESOLVED",
    );
  }
  const periods = input.locPeriods
    .map((period) => ({
      period,
      from: isoDate(period.effectiveAt),
      to: m6LocClaimEndDate(period.endedAt) ?? scope.serviceTo,
    }))
    .filter(({ from, to }) => from <= scope.serviceTo && to >= scope.serviceFrom);
  if (periods.length !== 1) return refuse("ambiguous", "IRC_LOC_PERIOD_AMBIGUOUS");
  const { period, from: periodFrom, to: periodTo } = periods[0]!;
  if (
    period.levelOfCare !== "inpatient_respite_care" ||
    periodFrom > scope.serviceFrom ||
    periodTo < scope.serviceTo ||
    period.id !== episode.locPeriodId ||
    !period.facilityId ||
    period.facilityId !== episode.facilityId ||
    input.facilityKinds.get(episode.facilityId) !== "hospital" ||
    !Number.isSafeInteger(period.version) ||
    period.version! < 0 ||
    !period.updatedAt ||
    period.updatedAt.getTime() > assessedAt
  ) {
    return refuse("unresolved", "IRC_LOC_STAY_OR_FACILITY_MISMATCH");
  }
  const rates = input.rates.filter(
    (rate) =>
      rate.serviceCategory === "IRC" &&
      rate.unitBasis === "per_day" &&
      rate.bucketFrom === null &&
      rate.bucketTo === null &&
      rate.electionDayBasis === "unqualified",
  );
  if (rates.length === 0) return refuse("unresolved", "MEDICAID_RATE_POLICY_UNRESOLVED");
  const days: Parameters<typeof assessHospicePricing>[0]["days"][number][] = [];
  for (
    let time = Date.parse(`${scope.serviceFrom}T00:00:00.000Z`);
    time <= Date.parse(`${scope.serviceTo}T00:00:00.000Z`);
    time += 86_400_000
  ) {
    const serviceDate = new Date(time).toISOString().slice(0, 10);
    const consecutiveDayNumber =
      dayFrom + Math.round((time - Date.parse(`${scope.serviceFrom}T00:00:00.000Z`)) / 86_400_000);
    days.push({
      serviceDate,
      serviceCategory: "IRC",
      unitBasis: "per_day",
      localityCode: evidence.localityCode,
      localityEvidence: {
        localityCode: evidence.localityCode,
        serviceState: scope.serviceState,
        sourceReference: evidence.localityEvidenceReference,
        version: evidence.localityEvidenceVersion,
        verifiedAt: evidence.verifiedAt!.toISOString(),
        effectiveFrom: evidence.effectiveFrom,
        effectiveTo: evidence.effectiveTo,
      },
      electionDayEvidence: null,
      inpatientRespiteDayEvidence: {
        consecutiveDayNumber,
        serviceDate,
        episodeReference: `m37:irc_episode:${episode.episodeId}:v${episode.episodeVersion}`,
        sourceReference: `m37:remote_inpatient_episode:${episode.remoteStayId}:v${episode.remoteStayVersion}`,
        version: episode.remoteStayVersion,
        verifiedAt: episode.remoteStayUpdatedAt.toISOString(),
      },
      quantity: { unitBasis: "per_day", units: 1 },
      quantityEvidence: {
        serviceDate,
        providerEntityId: scope.providerEntityId,
        serviceCategory: "IRC",
        unitBasis: "per_day",
        sourceReference: `m6:level-of-care-period:${period.id}:v${period.version}`,
        version: period.version!,
        verifiedAt: period.updatedAt!.toISOString(),
      },
      providerUsualCharge: null,
      payerContext: {
        organizationId: scope.organizationId,
        providerEntityId: scope.providerEntityId,
        canonicalPayerId: scope.canonicalPayerId,
        programKind: scope.programKind,
        serviceState: scope.serviceState,
        assessedAt: scope.assessedAt,
        qualityReporting: {
          applicability: evidence.qualityReportingApplicability as "required" | "not_required",
          providerStatus: evidence.qualityReportingStatus as
            | "not_applicable"
            | "meets"
            | "does_not_meet",
          evidenceReference: evidence.qualityEvidenceReference,
          evidenceVersion: evidence.qualityEvidenceVersion,
          verifiedAt: evidence.verifiedAt!.toISOString(),
          effectiveFrom: evidence.effectiveFrom,
          effectiveTo: evidence.effectiveTo,
        },
      },
    });
  }
  const assessment = assessHospicePricing({
    serviceFrom: scope.serviceFrom,
    serviceTo: scope.serviceTo,
    assessedAt: scope.assessedAt,
    days,
    rates,
  });
  if (assessment.status !== "fully_resolved" || !assessment.coversRequestedPeriod) {
    const reasonCode =
      assessment.segments.flatMap((segment) => segment.reasonCodes)[0] ??
      "MEDICAID_RATE_POLICY_UNRESOLVED";
    return refuse(
      assessment.status === "ambiguous"
        ? "ambiguous"
        : assessment.status === "unsupported"
          ? "unsupported"
          : "unresolved",
      reasonCode,
    );
  }
  const lines: RHCPriceLinePlan[] = [];
  let expected = scope.serviceFrom;
  for (const segment of assessment.segments) {
    if (
      segment.status !== "resolved" ||
      segment.serviceFrom !== expected ||
      !segment.rateEvidence ||
      segment.quantity?.unitBasis !== "per_day" ||
      !Number.isSafeInteger(segment.quantity.units) ||
      segment.quantity.units <= 0 ||
      segment.baseReimbursementCents === null ||
      segment.reimbursementEstimateCents === null
    )
      return refuse("unresolved", "MEDICAID_RATE_POLICY_UNRESOLVED");
    const rate = rates.find(
      (row) => row.id === segment.rateEvidence!.id && row.version === segment.rateEvidence!.version,
    );
    if (!rate) return refuse("unresolved", "MEDICAID_RATE_POLICY_VERSION_MISMATCH");
    if (
      rate.pricingMethod !== "per_day" ||
      rate.quantityConversionMethod !== "daily_units" ||
      rate.chargeCeilingMethod !== "none" ||
      rate.chargeCeilingCents !== null
    ) {
      return refuse("unsupported", "IRC_DAILY_RATE_METHODOLOGY_UNQUALIFIED");
    }
    const chargesCents = safeProduct(evidence.billedChargeCentsPerUnit, segment.quantity.units);
    if (chargesCents === null) return refuse("unresolved", "BILLED_CHARGE_OVERFLOW");
    const serviceDays =
      Math.round(
        (Date.parse(`${segment.serviceTo}T00:00:00.000Z`) -
          Date.parse(`${segment.serviceFrom}T00:00:00.000Z`)) /
          86_400_000,
      ) + 1;
    const firstDay =
      dayFrom +
      Math.round(
        (Date.parse(`${segment.serviceFrom}T00:00:00.000Z`) -
          Date.parse(`${scope.serviceFrom}T00:00:00.000Z`)) /
          86_400_000,
      );
    const lastDay = firstDay + serviceDays - 1;
    const integrityFacts: Record<string, unknown> = {
      schemaVersion: 4,
      profile: "irc_hospital_q5005_daily_local_v1",
      postingAuthorized: false,
      institutionalFormatQualified: false,
      organizationId: scope.organizationId,
      providerEntityId: scope.providerEntityId,
      patientId: scope.patientId,
      admissionId: scope.admissionId,
      canonicalPayerId: scope.canonicalPayerId,
      programKind: scope.programKind,
      serviceState: scope.serviceState,
      serviceFrom: segment.serviceFrom,
      serviceTo: segment.serviceTo,
      serviceCategory: "IRC",
      levelOfCare: "IRC",
      locPeriodId: period.id,
      locEffectiveFrom: periodFrom,
      locEffectiveTo: periodTo,
      quantity: {
        basis: "per_day",
        units: segment.quantity.units,
        source: "M37_IRC_episode_days_v1",
      },
      episode: {
        episodeId: episode.episodeId,
        episodeVersion: episode.episodeVersion,
        ipuAdmissionId: episode.ipuAdmissionId,
        ipuAdmissionVersion: episode.ipuAdmissionVersion,
        ipuAdmissionState: episode.ipuAdmissionState,
        ipuAdmissionClosedLocalDate: episode.ipuAdmissionClosedLocalDate,
        remoteStayId: episode.remoteStayId,
        remoteStayVersion: episode.remoteStayVersion,
        facilityId: episode.facilityId,
        facilityKind: "hospital",
        facilityKindSource: "m40_facility",
        remoteStayStartedLocalDate: episode.remoteStayStartedLocalDate,
        remoteStayEndLocalDate: episode.remoteStayEndLocalDate,
        episodeStartLocalDate: episode.episodeStartedLocalDate,
        episodeExpectedEndLocalDate: episode.episodeExpectedEndLocalDate,
        episodeClosedLocalDate: episode.episodeClosedLocalDate,
        episodeStartAt: episode.episodeStartedAt.toISOString(),
        actualStayStartAt: episode.remoteStayStartedAt.toISOString(),
        actualStayEndAt: episode.remoteStayEndedAt?.toISOString() ?? null,
        episodeState: episode.episodeState,
        consecutiveDayCount: episode.consecutiveDayCount,
        agreementDocumentId: episode.agreementDocumentId,
        arrangementBillingBasis: episode.arrangementBillingBasis,
        serviceTimeZone: episode.serviceTimeZone,
        carriedOverDays: episode.carriedOverDays,
        capOverrideInvoked: episode.capOverrideInvoked,
        consecutiveDayFrom: firstDay,
        consecutiveDayTo: lastDay,
        transitionBeforeServiceEnd: episode.transitionBeforeServiceEnd,
        sourceReference: `m37:irc_episode:${episode.episodeId}:v${episode.episodeVersion}`,
      },
      locPeriodVersion: period.version,
      locEvidenceUpdatedAt: period.updatedAt?.toISOString() ?? null,
      locality: {
        code: evidence.localityCode,
        evidenceReference: evidence.localityEvidenceReference,
        evidenceVersion: evidence.localityEvidenceVersion,
      },
      qualityReporting: {
        applicability: evidence.qualityReportingApplicability,
        status: evidence.qualityReportingStatus,
        evidenceReference: evidence.qualityEvidenceReference,
        evidenceVersion: evidence.qualityEvidenceVersion,
      },
      billingEvidenceId: evidence.id,
      billingEvidenceVersion: evidence.version,
      rateCents: rate.rateCents,
      rateVersion: rate.version,
      payerRatePolicyId: rate.id,
      rateSourceKind: rate.sourceKind,
      rateDocumentReference: rate.sourceDocumentRef,
      pricingMethod: rate.pricingMethod,
      methodologyVersion: rate.methodologyVersion,
      quantityConversionMethod: rate.quantityConversionMethod,
      roundingMode: rate.roundingMode,
      roundingBoundary: rate.roundingBoundary,
      chargeCeilingMethod: rate.chargeCeilingMethod,
      chargeCeilingBoundary: rate.chargeCeilingBoundary,
      reimbursementEstimateCents: segment.reimbursementEstimateCents,
      baseReimbursementCents: segment.baseReimbursementCents,
      appliedCeilings: segment.appliedCeilings,
      billedChargeCentsPerUnit: evidence.billedChargeCentsPerUnit,
      billedChargeCents: chargesCents,
      chargeEvidenceReference: evidence.chargeEvidenceReference,
      chargeEvidenceVersion: evidence.chargeEvidenceVersion,
      revenueCode: "0655",
      hcpcsCode: "Q5005",
      codingProfile: "local_draft_only",
      codingEvidenceReference: evidence.codingEvidenceReference,
      codingEvidenceVersion: evidence.codingEvidenceVersion,
      sourceDocumentReference: evidence.sourceDocumentReference,
      localBillingProfile: "irc_hospital_q5005_daily_local_v1",
      serviceLocation: {
        kind: "facility",
        facilityId: episode.facilityId,
        facilityKind: "hospital",
      },
      medicaidClaimId: "pending",
      claimLineId: "pending",
      assessmentTimestamp: scope.assessedAt,
    };
    lines.push({
      snapshotSchemaVersion: 4,
      serviceFrom: segment.serviceFrom,
      serviceTo: segment.serviceTo,
      locPeriodId: period.id,
      units: segment.quantity.units,
      rateCents: rate.rateCents,
      baseReimbursementCents: segment.baseReimbursementCents,
      chargesCents,
      reimbursementEstimateCents: segment.reimbursementEstimateCents,
      appliedCeilings: segment.appliedCeilings.map((ceiling) => ({
        method: ceiling.method,
        amountCents: ceiling.amountCents,
        boundary: ceiling.boundary,
      })),
      revenueCode: "0655",
      hcpcsCode: "Q5005",
      rate,
      evidence,
      integrityFacts,
    });
    expected = nextCalendarDate(segment.serviceTo) ?? "";
  }
  if (expected !== nextCalendarDate(scope.serviceTo))
    return refuse("unresolved", "IRC_PRICING_SPAN_INCOMPLETE");
  return { status: "resolved", lines };
}

/**
 * Narrow own-IPU GIP local-draft planner. Every day must be covered by current M37 GIP criteria,
 * an activated own-unit stay and one accepted historical bed assignment. It uses the shared payer
 * pricing engine and keeps reimbursement estimates separate from provider billed charges.
 */
export function resolveGipDailyPricingPlan(input: {
  readonly scope: RHCPriceScope;
  readonly evidence: BillingEvidence;
  readonly locPeriods: readonly RHCServiceLocPeriod[];
  readonly rates: readonly PayerRatePolicyFact[];
  readonly stay: GipPricingStayFacts | null;
  readonly facilityKinds: ReadonlyMap<string, string>;
}): RHCPricePlanResult {
  const { scope, evidence, stay } = input;
  const refuse = (status: "unresolved" | "ambiguous" | "unsupported", reasonCode: string) =>
    ({ status, reasonCode }) as const;
  if (!stay) return refuse("unresolved", "GIP_OWN_IPU_STAY_OR_CRITERIA_UNAVAILABLE");
  const assessedAt = Date.parse(scope.assessedAt);
  if (
    scope.programKind !== "managed_care" ||
    scope.serviceState !== "OR" ||
    evidence.organizationId !== scope.organizationId ||
    evidence.providerEntityId !== scope.providerEntityId ||
    evidence.patientId !== scope.patientId ||
    evidence.admissionId !== scope.admissionId ||
    evidence.canonicalPayerId !== scope.canonicalPayerId ||
    evidence.programKind !== "managed_care" ||
    evidence.serviceState !== "OR" ||
    evidence.verificationStatus !== "verified" ||
    evidence.serviceCategory !== "GIP" ||
    evidence.quantityPolicy !== "m37_gip_own_unit_daily_v1" ||
    evidence.quantityEvidenceOwner !== "m37_gip_admission_criteria_and_confirmed_bed_history" ||
    evidence.billingUnit !== "daily" ||
    evidence.revenueCode !== "0656" ||
    evidence.hcpcsCode !== "Q5006" ||
    evidence.codingProfile !== "local_draft_only" ||
    evidence.admissionVersion !== scope.admissionVersion ||
    evidence.effectiveFrom > scope.serviceFrom ||
    (evidence.effectiveTo !== null && evidence.effectiveTo < scope.serviceTo) ||
    !Number.isFinite(assessedAt) ||
    evidence.verifiedAt === null ||
    evidence.verifiedAt.getTime() > assessedAt
  ) {
    return refuse("unresolved", "GIP_BILLING_EVIDENCE_SCOPE_OR_PROFILE_UNSUPPORTED");
  }
  if (
    stay.organizationId !== scope.organizationId ||
    stay.providerEntityId !== scope.providerEntityId ||
    stay.patientId !== scope.patientId ||
    stay.admissionId !== scope.admissionId ||
    stay.serviceFrom !== scope.serviceFrom ||
    stay.serviceTo !== scope.serviceTo ||
    stay.ipuAdmissionKind !== "gip" ||
    !["active", "discharged", "deceased", "closed"].includes(stay.ipuAdmissionState) ||
    stay.activatedAt.getTime() > assessedAt ||
    stay.ipuAdmissionUpdatedAt.getTime() > assessedAt ||
    stay.criteriaAttestedAt.getTime() > assessedAt ||
    !stay.serviceTimeZone.trim() ||
    stay.facilityId !== stay.unitFacilityId ||
    stay.facilityKind !== "ipu" ||
    input.facilityKinds.get(stay.facilityId) !== "ipu" ||
    !Number.isSafeInteger(stay.ipuAdmissionVersion) ||
    !Number.isSafeInteger(stay.unitVersion) ||
    !Number.isSafeInteger(stay.bedAssignmentVersion) ||
    !Number.isSafeInteger(stay.criteriaVersion) ||
    stay.dailyEvidence.length !== dayCount(scope.serviceFrom, scope.serviceTo) ||
    new Set(stay.dailyEvidence.map((item) => item.serviceDate)).size !==
      dayCount(scope.serviceFrom, scope.serviceTo)
  ) {
    return refuse("unresolved", "GIP_OWN_IPU_EVIDENCE_SCOPE_OR_VERSION_UNRESOLVED");
  }
  const periods = input.locPeriods
    .map((period) => ({
      period,
      from: isoDate(period.effectiveAt),
      to: m6LocClaimEndDate(period.endedAt, scope.inclusiveEndDate ?? null) ?? scope.serviceTo,
    }))
    .filter(({ from, to }) => from <= scope.serviceTo && to >= scope.serviceFrom);
  if (periods.length !== 1) return refuse("ambiguous", "GIP_LOC_PERIOD_AMBIGUOUS");
  const { period, from, to } = periods[0]!;
  if (
    period.levelOfCare !== "general_inpatient_care" ||
    period.id !== stay.locPeriodId ||
    from > scope.serviceFrom ||
    to < scope.serviceTo ||
    (period.facilityId !== undefined &&
      period.facilityId !== null &&
      period.facilityId !== stay.facilityId) ||
    (period.ipuBedAssignmentId !== undefined &&
      period.ipuBedAssignmentId !== null &&
      period.ipuBedAssignmentId !== stay.bedAssignmentId) ||
    !Number.isSafeInteger(period.version) ||
    !period.updatedAt ||
    period.updatedAt.getTime() > assessedAt
  ) {
    return refuse("unresolved", "GIP_LOC_AND_ACTUAL_STAY_MISMATCH");
  }
  const evidenceByDate = new Map(stay.dailyEvidence.map((item) => [item.serviceDate, item]));
  const days: Parameters<typeof assessHospicePricing>[0]["days"][number][] = [];
  for (let date = scope.serviceFrom; date <= scope.serviceTo; date = nextCalendarDate(date) ?? "") {
    const clinical = evidenceByDate.get(date);
    if (
      !clinical ||
      !clinical.stillMet ||
      clinical.verifiedAt.getTime() > assessedAt ||
      clinical.sourceVersion <= 0 ||
      !Number.isSafeInteger(clinical.sourceVersion) ||
      !clinical.sourceId.trim()
    ) {
      return refuse("unresolved", "GIP_DAILY_CLINICAL_ELIGIBILITY_UNRESOLVED");
    }
    days.push({
      serviceDate: date,
      serviceCategory: "GIP",
      unitBasis: "per_day",
      localityCode: evidence.localityCode,
      localityEvidence: {
        localityCode: evidence.localityCode,
        serviceState: "OR",
        sourceReference: evidence.localityEvidenceReference,
        version: evidence.localityEvidenceVersion,
        verifiedAt: evidence.verifiedAt.toISOString(),
        effectiveFrom: evidence.effectiveFrom,
        effectiveTo: evidence.effectiveTo,
      },
      electionDayEvidence: null,
      inpatientRespiteDayEvidence: null,
      quantity: { unitBasis: "per_day", units: 1 },
      quantityEvidence: {
        serviceDate: date,
        providerEntityId: scope.providerEntityId,
        serviceCategory: "GIP",
        unitBasis: "per_day",
        sourceReference: `m37:gip_daily:${clinical.sourceId}:v${clinical.sourceVersion}`,
        version: clinical.sourceVersion,
        verifiedAt: clinical.verifiedAt.toISOString(),
      },
      providerUsualCharge: null,
      payerContext: {
        organizationId: scope.organizationId,
        providerEntityId: scope.providerEntityId,
        canonicalPayerId: scope.canonicalPayerId,
        programKind: "managed_care",
        serviceState: "OR",
        assessedAt: scope.assessedAt,
        qualityReporting: {
          applicability: evidence.qualityReportingApplicability as "required" | "not_required",
          providerStatus: evidence.qualityReportingStatus as
            | "not_applicable"
            | "meets"
            | "does_not_meet",
          evidenceReference: evidence.qualityEvidenceReference,
          evidenceVersion: evidence.qualityEvidenceVersion,
          verifiedAt: evidence.verifiedAt.toISOString(),
          effectiveFrom: evidence.effectiveFrom,
          effectiveTo: evidence.effectiveTo,
        },
      },
    });
  }
  const rates = input.rates.filter(
    (rate) =>
      rate.serviceCategory === "GIP" &&
      rate.unitBasis === "per_day" &&
      rate.bucketFrom === null &&
      rate.bucketTo === null &&
      rate.electionDayBasis === "unqualified",
  );
  if (rates.length === 0) return refuse("unresolved", "MEDICAID_RATE_POLICY_UNRESOLVED");
  const assessment = assessHospicePricing({
    serviceFrom: scope.serviceFrom,
    serviceTo: scope.serviceTo,
    assessedAt: scope.assessedAt,
    days,
    rates,
  });
  if (assessment.status !== "fully_resolved" || !assessment.coversRequestedPeriod) {
    const reason = assessment.segments.flatMap((segment) => segment.reasonCodes)[0];
    return refuse(
      assessment.status === "ambiguous"
        ? "ambiguous"
        : assessment.status === "unsupported"
          ? "unsupported"
          : "unresolved",
      reason ?? "MEDICAID_RATE_POLICY_UNRESOLVED",
    );
  }
  const lines: RHCPriceLinePlan[] = [];
  for (const segment of assessment.segments) {
    if (
      segment.status !== "resolved" ||
      segment.serviceCategory !== "GIP" ||
      !segment.rateEvidence ||
      segment.quantity?.unitBasis !== "per_day" ||
      !Number.isSafeInteger(segment.quantity.units) ||
      segment.quantity.units <= 0 ||
      segment.baseReimbursementCents === null ||
      segment.reimbursementEstimateCents === null
    )
      return refuse("unresolved", "GIP_DAILY_RATE_SEGMENT_UNRESOLVED");
    const rate = rates.find(
      (row) => row.id === segment.rateEvidence!.id && row.version === segment.rateEvidence!.version,
    );
    if (
      !rate ||
      rate.pricingMethod !== "per_day" ||
      rate.quantityConversionMethod !== "daily_units" ||
      rate.chargeCeilingMethod !== "none" ||
      rate.chargeCeilingCents !== null
    )
      return refuse("unsupported", "GIP_DAILY_RATE_METHODOLOGY_UNQUALIFIED");
    const charges = safeProduct(evidence.billedChargeCentsPerUnit, segment.quantity.units);
    if (charges === null) return refuse("unresolved", "BILLED_CHARGE_OVERFLOW");
    const dayEvidence = stay.dailyEvidence.filter(
      (item) => item.serviceDate >= segment.serviceFrom && item.serviceDate <= segment.serviceTo,
    );
    const integrityFacts: Record<string, unknown> = {
      schemaVersion: 5,
      profile: "gip_own_ipu_q5006_daily_local_v1",
      localBillingProfile: "gip_own_ipu_q5006_daily_local_v1",
      postingAuthorized: false,
      institutionalFormatQualified: false,
      organizationId: scope.organizationId,
      providerEntityId: scope.providerEntityId,
      patientId: scope.patientId,
      admissionId: scope.admissionId,
      canonicalPayerId: scope.canonicalPayerId,
      programKind: "managed_care",
      serviceState: "OR",
      serviceCategory: "GIP",
      levelOfCare: "GIP",
      serviceFrom: segment.serviceFrom,
      serviceTo: segment.serviceTo,
      locPeriodId: period.id,
      locEffectiveFrom: from,
      locEffectiveTo: to,
      locPeriodVersion: period.version,
      locEvidenceUpdatedAt: period.updatedAt.toISOString(),
      gipStay: {
        ipuAdmissionId: stay.ipuAdmissionId,
        ipuAdmissionVersion: stay.ipuAdmissionVersion,
        ipuAdmissionKind: stay.ipuAdmissionKind,
        ipuAdmissionState: stay.ipuAdmissionState,
        activatedAt: stay.activatedAt.toISOString(),
        closedAt: stay.closedAt?.toISOString() ?? null,
        unitId: stay.unitId,
        unitVersion: stay.unitVersion,
        bedId: stay.bedId,
        bedAssignmentId: stay.bedAssignmentId,
        bedAssignmentVersion: stay.bedAssignmentVersion,
        bedAssignedAt: stay.bedAssignedAt.toISOString(),
        bedEndedAt: stay.bedEndedAt?.toISOString() ?? null,
        facilityId: stay.facilityId,
        facilityKind: stay.facilityKind,
        facilityKindSource: "m40_locked_facility_reader",
        locationId: stay.locationId,
        serviceTimeZone: stay.serviceTimeZone,
        criteriaId: stay.criteriaId,
        criteriaVersion: stay.criteriaVersion,
        criteriaKind: stay.criteriaKind,
        criteriaAttestedAt: stay.criteriaAttestedAt.toISOString(),
        dailyEvidence: dayEvidence.map((item) => ({
          serviceDate: item.serviceDate,
          sourceId: item.sourceId,
          sourceVersion: item.sourceVersion,
          verifiedAt: item.verifiedAt.toISOString(),
        })),
      },
      quantity: {
        basis: "per_day",
        units: segment.quantity.units,
        source: "M37_GIP_own_unit_days_v1",
      },
      locality: {
        code: evidence.localityCode,
        evidenceReference: evidence.localityEvidenceReference,
        evidenceVersion: evidence.localityEvidenceVersion,
      },
      qualityReporting: {
        applicability: evidence.qualityReportingApplicability,
        status: evidence.qualityReportingStatus,
        evidenceReference: evidence.qualityEvidenceReference,
        evidenceVersion: evidence.qualityEvidenceVersion,
      },
      billingEvidenceId: evidence.id,
      billingEvidenceVersion: evidence.version,
      rateCents: rate.rateCents,
      rateVersion: rate.version,
      payerRatePolicyId: rate.id,
      rateSourceKind: rate.sourceKind,
      rateDocumentReference: rate.sourceDocumentRef,
      pricingMethod: rate.pricingMethod,
      methodologyVersion: rate.methodologyVersion,
      quantityConversionMethod: rate.quantityConversionMethod,
      roundingMode: rate.roundingMode,
      roundingBoundary: rate.roundingBoundary,
      chargeCeilingMethod: rate.chargeCeilingMethod,
      chargeCeilingBoundary: rate.chargeCeilingBoundary,
      reimbursementEstimateCents: segment.reimbursementEstimateCents,
      baseReimbursementCents: segment.baseReimbursementCents,
      appliedCeilings: [],
      billedChargeCentsPerUnit: evidence.billedChargeCentsPerUnit,
      billedChargeCents: charges,
      chargeEvidenceReference: evidence.chargeEvidenceReference,
      chargeEvidenceVersion: evidence.chargeEvidenceVersion,
      revenueCode: "0656",
      hcpcsCode: "Q5006",
      codingProfile: "local_draft_only",
      codingEvidenceReference: evidence.codingEvidenceReference,
      codingEvidenceVersion: evidence.codingEvidenceVersion,
      sourceDocumentReference: evidence.sourceDocumentReference,
      serviceLocation: {
        kind: "facility",
        facilityId: stay.facilityId,
        facilityKind: "ipu",
        unitId: stay.unitId,
        locationId: stay.locationId,
        timeZone: stay.serviceTimeZone,
      },
      medicaidClaimId: "pending",
      claimLineId: "pending",
      assessmentTimestamp: scope.assessedAt,
    };
    lines.push({
      snapshotSchemaVersion: 5,
      serviceFrom: segment.serviceFrom,
      serviceTo: segment.serviceTo,
      locPeriodId: period.id,
      units: segment.quantity.units,
      rateCents: rate.rateCents,
      baseReimbursementCents: segment.baseReimbursementCents,
      chargesCents: charges,
      reimbursementEstimateCents: segment.reimbursementEstimateCents,
      appliedCeilings: [],
      revenueCode: "0656",
      hcpcsCode: "Q5006",
      rate,
      evidence,
      integrityFacts,
    });
  }
  return { status: "resolved", lines };
}

function dayCount(from: string, to: string): number {
  return (
    Math.round(
      (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
    ) + 1
  );
}

function nextCalendarDate(day: string): string | null {
  const time = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(time) ? new Date(time + 86_400_000).toISOString().slice(0, 10) : null;
}

function applySegmentCeilingAcrossEvidence(
  input: readonly RHCPriceLinePlan[],
): readonly RHCPriceLinePlan[] | null {
  const lines = [...input];
  let start = 0;
  while (start < lines.length) {
    const first = lines[start]!;
    const rate = first.rate;
    if (
      rate.chargeCeilingMethod !== "contract_maximum" ||
      rate.chargeCeilingBoundary !== "segment"
    ) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < lines.length) {
      const prior = lines[end - 1]!;
      const next = lines[end]!;
      if (
        next.locPeriodId !== first.locPeriodId ||
        next.rate.id !== rate.id ||
        next.rate.version !== rate.version ||
        next.serviceFrom !== nextCalendarDate(prior.serviceTo)
      )
        break;
      end += 1;
    }
    if (end - start > 1) {
      const group = lines.slice(start, end);
      const totalBase = group.reduce((sum, line) => sum + BigInt(line.baseReimbursementCents), 0n);
      const cap = rate.chargeCeilingCents;
      if (cap === null || cap <= 0 || totalBase <= 0n || totalBase > 2_147_483_647n) return null;
      const totalEstimate = totalBase < BigInt(cap) ? totalBase : BigInt(cap);
      // Largest-remainder allocation: every line gets the floor of its proportional share, then the cents
      // left over go one each to the lines with the largest fractional remainder (earlier line on a tie).
      // The shares sum exactly to the capped total, and because that total never exceeds the base total no
      // line is ever allocated more than its own base amount.
      const scaled = group.map((line) => totalEstimate * BigInt(line.baseReimbursementCents));
      const shares = scaled.map((value) => value / totalBase);
      let leftover = totalEstimate - shares.reduce((sum, share) => sum + share, 0n);
      const byRemainder = scaled
        .map((value, index) => ({ index, remainder: value % totalBase }))
        .sort((a, b) =>
          a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
        );
      for (const { index } of byRemainder) {
        if (leftover === 0n) break;
        shares[index] = shares[index]! + 1n;
        leftover -= 1n;
      }
      for (let index = 0; index < group.length; index += 1) {
        const line = group[index]!;
        const amount = shares[index]!;
        // Each line keeps the ceiling record the engine produced for it (same rate row, so the same
        // evidence reference/version); only the estimate is re-allocated across the group.
        lines[start + index] = {
          ...line,
          reimbursementEstimateCents: Number(amount),
          integrityFacts: { ...line.integrityFacts, reimbursementEstimateCents: Number(amount) },
        };
      }
    }
    start = end;
  }
  return lines;
}

export function rateRowAsFact(row: RateRow): PayerRatePolicyFact {
  return {
    ...row,
    programKind: row.programKind as PayerRatePolicyFact["programKind"],
    serviceCategory: row.serviceCategory as PayerRatePolicyFact["serviceCategory"],
    unitBasis: row.unitBasis as PayerRatePolicyFact["unitBasis"],
    pricingMethod: row.pricingMethod as PayerRatePolicyFact["pricingMethod"],
    quantityConversionMethod:
      row.quantityConversionMethod as PayerRatePolicyFact["quantityConversionMethod"],
    minimumDurationMethod:
      row.minimumDurationMethod as PayerRatePolicyFact["minimumDurationMethod"],
    roundingMode: row.roundingMode as PayerRatePolicyFact["roundingMode"],
    roundingBoundary: row.roundingBoundary as PayerRatePolicyFact["roundingBoundary"],
    chargeCeilingMethod: row.chargeCeilingMethod as PayerRatePolicyFact["chargeCeilingMethod"],
    chargeCeilingBoundary:
      row.chargeCeilingBoundary as PayerRatePolicyFact["chargeCeilingBoundary"],
    electionDayBasis: row.electionDayBasis as PayerRatePolicyFact["electionDayBasis"],
    qualityReportingApplicability:
      row.qualityReportingApplicability as PayerRatePolicyFact["qualityReportingApplicability"],
    qualityReportingStatus:
      row.qualityReportingStatus as PayerRatePolicyFact["qualityReportingStatus"],
    sourceKind: row.sourceKind as PayerRatePolicyFact["sourceKind"],
    verificationStatus: row.verificationStatus as PayerRatePolicyFact["verificationStatus"],
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
