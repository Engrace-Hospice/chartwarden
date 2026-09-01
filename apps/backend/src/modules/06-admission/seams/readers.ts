// apps/backend/src/modules/06-admission/seams/readers.ts — M6-T05 the §4.7 reader-seam
// implementations: pure orchestration over an injected {@link AdmissionReaderStore}. Each factory
// returns the leaf-typed seam interface (@wardenx/types) the M1 registry validates and downstream
// modules resolve. The readers add NO tenant logic — RLS scopes every store read by the consumer's
// `app.org_id`; they only project store DTOs and compute the derived facts (LOC-day counts, the
// signed/attested booleans, current-LOC selection) so each rule has one home.
import type {
  AdmissionCensusReader,
  AdmissionId,
  AdmissionStatusReader,
  AdmissionSummary,
  CertificationReader,
  DateRange,
  ElectionPeriodReader,
  FaceToFaceReader,
  LevelOfCare,
  LevelOfCareDays,
  LevelOfCarePeriodSummary,
  LevelOfCareReader,
  LocalDate,
} from "@wardenx/types";
import { daysBetween } from "../state-machines/index";
import {
  type AdmissionReaderStore,
  toActiveElectionPeriod,
  toCensusEntry,
  toElectionPeriodSummary,
} from "./store";

/** Thrown when a status read targets an admission id that does not exist / is not visible under RLS. */
export class AdmissionNotFoundError extends Error {
  constructor(admissionId: AdmissionId) {
    super(`admission '${admissionId}' not found`);
    this.name = "AdmissionNotFoundError";
  }
}

/** The four CMS levels of care, used to seed a zero-filled day-count accumulator. */
const LEVELS_OF_CARE: readonly LevelOfCare[] = [
  "routine_home_care",
  "continuous_home_care",
  "inpatient_respite_care",
  "general_inpatient_care",
];

/** Inclusive whole-day overlap between a LOC period and a query range (0 when they do not overlap). */
function overlapDays(period: LevelOfCarePeriodSummary, range: DateRange): number {
  const start = period.effectiveAt > range.from ? period.effectiveAt : range.from;
  const periodEnd = period.endedAt ?? range.to;
  const end = periodEnd < range.to ? periodEnd : range.to;
  if (start > end) return 0;
  return daysBetween(start, end) + 1; // inclusive of both endpoints
}

/** §4.7 ElectionPeriodReader over the store (M23 binds claims to the right period/sequence). */
export function createElectionPeriodReader(store: AdmissionReaderStore): ElectionPeriodReader {
  return {
    async findActivePeriodForPatient(patientId, on: LocalDate) {
      const periods = await store.electionPeriodsForPatient(patientId);
      const active = periods
        .filter((p) => p.startDate <= on && on <= (p.actualEndDate ?? p.endDate))
        .sort((a, b) => b.sequence - a.sequence)[0];
      return active ? toActiveElectionPeriod(active) : null;
    },
    async listPeriodsForAdmission(admissionId) {
      return (await store.electionPeriodsForAdmission(admissionId)).map(toElectionPeriodSummary);
    },
  };
}

/** §4.7 AdmissionStatusReader (M14 queues, M30 dashboards). Throws when the admission is unknown. */
export function createAdmissionStatusReader(store: AdmissionReaderStore): AdmissionStatusReader {
  return {
    async getAdmissionSummary(organizationId, admissionId) {
      const summary = await store.admissionSummary(organizationId, admissionId);
      if (summary === null) throw new AdmissionNotFoundError(admissionId);
      return summary;
    },
  };
}

/** §4.7 LevelOfCareReader — current LOC for clinical screens + LOC-days by level (M26 cap). `assigning`
 *  periods (IRC/GIP awaiting M37 bed confirmation, confirm-handshake fix) are excluded entirely — not
 *  yet a real period of care, so neither "current LOC" nor a cap-relevant day count. */
export function createLevelOfCareReader(store: AdmissionReaderStore): LevelOfCareReader {
  return {
    async getCurrentLevelOfCare(admissionId) {
      const periods = (await store.levelOfCarePeriods(admissionId)).filter(
        (p) => p.status !== "assigning",
      );
      // Prefer an OPEN period (endedAt null); else the most recent by effectiveAt (store-sorted asc).
      return periods.find((p) => p.endedAt === null) ?? periods.at(-1) ?? null;
    },
    async getLevelOfCareDays(admissionId, range): Promise<LevelOfCareDays> {
      const periods = await store.levelOfCarePeriods(admissionId);
      const daysByLevel = Object.fromEntries(LEVELS_OF_CARE.map((l) => [l, 0])) as {
        [L in LevelOfCare]: number;
      };
      for (const p of periods) {
        if (p.status === "assigning") continue;
        daysByLevel[p.levelOfCare] += overlapDays(p, range);
      }
      return { admissionId, range, daysByLevel };
    },
  };
}

/** §4.7 CertificationReader — recert gating: the active CTI for a period + whether it is signed. */
export function createCertificationReader(store: AdmissionReaderStore): CertificationReader {
  return {
    async getActiveCertification(electionPeriodId) {
      return store.activeCertification(electionPeriodId);
    },
    async isCertificationSignedForPeriod(electionPeriodId) {
      const cti = await store.activeCertification(electionPeriodId);
      return cti?.status === "signed";
    },
  };
}

/** §4.7 FaceToFaceReader — recert gating: the attested F2F for a period + whether one exists. */
export function createFaceToFaceReader(store: AdmissionReaderStore): FaceToFaceReader {
  return {
    async getAttestedF2fForPeriod(electionPeriodId) {
      const f2f = await store.attestedF2f(electionPeriodId);
      return f2f?.status === "attested" ? f2f : null;
    },
    async isF2fAttestedForPeriod(electionPeriodId) {
      const f2f = await store.attestedF2f(electionPeriodId);
      return f2f?.status === "attested";
    },
  };
}

/** §4.7 AdmissionCensusReader — active-admission census/list (M30 dashboards, M22 form prep). */
export function createAdmissionCensusReader(store: AdmissionReaderStore): AdmissionCensusReader {
  return {
    async listActiveAdmissions(scope) {
      const rows: readonly AdmissionSummary[] = await store.activeAdmissions(scope);
      return rows.map(toCensusEntry);
    },
  };
}
