// apps/backend/src/modules/06-admission/seams/store.ts — M6-T05 the data PORT the §4.7 reader seams
// compose over, plus an in-memory slice implementation for tests/boot-without-DB. The readers
// (./readers.ts) are pure orchestration over this port; production injects a Drizzle-backed store
// that reads M6's tables under the CONSUMER's `withOrgContext` (the reader never switches tenants —
// RLS scopes every read by `app.org_id`; §4.7). The in-memory store backs the slice + seam unit
// tests with deterministic, I/O-free data.
import type {
  ActiveElectionPeriod,
  AdmissionCensusEntry,
  AdmissionId,
  AdmissionReaderScope,
  AdmissionSummary,
  CertificationSummary,
  DateRange,
  ElectionPeriodId,
  ElectionPeriodKind,
  ElectionPeriodSummary,
  FaceToFaceSummary,
  LevelOfCare,
  LevelOfCarePeriodSummary,
  LocalDate,
  PatientId,
} from "@wardenx/types";

/**
 * A seeded election-period row (richer than the wire DTOs: it carries `patientId` + `levelOfCare` so
 * the store can answer both `findActivePeriodForPatient` and `listPeriodsForAdmission` from one source).
 */
export interface ElectionPeriodRecord {
  readonly periodId: ElectionPeriodId;
  readonly admissionId: AdmissionId;
  readonly patientId: PatientId;
  readonly sequence: number;
  readonly periodKind: ElectionPeriodKind;
  readonly status: ElectionPeriodSummary["status"];
  readonly levelOfCare: LevelOfCare;
  readonly startDate: LocalDate;
  readonly endDate: LocalDate;
  readonly actualEndDate: LocalDate | null;
}

/**
 * The data port every M6 reader seam composes over. Methods return read-only DTO shapes (never Drizzle
 * rows); the Drizzle adapter projects rows to these under the consumer's RLS context. Most reads are
 * already tenant-scoped by the ambient request context, while `admissionSummary` takes an explicit
 * `organizationId` so background consumers can open their own RLS scope without an HTTP request context.
 */
export interface AdmissionReaderStore {
  /** Every election period for an admission, sequence-ordered (M23 NOE/NOTR window math). */
  electionPeriodsForAdmission(
    admissionId: AdmissionId,
  ): Promise<readonly ElectionPeriodRecord[]>;
  /** Every election period for a patient (the reader picks the one containing `on`). */
  electionPeriodsForPatient(
    patientId: PatientId,
  ): Promise<readonly ElectionPeriodRecord[]>;
  /** The admission status projection, or null when the id is unknown / not visible under RLS. */
  admissionSummary(
    organizationId: string,
    admissionId: AdmissionId,
  ): Promise<AdmissionSummary | null>;
  /** Every level-of-care period for an admission (the reader derives current + day counts). */
  levelOfCarePeriods(
    admissionId: AdmissionId,
  ): Promise<readonly LevelOfCarePeriodSummary[]>;
  /** The active (non-superseded/non-voided) CTI for a period, or null. */
  activeCertification(
    electionPeriodId: ElectionPeriodId,
  ): Promise<CertificationSummary | null>;
  /** The attested F2F for a recert period, or null. */
  attestedF2f(
    electionPeriodId: ElectionPeriodId,
  ): Promise<FaceToFaceSummary | null>;
  /** Active admissions in scope (org from RLS; optional `providerEntityId` narrow). */
  activeAdmissions(
    scope: AdmissionReaderScope,
  ): Promise<readonly AdmissionSummary[]>;
}

/** Project the rich election-period record to the external `ElectionPeriodSummary` DTO (§4.7). */
export function toElectionPeriodSummary(
  r: ElectionPeriodRecord,
): ElectionPeriodSummary {
  return {
    periodId: r.periodId,
    admissionId: r.admissionId,
    sequence: r.sequence,
    periodKind: r.periodKind,
    status: r.status,
    startDate: r.startDate,
    endDate: r.endDate,
    actualEndDate: r.actualEndDate,
  };
}

/** Project the rich record to the active-period DTO M23 binds a claim to (§4.7). */
export function toActiveElectionPeriod(
  r: ElectionPeriodRecord,
): ActiveElectionPeriod {
  return {
    periodId: r.periodId,
    sequence: r.sequence,
    levelOfCare: r.levelOfCare,
    startDate: r.startDate,
    endDate: r.endDate,
  };
}

/** Project an admission summary to a census/list entry (§4.7 AdmissionCensusReader). */
export function toCensusEntry(s: AdmissionSummary): AdmissionCensusEntry {
  return {
    admissionId: s.admissionId,
    patientId: s.patientId,
    providerEntityId: s.providerEntityId,
    status: s.status,
    currentLevelOfCare: s.currentLevelOfCare,
    admissionAt: s.admissionAt,
  };
}

// ── in-memory slice store ───────────────────────────────────────────────────────────────────────

/** Deterministic, I/O-free seed for the in-memory {@link AdmissionReaderStore} (slice + seam tests). */
export interface AdmissionReaderSeed {
  readonly admissions?: readonly AdmissionSummary[];
  readonly electionPeriods?: readonly ElectionPeriodRecord[];
  readonly levelOfCarePeriods?: readonly LevelOfCarePeriodSummary[];
  readonly certifications?: readonly CertificationSummary[];
  readonly faceToFace?: readonly FaceToFaceSummary[];
}

/** `true` when `on` falls within `[start, effectiveEnd]` inclusive (string compare is sound for ISO dates). */
function withinPeriod(on: LocalDate, r: ElectionPeriodRecord): boolean {
  const end = r.actualEndDate ?? r.endDate;
  return r.startDate <= on && on <= end;
}

/** An in-memory {@link AdmissionReaderStore} for the slice/tests — no DB, deterministic, RLS-free. */
export function createInMemoryAdmissionReaderStore(
  seed: AdmissionReaderSeed = {},
): {
  store: AdmissionReaderStore;
} {
  const admissions = seed.admissions ?? [];
  const periods = seed.electionPeriods ?? [];
  const locPeriods = seed.levelOfCarePeriods ?? [];
  const certs = seed.certifications ?? [];
  const f2fs = seed.faceToFace ?? [];

  return {
    store: {
      async electionPeriodsForAdmission(admissionId) {
        return periods
          .filter((p) => p.admissionId === admissionId)
          .sort((a, b) => a.sequence - b.sequence);
      },
      async electionPeriodsForPatient(patientId) {
        return periods
          .filter((p) => p.patientId === patientId)
          .sort((a, b) => a.sequence - b.sequence);
      },
      async admissionSummary(organizationId, admissionId) {
        return (
          admissions.find(
            (a) => a.organizationId === organizationId && a.admissionId === admissionId,
          ) ?? null
        );
      },
      async levelOfCarePeriods(admissionId) {
        return locPeriods
          .filter((l) => l.admissionId === admissionId)
          .sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt));
      },
      async activeCertification(electionPeriodId) {
        // Prefer a non-terminal CTI; fall back to the latest matching row.
        const matches = certs.filter(
          (c) => c.electionPeriodId === electionPeriodId,
        );
        return (
          matches.find(
            (c) => c.status !== "voided" && c.status !== "superseded",
          ) ??
          matches.at(-1) ??
          null
        );
      },
      async attestedF2f(electionPeriodId) {
        return (
          f2fs.find(
            (f) =>
              f.electionPeriodId === electionPeriodId &&
              f.status === "attested",
          ) ??
          f2fs.find((f) => f.electionPeriodId === electionPeriodId) ??
          null
        );
      },
      async activeAdmissions(scope) {
        return admissions.filter(
          (a) =>
            a.organizationId === scope.orgId &&
            a.status === "active" &&
            (scope.providerEntityId === undefined ||
              a.providerEntityId === scope.providerEntityId),
        );
      },
    },
  };
}

export type { DateRange };
