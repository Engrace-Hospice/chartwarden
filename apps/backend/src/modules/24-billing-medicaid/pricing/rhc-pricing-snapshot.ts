import { createHash } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import type { MedicaidPayerProgramClassification } from "@chartwarden/mdm";
import type { PayerRatePolicyFact } from "@chartwarden/medicaid-adapters";
import { assessHospicePricing } from "@chartwarden/medicaid-adapters";
import { ChartWardenError, DegradedError } from "@chartwarden/types";
import { and, eq, lte, sql } from "drizzle-orm";
import { inclusiveDeathLocPeriodId, m6LocClaimEndDate } from "../claim-hospice-line-snapshot";
import { qualifyMedicaidProgramClassification } from "../medicaid-payer-classification";
import { resolveProgramResponsibility } from "../routes/program-responsibility";
import { resolveBillingEvidenceLineage } from "./billing-evidence-lineage";

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

export type RHCPricePlanResult =
  | { readonly status: "resolved"; readonly lines: readonly RHCPriceLinePlan[] }
  | { readonly status: "unresolved" | "ambiguous" | "unsupported"; readonly reasonCode: string };

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
 * Advisory-lock order is FIXED everywhere (preview, assembly, validation, revalidation): the rate-policy
 * scope lock first, then the billing-evidence scope lock. Two paths taking them in opposite orders can
 * deadlock (40P01). Every path reads evidence through this function and rate lineage through
 * `readMedicaidRatePolicyLineage`, so taking the rate lock here before the evidence lock makes the order
 * rate -> evidence regardless of which read a caller issues first (advisory xact locks are re-entrant).
 */
async function lockHospiceBillingEvidenceScope(tx: Tx, scope: RHCPriceScope): Promise<void> {
  await lockMedicaidRatePolicyScope(tx, scope);
  const key = `m24-hospice-evidence:${scope.organizationId}:${scope.providerEntityId}:${scope.patientId}:${scope.admissionId}:${scope.canonicalPayerId}:${scope.programKind}:${scope.serviceState}:RHC`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/**
 * Handler for a `catch` around pricing reads/verification. A ChartWardenError is a typed, expected refusal
 * (a history cap, an unbound reader): it is logged by class and code only and the caller degrades. Anything
 * else is unexpected and may have aborted the surrounding transaction, so it is logged and rethrown.
 * Never log the message: it can carry record content.
 */
export function rethrowUnlessDomainError(event: string, error: unknown): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      event,
      errorClass: error instanceof Error ? error.name : typeof error,
      errorCode: error instanceof ChartWardenError ? error.code : null,
    }),
  );
  if (!(error instanceof ChartWardenError)) throw error;
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
  const evidence = await readMedicaidHospiceBillingEvidence(input.tx, scope);
  if (evidence.status !== "verified") {
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
  const plan = resolveRhcDailyPricingPlan({
    scope,
    evidence: evidence.row,
    locPeriods: input.locPeriods,
    rates: input.rateRows.map(rateRowAsFact),
    residenceSpans,
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
      snapshot.snapshotSchemaVersion !== 1
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
  if (lineage.status === "segmentation_required") {
    // The current RHC snapshot contract has one evidence identity per assessment. The shared
    // segmented plan is a separate implementation step; never price by selecting one segment.
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_SEGMENTATION_REQUIRED" };
  }
  if (lineage.status !== "verified") return lineage;
  const row = lineage.row;
  if (scope.admissionVersion === undefined || row.admissionVersion !== scope.admissionVersion) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_ADMISSION_VERSION_STALE" };
  }
  const assessedAt = Date.parse(scope.assessedAt);
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
    row.programKind !== "managed_care" ||
    row.serviceState !== "OR" ||
    row.serviceCategory !== "RHC" ||
    row.quantityPolicy !== "active_rhc_loc_calendar_day" ||
    row.quantityEvidenceOwner !== "m6_level_of_care_period" ||
    row.billingUnit !== "daily" ||
    row.codingProfile !== "local_draft_only" ||
    row.billedChargeCentsPerUnit <= 0
  ) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_UNSUPPORTED" };
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

/** Shared price resolver used by preview, assembly and stored-snapshot revalidation. */
export function resolveRhcDailyPricingPlan(input: {
  readonly scope: RHCPriceScope;
  readonly evidence: BillingEvidence;
  readonly locPeriods: readonly RHCServiceLocPeriod[];
  readonly rates: readonly PayerRatePolicyFact[];
  readonly residenceSpans: readonly RHCServiceResidenceSpan[];
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
  if (evidence.hcpcsCode !== "Q5001") {
    return { status: "unsupported", reasonCode: "RHC_Q5001_LOCAL_PROFILE_REQUIRED" };
  }
  if (
    evidence.effectiveFrom > scope.serviceFrom ||
    (evidence.effectiveTo !== null && evidence.effectiveTo < scope.serviceTo) ||
    evidence.admissionVersion !== scope.admissionVersion
  ) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_STALE_OR_OUT_OF_RANGE" };
  }
  const residence = resolveRhcHomeResidence(
    input.residenceSpans,
    scope.serviceFrom,
    scope.serviceTo,
  );
  if (residence.status !== "resolved") {
    return { status: residence.status, reasonCode: residence.reasonCode };
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
        electionDayEvidence: null,
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
      const facts: Record<string, unknown> = {
        schemaVersion: 1,
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
        serviceLocation: {
          patientAddressId: residence.span.addressId,
          kind: residence.span.kind,
          facilityId: residence.span.facilityId,
          effectiveFrom: residence.span.effectiveFrom,
          effectiveTo: residence.span.effectiveTo,
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
        revenueCode: evidence.revenueCode,
        hcpcsCode: evidence.hcpcsCode,
        codingProfile: evidence.codingProfile,
        codingEvidenceReference: evidence.codingEvidenceReference,
        codingEvidenceVersion: evidence.codingEvidenceVersion,
      };
      lines.push({
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
