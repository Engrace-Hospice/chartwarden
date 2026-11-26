import { createHash } from "node:crypto";
import type {
  PayerRatePolicyFact,
  VerifiedElectionDayEvidence,
} from "@chartwarden/medicaid-adapters";
import type { MedicaidElectionHistoryFacts } from "../../06-admission/seams/medicaid-election-history";

export const SUPPORTED_SYNTHETIC_ELECTION_DAY_BASIS =
  "current_signed_election_calendar_days_v1" as const;

export interface RHCResolvedElectionDayRange {
  readonly status: "not_required" | "resolved" | "unresolved" | "ambiguous" | "unsupported";
  readonly reasonCode?: string;
  readonly days: ReadonlyMap<string, VerifiedElectionDayEvidence>;
  readonly snapshot: null | {
    readonly basis: typeof SUPPORTED_SYNTHETIC_ELECTION_DAY_BASIS;
    readonly electionPeriodId: string;
    readonly electionStatementId: string;
    readonly electionStartDate: string;
    readonly historyReference: string;
    readonly historyFingerprint: string;
    readonly historyVersion: number;
    readonly historyEvidenceId: string;
    readonly historyEvidenceVersion: number;
    readonly verifiedAt: string;
    readonly dayFrom: number;
    readonly dayTo: number;
  };
}

const dayMs = 86_400_000;
const validDay = (value: string | null): value is string =>
  value !== null &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / dayMs);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/** Resolve only the explicitly qualified synthetic managed-care day-count method. */
export function resolveRhcElectionDayRange(input: {
  readonly history: MedicaidElectionHistoryFacts | null;
  readonly rateRows: readonly Pick<
    PayerRatePolicyFact,
    | "id"
    | "version"
    | "serviceCategory"
    | "bucketFrom"
    | "bucketTo"
    | "electionDayBasis"
    | "verificationStatus"
    | "effectiveFrom"
    | "effectiveTo"
    | "sourceDocumentRef"
    | "verifiedAt"
  >[];
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly admissionVersion: number | undefined;
  readonly programKind: "oregon_ffs" | "managed_care";
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly assessedAt: string;
}): RHCResolvedElectionDayRange {
  const none = (status: RHCResolvedElectionDayRange["status"], reasonCode?: string) =>
    ({
      status,
      ...(reasonCode ? { reasonCode } : {}),
      days: new Map<string, VerifiedElectionDayEvidence>(),
      snapshot: null,
    }) as RHCResolvedElectionDayRange;
  const bucketRates = input.rateRows.filter(
    (row) =>
      row.serviceCategory === "RHC" &&
      (row.bucketFrom !== null || row.bucketTo !== null) &&
      row.effectiveFrom <= input.serviceTo &&
      (row.effectiveTo === null || row.effectiveTo >= input.serviceFrom),
  );
  if (bucketRates.length === 0) return none("not_required");
  if (input.programKind !== "managed_care") {
    return none("unsupported", "RHC_ELECTION_DAY_METHOD_UNQUALIFIED_FOR_PROGRAM");
  }
  if (
    !validDay(input.serviceFrom) ||
    !validDay(input.serviceTo) ||
    input.serviceFrom > input.serviceTo
  ) {
    return none("unsupported", "RHC_ELECTION_SERVICE_RANGE_INVALID");
  }
  if (!Number.isFinite(Date.parse(input.assessedAt))) {
    return none("unresolved", "RHC_ELECTION_ASSESSMENT_TIME_INVALID");
  }
  if (
    bucketRates.some(
      (row) =>
        row.electionDayBasis !== SUPPORTED_SYNTHETIC_ELECTION_DAY_BASIS ||
        row.verificationStatus !== "verified" ||
        !row.sourceDocumentRef ||
        !row.verifiedAt ||
        Date.parse(row.verifiedAt) > Date.parse(input.assessedAt),
    )
  ) {
    return none("unsupported", "RHC_ELECTION_DAY_METHODOLOGY_UNQUALIFIED");
  }
  const history = input.history;
  if (!history) return none("unresolved", "RHC_ELECTION_HISTORY_UNAVAILABLE");
  if (
    history.organizationId !== input.organizationId ||
    history.providerEntityId !== input.providerEntityId ||
    history.patientId !== input.patientId ||
    history.admissionId !== input.admissionId ||
    input.admissionVersion === undefined ||
    history.admissionVersion !== input.admissionVersion
  ) {
    return none("ambiguous", "RHC_ELECTION_HISTORY_SCOPE_CONFLICT");
  }
  const initial = history.electionPeriods.filter((period) => period.sequenceNumber === 1);
  if (initial.length !== 1) return none("ambiguous", "RHC_INITIAL_ELECTION_AMBIGUOUS");
  const election = initial[0]!;
  const statement = election.statement;
  const historyEvidence = history.historyEvidence;
  if (
    history.admissionState !== "active" ||
    !validDay(election.effectiveAt) ||
    history.historyTruncated ||
    !historyEvidence ||
    historyEvidence.electionPeriodId !== election.id ||
    historyEvidence.completenessStatus !== "complete" ||
    historyEvidence.priorHospiceStatus !== "none_confirmed" ||
    historyEvidence.transferStatus !== "none_confirmed" ||
    historyEvidence.interruptionStatus !== "none_confirmed" ||
    historyEvidence.verificationStatus !== "verified" ||
    !historyEvidence.verifiedAt ||
    !validDay(historyEvidence.coverageFrom) ||
    !validDay(historyEvidence.coverageThrough) ||
    historyEvidence.coverageFrom > election.effectiveAt ||
    historyEvidence.coverageThrough < input.serviceTo ||
    Date.parse(historyEvidence.verifiedAt) > Date.parse(input.assessedAt) ||
    Date.parse(historyEvidence.createdAt) > Date.parse(input.assessedAt)
  ) {
    return none("unresolved", "RHC_ELECTION_HISTORY_COMPLETENESS_UNVERIFIED");
  }
  if (election.status !== "active" && election.status !== "completed")
    return none("unresolved", "RHC_ELECTION_NOT_ACTIVE_OR_COMPLETED");
  if (
    !validDay(election.effectiveAt) ||
    !statement ||
    statement.id !== election.electionStatementId ||
    statement.status !== "signed" ||
    statement.patientId !== input.patientId ||
    statement.providerEntityId !== input.providerEntityId ||
    statement.declaredEffectiveDate !== election.effectiveAt ||
    statement.signedAt === null ||
    Date.parse(statement.updatedAt) > Date.parse(input.assessedAt)
  ) {
    return none("unresolved", "RHC_SIGNED_ELECTION_SOURCE_UNRESOLVED");
  }
  if (
    history.transferredIn ||
    history.transfers.some((event) => event.effectiveAt <= input.serviceTo)
  ) {
    return none("unsupported", "RHC_ELECTION_TRANSFER_CONTINUITY_UNQUALIFIED");
  }
  const startDate = election.effectiveAt;
  if (input.serviceFrom < startDate) {
    return none("unresolved", "RHC_ELECTION_HISTORY_START_AFTER_SERVICE");
  }
  const laterPeriods = [...history.electionPeriods]
    .filter(
      (period) =>
        period.sequenceNumber > 1 &&
        period.effectiveAt !== null &&
        period.effectiveAt <= input.serviceTo,
    )
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  if (laterPeriods.length > 0) {
    return none("unsupported", "RHC_SUBSEQUENT_ELECTION_DAY_BASIS_UNQUALIFIED");
  }
  let expectedSequence = 2;
  let previousEnd = election.actualEndAt;
  for (const period of laterPeriods) {
    if (
      period.sequenceNumber !== expectedSequence ||
      !validDay(period.effectiveAt) ||
      !validDay(previousEnd) ||
      period.effectiveAt !==
        new Date(Date.parse(`${previousEnd}T00:00:00.000Z`) + dayMs).toISOString().slice(0, 10) ||
      (period.status !== "active" && period.status !== "completed")
    ) {
      return none("ambiguous", "RHC_ELECTION_PERIOD_HISTORY_CONFLICT");
    }
    expectedSequence += 1;
    previousEnd = period.actualEndAt;
  }
  if (
    history.revocations.some(
      (event) => event.effectiveAt >= startDate && event.effectiveAt <= input.serviceTo,
    )
  ) {
    return none("unsupported", "RHC_ELECTION_REVOCATION_CONTINUITY_UNQUALIFIED");
  }
  if (
    history.completedDischarges.some(
      (event) => event.effectiveAt >= startDate && event.effectiveAt <= input.serviceTo,
    )
  ) {
    return none("unsupported", "RHC_ELECTION_DISCHARGE_CONTINUITY_UNQUALIFIED");
  }
  const sources = [
    history.admissionVersion,
    historyEvidence.sourceVersion,
    historyEvidence.version,
    ...history.electionPeriods.flatMap((period) => [
      period.version,
      period.statement?.version ?? 0,
    ]),
    ...history.transfers.map((event) => event.version),
    ...history.revocations.map((event) => event.version),
    ...history.completedDischarges.map((event) => event.version),
    historyEvidence.sourceVersion,
    historyEvidence.version,
  ];
  const version = Math.max(1, ...sources);
  const verifiedAt = [
    historyEvidence.verifiedAt,
    ...history.electionPeriods.flatMap((period) => [
      period.updatedAt,
      period.statement?.updatedAt ?? "",
    ]),
    ...history.transfers.map((event) => event.updatedAt),
    ...history.revocations.map((event) => event.updatedAt),
    ...history.completedDischarges.map((event) => event.updatedAt),
  ]
    .filter(Boolean)
    .sort()
    .at(-1)!;
  if (!verifiedAt || Date.parse(verifiedAt) > Date.parse(input.assessedAt)) {
    return none("unresolved", "RHC_ELECTION_EVIDENCE_NEWER_THAN_ASSESSMENT");
  }
  const historyMaterial = {
    organizationId: history.organizationId,
    providerEntityId: history.providerEntityId,
    patientId: history.patientId,
    admissionId: history.admissionId,
    admissionVersion: history.admissionVersion,
    transferredIn: history.transferredIn,
    electionPeriods: history.electionPeriods,
    transfers: history.transfers,
    revocations: history.revocations,
    completedDischarges: history.completedDischarges,
    historyEvidence,
  };
  const historyFingerprint = createHash("sha256").update(canonical(historyMaterial)).digest("hex");
  const historyReference = `m6:election-history:${history.admissionId}:${historyFingerprint}`;
  const days = new Map<string, VerifiedElectionDayEvidence>();
  let dayFrom: number | null = null;
  let dayTo: number | null = null;
  for (
    let cursor = Date.parse(`${input.serviceFrom}T00:00:00.000Z`);
    cursor <= Date.parse(`${input.serviceTo}T00:00:00.000Z`);
    cursor += dayMs
  ) {
    const serviceDate = new Date(cursor).toISOString().slice(0, 10);
    const serviceDay = daysBetween(startDate, serviceDate) + 1;
    if (serviceDay < 1 || !Number.isSafeInteger(serviceDay)) {
      return none("unresolved", "RHC_ELECTION_DAY_NUMBER_UNRESOLVED");
    }
    if (dayFrom === null) dayFrom = serviceDay;
    dayTo = serviceDay;
    days.set(serviceDate, {
      electionDayNumber: serviceDay,
      serviceDate,
      sourceReference: historyReference,
      version,
      verifiedAt,
    });
  }
  if (days.size !== daysBetween(input.serviceFrom, input.serviceTo) + 1) {
    return none("unresolved", "RHC_ELECTION_SERVICE_DAYS_INCOMPLETE");
  }
  return {
    status: "resolved",
    days,
    snapshot: {
      basis: SUPPORTED_SYNTHETIC_ELECTION_DAY_BASIS,
      electionPeriodId: election.id,
      electionStatementId: statement.id,
      electionStartDate: startDate,
      historyReference,
      historyFingerprint,
      historyVersion: version,
      historyEvidenceId: historyEvidence.id,
      historyEvidenceVersion: historyEvidence.version,
      verifiedAt,
      dayFrom: dayFrom!,
      dayTo: dayTo!,
    },
  };
}
