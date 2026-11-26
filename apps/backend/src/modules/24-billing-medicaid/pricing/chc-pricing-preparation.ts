import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import type { MedicaidChcPricingPreparationSnapshot } from "@chartwarden/db/schema";
import {
  type HospicePricingAssessment,
  assessHospicePricing,
  evaluateMedicaidPayerResponsibility,
} from "@chartwarden/medicaid-adapters";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  DegradedError,
  type PatientAddressReader,
  type SignedEncountersReader,
} from "@chartwarden/types";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  admissionServiceRangeIssue,
  patientLifecycleServiceRangeIssue,
} from "../claim-range-guards";
import { qualifyMedicaidProgramClassification } from "../medicaid-payer-classification";
import type { M24Actor } from "../routes/actor";
import {
  type ProgramAssignmentCandidate,
  resolveProgramResponsibility,
} from "../routes/program-responsibility";
import type {
  AdmissionCadenceReaderPort,
  CanonicalPayerIdentityReader,
  CoverageResolverPort,
} from "../routes/write-service-drizzle";
import { readMedicaidRatePolicyLineage } from "../routes/write-service-drizzle";
import { qualifyChcClinicalQuantity } from "./chc-clinical-qualification";
import {
  type SignedChcEncounterFact,
  chcLocalServiceDayBounds,
  resolveSignedChcClinicalQuantity,
} from "./chc-clinical-quantity";
import {
  canonicalPricingSnapshotJson,
  isTransactionFatalError,
  lockHospiceBillingEvidenceScope,
  logPricingRefusal,
  pricingSnapshotFingerprint,
  rateRowAsFact,
  readMedicaidChcBillingEvidence,
} from "./rhc-pricing-snapshot";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type Snapshot = MedicaidChcPricingPreparationSnapshot;

/** The M6 reader returns the owner-side facts on the same transaction that locks the admission. */
export interface ChcAdmissionReader
  extends Pick<AdmissionCadenceReaderPort, "cadenceSnapshotInTransaction"> {
  periodsForAdmissionInTransaction(
    transaction: unknown,
    organizationId: string,
    admissionId: string,
  ): Promise<
    readonly {
      id: string;
      version?: number;
      levelOfCare: string;
      status: string;
      reason: string | null;
      assignedBy: string | null;
      effectiveAt: Date;
      endedAt: Date | null;
    }[]
  >;
}

export interface ChcPricingPreparationInput {
  readonly patientId: string;
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly serviceDate: string;
}

export type ChcPreparationVerification =
  | {
      readonly status: "current";
      readonly preparationId: string;
      readonly version: number;
      readonly fingerprint: string;
    }
  | {
      readonly status: "stale" | "unresolved" | "ambiguous" | "unsupported";
      readonly reasonCode: string;
    };

export interface ChcPreparationView {
  readonly id: string;
  readonly preparationId: string;
  readonly version: number;
  readonly serviceDate: string;
  readonly observedMinutes: number | null;
  readonly qualifiedMinutes: number | null;
  readonly reimbursementHours: number | null;
  readonly rateCentsPerHour: number | null;
  readonly estimatedReimbursementCents: number | null;
  readonly billedChargeCents: number | null;
  readonly institutionalUnits: "unqualified";
  readonly institutionalFormatQualified: false;
  readonly verification: ChcPreparationVerification;
}

export interface ChcPricingPreparationDeps {
  readonly db: DbClient;
  readonly coverage: CoverageResolverPort;
  readonly admissions: ChcAdmissionReader;
  readonly encounters: Pick<SignedEncountersReader, "chcClinicalIntervalsInTransaction">;
  readonly residences: Pick<PatientAddressReader, "residencesBetweenInTransaction">;
  readonly canonicalPayer: CanonicalPayerIdentityReader;
  readonly now?: () => Date;
}

/**
 * One background pass verifies at most this many service days (the newest), so it stays bounded. Each
 * verification runs in a savepoint that locks the admission row, so the count also stays well under the
 * 64 subtransactions a transaction can hold before other sessions' snapshots slow down.
 */
const MAX_PREPARATIONS_PER_REVALIDATION = 50;

/** What a revalidation of one patient will lock: its admission, and its payer's rate-policy scope. */
export interface ChcRevalidationScope {
  /** The preparation row this scope was read from; the verification covers exactly these rows. */
  readonly preparationRecordId: string;
  readonly admissionId: string;
  readonly rateScope: {
    readonly organizationId: string;
    readonly providerEntityId: string;
    readonly canonicalPayerId: string;
    readonly serviceState: string;
  };
}

function fail(
  code: string,
  message = `Current authoritative facts do not qualify this local CHC preparation (${code}).`,
): never {
  throw new ChartWardenError(code, message, 409);
}

function isDate(value: string): boolean {
  // Year 0000 round-trips through JS but is not a PostgreSQL date, so it would fail as a database error.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01") return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function plusDay(date: string, delta: number): string {
  const at = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(at + delta * 86_400_000).toISOString().slice(0, 10);
}

function canonicalMaterial(snapshot: Record<string, unknown>): string {
  const { integrityFingerprint: _fingerprint, assessedAt: _assessedAt, ...material } = snapshot;
  return canonicalPricingSnapshotJson(material);
}

function fingerprintFor(snapshot: Record<string, unknown>): string {
  return pricingSnapshotFingerprint(JSON.parse(canonicalMaterial(snapshot)) as unknown);
}

function storedSnapshotMatches(
  snapshot: Record<string, unknown>,
  storedFingerprint: string,
  currentFingerprint: string,
  currentSnapshot: Record<string, unknown>,
): boolean {
  try {
    return (
      storedFingerprint === currentFingerprint &&
      snapshot.integrityFingerprint === storedFingerprint &&
      fingerprintFor(snapshot) === storedFingerprint &&
      canonicalMaterial(snapshot) === canonicalMaterial(currentSnapshot)
    );
  } catch {
    return false;
  }
}

function previewFrom(
  row: typeof schema.medicaidChcPricingPreparation.$inferSelect,
  verification: ChcPreparationVerification,
): ChcPreparationView {
  const snapshot = row.snapshot;
  const trusted = verification.status === "current";
  return {
    id: row.id,
    preparationId: row.preparationId,
    version: row.version,
    serviceDate: row.serviceDate,
    observedMinutes: trusted ? snapshot.observedMinutes : null,
    qualifiedMinutes: trusted ? snapshot.qualifiedMinutes : null,
    reimbursementHours: trusted ? snapshot.qualifiedMinutes / 60 : null,
    rateCentsPerHour: trusted ? snapshot.rateCentsPerHour : null,
    estimatedReimbursementCents: trusted ? snapshot.estimatedReimbursementCents : null,
    billedChargeCents: trusted ? snapshot.billedChargeCents : null,
    institutionalUnits: "unqualified",
    institutionalFormatQualified: false,
    verification,
  };
}

/** Production M24 service for a single-day, local-only home-CHC price preparation. */
export function createChcPricingPreparationService(deps: ChcPricingPreparationDeps) {
  const now = deps.now ?? (() => new Date());

  async function resolveCurrent(
    tx: Tx,
    actor: M24Actor,
    input: ChcPricingPreparationInput,
    preparationId: string,
    preparationVersion: number,
    expectedCanonicalPayerId?: string,
  ): Promise<Snapshot> {
    if (!isDate(input.serviceDate)) fail("CHC_SERVICE_DATE_INVALID");
    if (!actor.providerEntityIds?.includes(input.providerEntityId))
      fail("CHC_PROVIDER_SCOPE_DENIED");
    const admission = await deps.admissions.cadenceSnapshotInTransaction(
      tx,
      actor.organizationId,
      input.admissionId,
    );
    if (
      !admission ||
      admission.patientId !== input.patientId ||
      admission.providerEntityId !== input.providerEntityId
    ) {
      fail("CHC_ADMISSION_IDENTITY_MISMATCH");
    }
    // The same stay-end rules claim assembly applies: a discharge, revocation, transfer or death on or before
    // the service day, or a pending discharge, means the day is not priced. A discharged or closed admission is
    // judged by its stay-end facts (its days before the end stay billable), not refused for its status.
    const admissionIssue = admissionServiceRangeIssue(admission, input.serviceDate);
    if (admissionIssue) fail(admissionIssue.code);
    if (!["active", "discharged", "bereavement", "closed"].includes(admission.status))
      fail("CHC_ADMISSION_NOT_ACTIVE");

    const coverage = await deps.coverage.claimCoverageSnapshotInTransaction(tx, {
      organizationId: actor.organizationId,
      patientId: input.patientId,
      from: input.serviceDate,
      to: input.serviceDate,
    });
    const lifecycleIssue = patientLifecycleServiceRangeIssue(
      coverage.patientLifecycle,
      input.serviceDate,
    );
    if (lifecycleIssue) fail(lifecycleIssue.code);
    if (coverage.medicaid.status !== "uniform" || coverage.primary.status !== "uniform") {
      fail("MEDICAID_COVERAGE_NOT_UNIFORM");
    }
    const medicaid = coverage.medicaid.coverage;
    const primary = coverage.primary.coverage;
    const payerDecision = evaluateMedicaidPayerResponsibility({
      claimKind: "hospice_only",
      medicaidCoverageId: medicaid.id,
      medicaidRank: medicaid.rank,
      primaryCoverageId: primary.id,
      primaryCoverageKind: primary.coverageKind,
      primaryRank: primary.rank,
    });
    if (!payerDecision.allowed || medicaid.coverageKind !== "medicaid")
      fail("MEDICAID_PRIMARY_COVERAGE_REQUIRED");

    const assignmentRows = await tx
      .select({
        id: schema.medicaidProgramAssignment.id,
        version: schema.medicaidProgramAssignment.version,
        programKind: schema.medicaidProgramAssignment.programKind,
        canonicalPayerId: schema.medicaidProgramAssignment.canonicalPayerId,
        status: schema.medicaidProgramAssignment.status,
        effectiveFrom: schema.medicaidProgramAssignment.effectiveFrom,
        effectiveTo: schema.medicaidProgramAssignment.effectiveTo,
        sourceKind: schema.medicaidProgramAssignment.sourceKind,
        verificationSource: schema.medicaidProgramAssignment.verificationSource,
        evidenceReference: schema.medicaidProgramAssignment.evidenceReference,
        verifiedAt: schema.medicaidProgramAssignment.verifiedAt,
      })
      .from(schema.medicaidProgramAssignment)
      .where(
        and(
          eq(schema.medicaidProgramAssignment.organizationId, actor.organizationId),
          eq(schema.medicaidProgramAssignment.providerEntityId, input.providerEntityId),
          eq(schema.medicaidProgramAssignment.patientId, input.patientId),
          eq(schema.medicaidProgramAssignment.patientPayerId, medicaid.id),
          eq(schema.medicaidProgramAssignment.admissionId, input.admissionId),
          lte(schema.medicaidProgramAssignment.effectiveFrom, input.serviceDate),
        ),
      );
    const program = resolveProgramResponsibility(
      assignmentRows as ProgramAssignmentCandidate[],
      input.serviceDate,
      input.serviceDate,
    );
    if (
      program.status !== "verified" ||
      program.programKind !== "managed_care" ||
      !program.canonicalPayerId ||
      program.assignmentIds.length !== 1
    ) {
      fail("MEDICAID_PROGRAM_RESPONSIBILITY_UNRESOLVED");
    }
    const programAssignment = assignmentRows.find((row) => row.id === program.assignmentIds[0]);
    if (
      !programAssignment ||
      !Number.isSafeInteger(programAssignment.version) ||
      programAssignment.version < 1 ||
      !programAssignment.sourceKind ||
      !programAssignment.verificationSource ||
      !programAssignment.evidenceReference ||
      !programAssignment.verifiedAt
    ) {
      fail("MEDICAID_PROGRAM_ASSIGNMENT_PROVENANCE_UNRESOLVED");
    }
    if (medicaid.payerId !== program.canonicalPayerId) fail("MEDICAID_COVERAGE_PAYER_MISMATCH");
    // A stored preparation was priced for one payer: if the program now names another, it is stale, and this says
    // so BEFORE the rate-policy lock of a payer the caller never locked (the revalidation job locks the stored
    // payer's scope, in its sorted pass).
    if (expectedCanonicalPayerId && program.canonicalPayerId !== expectedCanonicalPayerId)
      fail("CHC_PAYER_CHANGED");
    const canonical = await deps.canonicalPayer.resolvePayer(
      actor.organizationId,
      program.canonicalPayerId,
    );
    if (
      !canonical ||
      canonical.status !== "active" ||
      canonical.kind !== "medicaid" ||
      canonical.stateCode !== "OR"
    ) {
      fail("MEDICAID_CANONICAL_PAYER_UNQUALIFIED");
    }
    const classifications = deps.canonicalPayer.medicaidProgramClassifications
      ? await deps.canonicalPayer.medicaidProgramClassifications(
          actor.organizationId,
          program.canonicalPayerId,
          "OR",
          input.serviceDate,
          input.serviceDate,
        )
      : [];
    const payerClassification = qualifyMedicaidProgramClassification(
      classifications,
      "managed_care",
      program.canonicalPayerId,
      "OR",
      input.serviceDate,
      input.serviceDate,
    );
    if (!payerClassification.qualified) fail(payerClassification.reasonCode);
    if (
      !payerClassification.classification.sourceReference ||
      !payerClassification.classification.verifiedAt
    ) {
      fail("MEDICAID_PROGRAM_CLASSIFICATION_PROVENANCE_UNRESOLVED");
    }

    // Lock order: the admission row (above), then the rate-policy and billing-evidence advisory locks, and only
    // then the clock: a rate, evidence or encounter correction that commits while this waits is part of the
    // instant assessed, never hidden by a stamp taken before the wait. (The M5 coverage, program and payer
    // facts above are read before the payer is known, so they are not covered by this lock; they are the
    // inputs to it.)
    await lockHospiceBillingEvidenceScope(
      tx,
      {
        organizationId: actor.organizationId,
        providerEntityId: input.providerEntityId,
        patientId: input.patientId,
        admissionId: input.admissionId,
        canonicalPayerId: program.canonicalPayerId,
        programKind: "managed_care",
        serviceState: "OR",
      },
      "CHC",
    );
    const assessedAt = now().toISOString();
    if (programAssignment.verifiedAt.getTime() > Date.parse(assessedAt))
      fail("MEDICAID_PROGRAM_ASSIGNMENT_PROVENANCE_UNRESOLVED");
    if (Date.parse(payerClassification.classification.verifiedAt) > Date.parse(assessedAt))
      fail("MEDICAID_PROGRAM_CLASSIFICATION_PROVENANCE_UNRESOLVED");

    const locRows = await deps.admissions.periodsForAdmissionInTransaction(
      tx,
      actor.organizationId,
      input.admissionId,
    );

    if (!deps.residences.residencesBetweenInTransaction)
      throw new DegradedError("m24-chc-preparation", "the M5 residence reader is not bound");
    const residenceSpans = await deps.residences.residencesBetweenInTransaction(
      tx,
      actor.organizationId,
      input.patientId,
      input.serviceDate,
      input.serviceDate,
    );
    const coveringResidence = residenceSpans.filter(
      (span) =>
        span.effectiveFrom <= input.serviceDate &&
        (span.effectiveTo === null || span.effectiveTo >= input.serviceDate),
    );
    if (coveringResidence.length !== 1)
      fail(
        coveringResidence.length ? "CHC_HOME_RESIDENCE_AMBIGUOUS" : "CHC_HOME_RESIDENCE_MISSING",
      );
    const residence = coveringResidence[0]!;
    if (residence.kind !== "home" || residence.facilityId !== null)
      fail("CHC_HOME_RESIDENCE_REQUIRED");

    const intervalReader = deps.encounters.chcClinicalIntervalsInTransaction;
    if (!intervalReader)
      throw new DegradedError("m24-chc-preparation", "the M8 interval reader is not bound");
    const sourceIntervals = await intervalReader(tx, {
      organizationId: actor.organizationId,
      providerEntityId: input.providerEntityId,
      patientId: input.patientId,
      admissionId: input.admissionId,
      serviceDate: input.serviceDate,
    });
    const nearDay = sourceIntervals.filter(
      (row) =>
        row.serviceDate >= plusDay(input.serviceDate, -1) &&
        row.serviceDate <= plusDay(input.serviceDate, 1),
    );
    // M8's serviceDate labels the local date on which an interval starts. A legitimate interval can
    // begin on the preceding date and continue into the requested day, so source timezone selection
    // must include interval facts that could overlap the local day, not only starts on that day.
    const requestedUtcMidnight = Date.parse(`${input.serviceDate}T00:00:00.000Z`);
    const broadStart = requestedUtcMidnight - 14 * 60 * 60_000;
    const broadEnd = requestedUtcMidnight + 24 * 60 * 60_000 + 12 * 60 * 60_000;
    const locationDayRows = nearDay.filter((row) => {
      if (row.serviceDate === input.serviceDate) return true;
      if (!row.startedAt || !row.endedAt) return false;
      const start = Date.parse(row.startedAt);
      const end = Date.parse(row.endedAt);
      return Number.isFinite(start) && Number.isFinite(end) && start < broadEnd && end > broadStart;
    });
    const timeZones = new Set(
      locationDayRows.map((row) => row.serviceTimeZone).filter((value): value is string => !!value),
    );
    if (
      locationDayRows.length === 0 ||
      locationDayRows.some((row) => !row.serviceTimeZone) ||
      timeZones.size !== 1
    )
      fail("CHC_SERVICE_TIMEZONE_UNRESOLVED");
    const serviceTimeZone = [...timeZones][0]!;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: serviceTimeZone });
    } catch {
      fail("CHC_SERVICE_TIMEZONE_INVALID");
    }
    const localDay = chcLocalServiceDayBounds(input.serviceDate, serviceTimeZone);
    if (!localDay) fail("CHC_SERVICE_TIMEZONE_INVALID");
    const localStart = Date.parse(localDay.start);
    const localEnd = Date.parse(localDay.end);
    const relevantIntervals = nearDay.filter((row) => {
      if (row.serviceDate === input.serviceDate) return true;
      if (!row.startedAt || !row.endedAt) return row.serviceDate === plusDay(input.serviceDate, -1);
      const start = Date.parse(row.startedAt);
      const end = Date.parse(row.endedAt);
      return Number.isFinite(start) && Number.isFinite(end) && start < localEnd && end > localStart;
    });
    if (
      relevantIntervals.some(
        (row) =>
          row.locationId === null ||
          row.locationProviderEntityId !== input.providerEntityId ||
          row.locationState !== "OR" ||
          row.serviceTimeZone !== serviceTimeZone,
      )
    ) {
      fail("CHC_SERVICE_LOCATION_SCOPE_INVALID");
    }
    const encounterFacts: SignedChcEncounterFact[] = relevantIntervals.map((row) => ({
      organizationId: row.organizationId,
      providerEntityId: row.providerEntityId,
      patientId: row.patientId,
      admissionId: row.admissionId,
      encounterId: row.encounterId,
      serviceDate: row.serviceDate,
      status: row.status,
      signedAt: row.signedAt ?? "",
      cosignedAt: row.cosignedAt,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      timeSource: row.timeSource,
      sourceVersion: row.sourceVersion,
      locationId: row.locationId,
      discipline: row.discipline,
      voidedAt: row.voidedAt,
    }));
    const localStartInstant = Date.parse(localDay.start);
    const localEndInstant = Date.parse(localDay.end);
    const dayStart = localStartInstant;
    const dayEnd = localEndInstant;
    const locCandidates = locRows.filter(
      (period) =>
        period.effectiveAt.getTime() <= dayStart &&
        (period.endedAt === null || period.endedAt.getTime() >= dayEnd),
    );
    if (locCandidates.length !== 1)
      fail(locCandidates.length ? "CHC_LOC_AMBIGUOUS" : "CHC_LOC_MISSING");
    const loc = locCandidates[0]!;
    if (
      loc.levelOfCare !== "continuous_home_care" ||
      (loc.status !== "active" && loc.status !== "ended") ||
      loc.reason !== "symptom_crisis" ||
      !loc.assignedBy
    ) {
      fail("CHC_CLINICAL_INDICATION_UNQUALIFIED");
    }
    const locVersion = loc.version;
    if (!Number.isSafeInteger(locVersion) || locVersion! < 0) fail("CHC_LOC_VERSION_UNAVAILABLE");
    const observation = resolveSignedChcClinicalQuantity({
      organizationId: actor.organizationId,
      providerEntityId: input.providerEntityId,
      patientId: input.patientId,
      admissionId: input.admissionId,
      serviceFrom: input.serviceDate,
      serviceTo: input.serviceDate,
      serviceTimeZone,
      assessedAt,
      chcServiceDates: [input.serviceDate],
      encounters: encounterFacts,
    });
    const scope = {
      organizationId: actor.organizationId,
      providerEntityId: input.providerEntityId,
      patientId: input.patientId,
      admissionId: input.admissionId,
      admissionVersion: admission.version,
      canonicalPayerId: program.canonicalPayerId,
      programKind: "managed_care" as const,
      serviceState: "OR",
      serviceFrom: input.serviceDate,
      serviceTo: input.serviceDate,
      assessedAt,
    };
    const billing = await readMedicaidChcBillingEvidence(tx, scope);
    if (billing.status !== "verified") fail(billing.reasonCode);
    const evidence = billing.row;
    const method = {
      method: evidence.quantityPolicy,
      sourceReference: evidence.sourceDocumentReference,
      version: evidence.version,
      verifiedAt: evidence.verifiedAt?.toISOString() ?? "",
      verificationStatus: evidence.verificationStatus,
      minimumClinicalMinutes: 1,
      maximumClinicalMinutes: 1440,
    };
    const rateRows = await readMedicaidRatePolicyLineage(tx, {
      organizationId: actor.organizationId,
      providerEntityId: input.providerEntityId,
      canonicalPayerId: program.canonicalPayerId,
      programKind: "managed_care",
      serviceState: "OR",
      serviceTo: input.serviceDate,
      assessedAt,
    });
    const rateFacts = rateRows.map(rateRowAsFact);
    const ratesWithChcMax = rateFacts.filter(
      (rate) =>
        rate.serviceCategory === "CHC" &&
        rate.unitBasis === "per_hour" &&
        rate.maximumClinicalMinutes != null,
    );
    // The lineage keeps superseded predecessors; only a head (a row no later row names) can be selected.
    const supersededRateIds = new Set(
      rateFacts.flatMap((rate) =>
        rate.verificationStatus !== "rejected" && rate.supersedesId ? [rate.supersedesId] : [],
      ),
    );
    const activeCandidate = ratesWithChcMax.find(
      (rate) =>
        !supersededRateIds.has(rate.id) &&
        rate.verificationStatus === "verified" &&
        rate.effectiveFrom <= input.serviceDate &&
        (rate.effectiveTo === null || rate.effectiveTo >= input.serviceDate) &&
        rate.localityCode === evidence.localityCode &&
        rate.qualityReportingApplicability === evidence.qualityReportingApplicability &&
        rate.qualityReportingStatus === evidence.qualityReportingStatus &&
        rate.canonicalPayerId === program.canonicalPayerId,
    );
    if (!activeCandidate) fail("MEDICAID_RATE_POLICY_UNRESOLVED");
    const qualificationMethod = {
      ...method,
      minimumClinicalMinutes: activeCandidate.minimumClinicalMinutes ?? 1,
      maximumClinicalMinutes: activeCandidate.maximumClinicalMinutes!,
    };
    const clinical = qualifyChcClinicalQuantity({
      observation,
      locPeriods: locRows.map((row) => ({
        id: row.id,
        version: row.version ?? 0,
        levelOfCare: row.levelOfCare,
        status: row.status,
        effectiveAt: row.effectiveAt,
        endedAt: row.endedAt,
        reason: row.reason,
        assignedBy: row.assignedBy,
      })),
      method: qualificationMethod,
      assessedAt,
    });
    if (clinical.status !== "qualified") fail(clinical.reasonCode);
    const quantity = clinical.days[0];
    const observed = observation.status === "observed" ? observation.days[0] : undefined;
    if (!quantity || !observed || quantity.qualifiedMinutes % 60 !== 0)
      fail("CHC_LOCAL_HOURLY_CHARGE_QUANTITY_UNSUPPORTED");
    const quantityEvidence = {
      serviceDate: input.serviceDate,
      providerEntityId: input.providerEntityId,
      serviceCategory: "CHC" as const,
      unitBasis: "per_hour" as const,
      sourceReference: evidence.sourceDocumentReference,
      version: evidence.version,
      verifiedAt: evidence.verifiedAt!.toISOString(),
    };
    const billedHours = quantity.qualifiedMinutes / 60;
    const billedCharge = BigInt(evidence.billedChargeCentsPerUnit) * BigInt(billedHours);
    if (billedCharge <= 0n || billedCharge > 2_147_483_647n) fail("CHC_BILLED_CHARGE_OUT_OF_RANGE");
    const pricing: HospicePricingAssessment = assessHospicePricing({
      serviceFrom: input.serviceDate,
      serviceTo: input.serviceDate,
      assessedAt,
      rates: rateFacts,
      days: [
        {
          serviceDate: input.serviceDate,
          serviceCategory: "CHC",
          unitBasis: "per_hour",
          localityCode: evidence.localityCode,
          localityEvidence: {
            localityCode: evidence.localityCode,
            serviceState: "OR",
            sourceReference: evidence.localityEvidenceReference,
            version: evidence.localityEvidenceVersion,
            verifiedAt: evidence.verifiedAt!.toISOString(),
            effectiveFrom: evidence.effectiveFrom,
            effectiveTo: evidence.effectiveTo,
          },
          electionDayEvidence: null,
          inpatientRespiteDayEvidence: null,
          quantity: { unitBasis: "per_hour", clinicalMinutes: quantity.qualifiedMinutes },
          quantityEvidence,
          providerUsualCharge: {
            amountCents: Number(billedCharge),
            serviceDate: input.serviceDate,
            providerEntityId: input.providerEntityId,
            serviceCategory: "CHC",
            sourceReference: evidence.chargeEvidenceReference,
            version: evidence.chargeEvidenceVersion,
            verifiedAt: evidence.verifiedAt!.toISOString(),
          },
          payerContext: {
            organizationId: actor.organizationId,
            providerEntityId: input.providerEntityId,
            canonicalPayerId: program.canonicalPayerId,
            programKind: "managed_care",
            serviceState: "OR",
            assessedAt,
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
        },
      ],
    });
    if (
      pricing.status !== "fully_resolved" ||
      pricing.segments.length !== 1 ||
      pricing.reimbursementEstimateTotalCents === null
    ) {
      fail(pricing.segments[0]?.reasonCodes[0] ?? "MEDICAID_RATE_POLICY_UNRESOLVED");
    }
    if (pricing.reimbursementEstimateTotalCents > 2_147_483_647)
      fail("CHC_REIMBURSEMENT_OUT_OF_RANGE");
    const priceSegment = pricing.segments[0]!;
    const selectedRate = priceSegment.rateEvidence;
    if (!selectedRate || selectedRate.id !== activeCandidate.id || !selectedRate.verifiedAt)
      fail("MEDICAID_RATE_POLICY_IDENTITY_CONFLICT");
    const locFact = quantity.eligibilityEvidence;
    const sourceEncounters = quantity.sourceEncounters.map((source) => {
      const row = sourceIntervals.find((candidate) => candidate.encounterId === source.encounterId);
      if (
        !row?.startedAt ||
        !row.endedAt ||
        !row.signedAt ||
        (row.status === "cosigned" && !row.cosignedAt) ||
        row.discipline !== "rn" ||
        !row.timeSource
      )
        fail("CHC_SOURCE_EVIDENCE_CHANGED");
      return {
        encounterId: source.encounterId,
        version: source.sourceVersion,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        signedAt: row.signedAt,
        cosignedAt: row.cosignedAt,
        timeSource: row.timeSource,
        discipline: "rn" as const,
        locationId: row.locationId!,
      };
    });
    if (
      selectedRate.quantityConversionMethod !== "hourly_prorated_minutes" &&
      selectedRate.quantityConversionMethod !== "hourly_each_hour_or_part"
    )
      fail("CHC_RATE_CONVERSION_METHOD_UNSUPPORTED");
    const base = {
      schemaVersion: 1 as const,
      profile: "home_chc_hourly_local_v1" as const,
      preparationId,
      preparationVersion,
      organizationId: actor.organizationId,
      providerEntityId: input.providerEntityId,
      patientId: input.patientId,
      admissionId: input.admissionId,
      admissionVersion: admission.version ?? 0,
      serviceDate: input.serviceDate,
      serviceTimeZone,
      canonicalPayerId: program.canonicalPayerId,
      programKind: "managed_care" as const,
      serviceState: "OR" as const,
      programAssignment: {
        id: programAssignment.id,
        version: programAssignment.version,
        sourceKind: programAssignment.sourceKind,
        verificationSource: programAssignment.verificationSource,
        evidenceReference: programAssignment.evidenceReference,
        verifiedAt: programAssignment.verifiedAt.toISOString(),
        effectiveFrom: programAssignment.effectiveFrom,
        effectiveTo: programAssignment.effectiveTo,
      },
      payerProgramClassification: {
        id: payerClassification.classification.id,
        classification: "medicaid_cco" as const,
        sourceKind: payerClassification.classification.sourceKind,
        sourceReference: payerClassification.classification.sourceReference,
        verifiedAt: payerClassification.classification.verifiedAt,
        effectiveFrom: payerClassification.classification.effectiveFrom,
        effectiveTo: payerClassification.classification.effectiveTo,
      },
      residenceAddressId: residence.addressId,
      residenceKind: "home" as const,
      residenceEffectiveFrom: residence.effectiveFrom,
      residenceEffectiveTo: residence.effectiveTo,
      locPeriodId: locFact.locPeriodId,
      locPeriodVersion: locFact.locPeriodVersion,
      locReason: "symptom_crisis" as const,
      clinicalMethod: evidence.quantityPolicy,
      clinicalMethodReference: evidence.sourceDocumentReference,
      clinicalMethodVersion: evidence.version,
      encounterSources: sourceEncounters,
      observedMinutes: observed.actualClinicalMinutes,
      qualifiedMinutes: quantity.qualifiedMinutes,
      quantityConversionMethod: selectedRate.quantityConversionMethod,
      minimumClinicalMinutes: selectedRate.minimumClinicalMinutes,
      maximumClinicalMinutes:
        selectedRate.maximumClinicalMinutes ?? qualificationMethod.maximumClinicalMinutes,
      ratePolicyId: selectedRate.id,
      ratePolicyVersion: selectedRate.version,
      rateSourceReference: selectedRate.sourceDocumentRef,
      rateCentsPerHour: selectedRate.rateCents,
      billingEvidenceId: evidence.id,
      billingEvidenceVersion: evidence.version,
      codingProfile: "local_draft_only" as const,
      codingEvidenceReference: evidence.codingEvidenceReference,
      codingEvidenceVersion: evidence.codingEvidenceVersion,
      localityCode: evidence.localityCode,
      localityEvidenceReference: evidence.localityEvidenceReference,
      localityEvidenceVersion: evidence.localityEvidenceVersion,
      qualityApplicability: evidence.qualityReportingApplicability,
      qualityStatus: evidence.qualityReportingStatus,
      qualityEvidenceReference: evidence.qualityEvidenceReference,
      qualityEvidenceVersion: evidence.qualityEvidenceVersion,
      billedChargeEvidenceReference: evidence.chargeEvidenceReference,
      billedChargeEvidenceVersion: evidence.chargeEvidenceVersion,
      billedChargeCentsPerHour: evidence.billedChargeCentsPerUnit,
      estimatedReimbursementCents: pricing.reimbursementEstimateTotalCents,
      baseReimbursementCents: priceSegment.baseReimbursementCents!,
      billedChargeCents: Number(billedCharge),
      reimbursementRoundingMode: selectedRate.roundingMode,
      reimbursementRoundingBoundary: selectedRate.roundingBoundary,
      appliedCeilings: priceSegment.appliedCeilings.map((ceiling) => ({
        method: ceiling.method,
        amountCents: ceiling.amountCents,
        boundary: ceiling.boundary,
      })),
      institutionalUnits: "unqualified" as const,
      institutionalFormatQualified: false as const,
      postingAuthorized: false as const,
      assessedAt,
    };
    const integrityFingerprint = fingerprintFor(base);
    return { ...base, integrityFingerprint };
  }

  async function verifyInTransaction(
    tx: Tx,
    actor: M24Actor,
    row: typeof schema.medicaidChcPricingPreparation.$inferSelect,
  ): Promise<ChcPreparationVerification> {
    let current: Snapshot;
    try {
      // One savepoint per verification: a database error rolls back only this read, never the caller's
      // transaction (the revalidation job verifies many preparations in one).
      current = await tx.transaction((savepoint) =>
        resolveCurrent(
          savepoint,
          actor,
          {
            patientId: row.patientId,
            admissionId: row.admissionId,
            providerEntityId: row.providerEntityId,
            serviceDate: row.serviceDate,
          },
          row.preparationId,
          row.version,
          row.snapshot.canonicalPayerId,
        ),
      );
    } catch (error) {
      logPricingRefusal("m24.chc_preparation.current_evidence_unavailable", error);
      // A connection, deadlock or serialization failure is retried by the caller; a typed 5xx is a defect.
      if (isTransactionFatalError(error)) throw error;
      if (error instanceof ChartWardenError) {
        if (error.statusCode >= 500 && error.statusCode !== 503) throw error;
        return {
          status: "stale",
          reasonCode: error.statusCode === 503 ? "CHC_CURRENT_EVIDENCE_UNAVAILABLE" : error.code,
        };
      }
      return { status: "stale", reasonCode: "CHC_CURRENT_EVIDENCE_UNAVAILABLE" };
    }
    if (
      canonicalMaterial(current as unknown as Record<string, unknown>) !==
      canonicalMaterial(row.snapshot as unknown as Record<string, unknown>)
    ) {
      return { status: "stale", reasonCode: "CHC_PRICING_SNAPSHOT_STALE" };
    }
    const fingerprint = fingerprintFor(row.snapshot as unknown as Record<string, unknown>);
    if (fingerprint !== row.fingerprint || row.snapshot.integrityFingerprint !== row.fingerprint) {
      return { status: "stale", reasonCode: "CHC_PRICING_SNAPSHOT_INTEGRITY_MISMATCH" };
    }
    return {
      status: "current",
      preparationId: row.preparationId,
      version: row.version,
      fingerprint,
    };
  }

  async function prepare(
    actor: M24Actor,
    requested: ChcPricingPreparationInput,
  ): Promise<ChcPreparationView> {
    // The stored snapshot, the lock key and the database identity checks all compare ids as lowercase text, and a
    // uuid is valid in either case: normalize here so an uppercase id is the same preparation, not a refusal.
    const input: ChcPricingPreparationInput = {
      ...requested,
      patientId: requested.patientId.toLowerCase(),
      admissionId: requested.admissionId.toLowerCase(),
      providerEntityId: requested.providerEntityId.toLowerCase(),
    };
    // Refuse a malformed or impossible date before any query casts it (a database cast error is a 500).
    if (!isDate(input.serviceDate)) fail("CHC_SERVICE_DATE_INVALID");
    // created_by_membership_id is a membership; a user id is never written in its place.
    if (!actor.membershipId) {
      throw new ChartWardenError(
        "CHC_ACTOR_MEMBERSHIP_REQUIRED",
        "A preparation is recorded against the membership that requested it.",
        403,
      );
    }
    const membershipId = actor.membershipId;
    return withOrgContext(deps.db, actor, async (tx) => {
      const key = `m24-chc-preparation:${actor.organizationId}:${input.providerEntityId}:${input.patientId}:${input.admissionId}:${input.serviceDate}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      const existingRows = await tx
        .select()
        .from(schema.medicaidChcPricingPreparation)
        .where(
          and(
            eq(schema.medicaidChcPricingPreparation.organizationId, actor.organizationId),
            eq(schema.medicaidChcPricingPreparation.providerEntityId, input.providerEntityId),
            eq(schema.medicaidChcPricingPreparation.patientId, input.patientId),
            eq(schema.medicaidChcPricingPreparation.admissionId, input.admissionId),
            eq(schema.medicaidChcPricingPreparation.serviceDate, input.serviceDate),
          ),
        )
        .orderBy(desc(schema.medicaidChcPricingPreparation.version))
        .limit(1);
      const existing = existingRows[0];
      const preparationId = existing?.preparationId ?? randomUUID();
      const version = existing?.version ?? 0;
      const computed = await resolveCurrent(tx, actor, input, preparationId, version || 1);
      const fingerprint = computed.integrityFingerprint;
      if (
        existing &&
        storedSnapshotMatches(
          existing.snapshot as unknown as Record<string, unknown>,
          existing.fingerprint,
          fingerprint,
          computed as unknown as Record<string, unknown>,
        )
      ) {
        return previewFrom(existing, {
          status: "current",
          preparationId,
          version: existing.version,
          fingerprint,
        });
      }
      const nextVersion = existing ? existing.version + 1 : 1;
      const snapshot: Snapshot = { ...computed, preparationVersion: nextVersion };
      // Version participates in stored structure but not source/calculation identity. Recompute after it is set.
      const nextFingerprint = fingerprintFor(snapshot as unknown as Record<string, unknown>);
      const { integrityFingerprint: _oldFingerprint, ...withoutFingerprint } = snapshot;
      const finalSnapshot: Snapshot = {
        ...withoutFingerprint,
        integrityFingerprint: nextFingerprint,
      };
      const inserted = await tx
        .insert(schema.medicaidChcPricingPreparation)
        .values({
          preparationId,
          organizationId: actor.organizationId,
          providerEntityId: input.providerEntityId,
          patientId: input.patientId,
          admissionId: input.admissionId,
          serviceDate: input.serviceDate,
          version: nextVersion,
          ratePolicyId: finalSnapshot.ratePolicyId,
          billingEvidenceId: finalSnapshot.billingEvidenceId,
          assessedAt: new Date(computed.assessedAt),
          fingerprint: nextFingerprint,
          snapshot: finalSnapshot,
          createdByMembershipId: membershipId,
        })
        .returning();
      const row = inserted[0];
      if (!row) fail("CHC_PREPARATION_PERSISTENCE_FAILED");
      return previewFrom(row, {
        status: "current",
        preparationId,
        version: nextVersion,
        fingerprint: nextFingerprint,
      });
    });
  }

  async function verify(
    actor: M24Actor,
    preparationRecordId: string,
  ): Promise<ChcPreparationVerification> {
    return withOrgContext(deps.db, actor, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.medicaidChcPricingPreparation)
        .where(
          and(
            eq(schema.medicaidChcPricingPreparation.organizationId, actor.organizationId),
            eq(schema.medicaidChcPricingPreparation.id, preparationRecordId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return { status: "unresolved", reasonCode: "CHC_PREPARATION_NOT_FOUND" };
      if (!actor.providerEntityIds?.includes(row.providerEntityId))
        return { status: "unresolved", reasonCode: "CHC_PROVIDER_SCOPE_DENIED" };
      return verifyInTransaction(tx as Tx, actor, row);
    });
  }

  async function read(
    actor: M24Actor,
    preparationRecordId: string,
  ): Promise<ChcPreparationView | null> {
    return withOrgContext(deps.db, actor, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.medicaidChcPricingPreparation)
        .where(
          and(
            eq(schema.medicaidChcPricingPreparation.organizationId, actor.organizationId),
            eq(schema.medicaidChcPricingPreparation.id, preparationRecordId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row || !actor.providerEntityIds?.includes(row.providerEntityId)) return null;
      const verification = await verifyInTransaction(tx as Tx, actor, row);
      return previewFrom(row, verification);
    });
  }

  /** The newest preparation of each service day, newest day first, capped for one background pass. */
  async function latestPreparationsForPatient(
    tx: Tx,
    organizationId: string,
    patientId: string,
  ): Promise<(typeof schema.medicaidChcPricingPreparation.$inferSelect)[]> {
    const table = schema.medicaidChcPricingPreparation;
    const latest = await tx
      .selectDistinctOn([table.providerEntityId, table.admissionId, table.serviceDate])
      .from(table)
      .where(and(eq(table.organizationId, organizationId), eq(table.patientId, patientId)))
      .orderBy(table.providerEntityId, table.admissionId, table.serviceDate, desc(table.version));
    return latest
      .sort((a, b) => b.serviceDate.localeCompare(a.serviceDate))
      .slice(0, MAX_PREPARATIONS_PER_REVALIDATION);
  }

  /**
   * The admissions and rate-policy scopes a background revalidation of this patient will lock. The caller
   * locks them, in its own fixed order and together with its other locks, BEFORE calling
   * `revalidatePatientInTransaction` with the same record ids; this reads only.
   */
  async function revalidationScopesInTransaction(
    transaction: unknown,
    organizationId: string,
    patientId: string,
  ): Promise<readonly ChcRevalidationScope[]> {
    const rows = await latestPreparationsForPatient(transaction as Tx, organizationId, patientId);
    return rows.map((row) => ({
      preparationRecordId: row.id,
      admissionId: row.admissionId,
      rateScope: {
        organizationId,
        providerEntityId: row.providerEntityId,
        canonicalPayerId: row.snapshot.canonicalPayerId,
        serviceState: row.snapshot.serviceState,
      },
    }));
  }

  /**
   * Background revalidation uses the same source-grounded verifier as the API read path, over exactly the
   * preparation rows whose scopes the caller locked (`recordIds`, from `revalidationScopesInTransaction`): a
   * row written since is not verified here, so nothing is verified outside the locked set. The worker runs
   * inside an organization-scoped transaction; provider/admission scope comes from the persisted rows.
   * This is observation-only: local preparations are not claim states and this method writes nothing.
   * The clock is read inside each verification, after its locks.
   */
  async function revalidatePatientInTransaction(
    transaction: unknown,
    organizationId: string,
    patientId: string,
    recordIds: readonly string[],
  ): Promise<
    readonly { readonly id: string; readonly verification: ChcPreparationVerification }[]
  > {
    if (recordIds.length === 0) return [];
    const tx = transaction as Tx;
    const table = schema.medicaidChcPricingPreparation;
    const rows = await tx
      .select()
      .from(table)
      .where(
        and(
          eq(table.organizationId, organizationId),
          eq(table.patientId, patientId),
          inArray(table.id, [...recordIds]),
        ),
      )
      .orderBy(desc(table.serviceDate), table.providerEntityId, table.admissionId);
    const results: { id: string; verification: ChcPreparationVerification }[] = [];
    for (const row of rows) {
      const workerActor: M24Actor = {
        organizationId,
        userId: "",
        roles: ["system"],
        providerEntityIds: [row.providerEntityId],
      };
      results.push({ id: row.id, verification: await verifyInTransaction(tx, workerActor, row) });
    }
    return results;
  }

  return {
    prepare,
    verify,
    read,
    revalidationScopesInTransaction,
    revalidatePatientInTransaction,
  };
}

export type ChcPricingPreparationService = ReturnType<typeof createChcPricingPreparationService>;
