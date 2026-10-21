// apps/backend/src/modules/10-hope/seams/store.ts — M10-T05 the data PORT the §2 / D10 seam providers
// (HopeTimepointProvider + HopeJ2051Provider + HopeSubmissionProvider) compose over, plus an in-memory
// slice for tests/boot-without-DB. The providers (./providers.ts) are pure orchestration over this port;
// production injects a Drizzle-backed store that reads M10's partitioned `hope_assessment` / schedule /
// SFV / submission tables under the CONSUMER's `withOrgContext` — the providers never switch tenants; RLS
// scopes every read by `app.org_id` (§3.6). Mirrors the M9 seams/store.ts precedent.
//
// The store returns read-only DTO projections (never Drizzle rows): the structured timepoint/J2051/
// submission columns only. No HOPE-section `data` jsonb or `clinical_context_snapshot` (PHI) ever crosses
// the seam — the three published surfaces are the operational read M30/M14/M22/M32 consume, not the raw
// instrument. The in-memory slice seeds the DTOs directly so provider tests exercise the open/history
// filtering with no DB.
import type {
  AdmissionId,
  HopeJ2051Event,
  HopeSubmissionId,
  HopeSubmissionStatusView,
  HopeTimepointStatus,
  PatientId,
  ProviderEntityId,
} from "@chartwarden/types";

/**
 * The data port the §2 / D10 seam providers compose over. Methods return read-only DTO shapes (never
 * Drizzle rows); the Drizzle adapter projects partition-pruned rows to these under the consumer's RLS
 * context. Reads key on `patientId` / `admissionId` / `providerEntityId` — the org is already pinned by
 * RLS — and return an empty slice / null when the subject has no visible rows under the consumer's tenant.
 * The providers apply the open/history read-time semantics over the full set the store returns.
 */
export interface HopeSeamStore {
  /** Every timepoint schedule row for a patient (the provider narrows to the still-`open` windows). */
  timepointsForPatient(patientId: PatientId): Promise<ReadonlyArray<HopeTimepointStatus>>;
  /** The full timepoint schedule set for one admission (the per-admission HOPE timeline). */
  timepointsForAdmission(admissionId: AdmissionId): Promise<ReadonlyArray<HopeTimepointStatus>>;
  /** Every J2051 trigger event for a patient (the provider sorts ascending / narrows to open SFVs). */
  j2051EventsForPatient(patientId: PatientId): Promise<ReadonlyArray<HopeJ2051Event>>;
  /** The most recent submission batch for a ProviderEntity (HOPE is per-PE; M10-F09), or null when none. */
  latestSubmissionForProviderEntity(
    providerEntityId: ProviderEntityId,
  ): Promise<HopeSubmissionStatusView | null>;
  /** One submission batch resolved by id, or null when it is not visible under the consumer's tenant. */
  submissionById(submissionId: HopeSubmissionId): Promise<HopeSubmissionStatusView | null>;
}

// ── in-memory slice store ─────────────────────────────────────────────────────────────────────────

/** Deterministic, I/O-free seed for the in-memory {@link HopeSeamStore} (slice + seam tests). */
export interface HopeSeamSeed {
  /** Timepoint schedule rows the timepoint reads resolve (any order; filtered/projected per call). */
  readonly timepoints?: readonly HopeTimepointStatus[];
  /** J2051 trigger events the J2051 reads window over (any order; the provider sorts ascending). */
  readonly j2051Events?: readonly HopeJ2051Event[];
  /** Submission batch rows the submission reads resolve (latest-per-PE picked by `transmittedAt`). */
  readonly submissions?: readonly HopeSubmissionStatusView[];
}

/** An in-memory {@link HopeSeamStore} for the slice/tests — no DB, deterministic, RLS-free. */
export function createInMemoryHopeSeamStore(seed: HopeSeamSeed = {}): { store: HopeSeamStore } {
  const timepoints = seed.timepoints ?? [];
  const j2051Events = seed.j2051Events ?? [];
  const submissions = seed.submissions ?? [];
  /** Most recent of two batches by `transmittedAt` (an untransmitted/null batch sorts oldest). */
  const transmittedAt = (s: HopeSubmissionStatusView): string => s.transmittedAt ?? "";
  return {
    store: {
      async timepointsForPatient(patientId) {
        return timepoints.filter((t) => t.patientId === patientId);
      },
      async timepointsForAdmission(admissionId) {
        return timepoints.filter((t) => t.admissionId === admissionId);
      },
      async j2051EventsForPatient(patientId) {
        return j2051Events.filter((e) => e.patientId === patientId);
      },
      async latestSubmissionForProviderEntity(providerEntityId) {
        const forPe = submissions.filter((s) => s.providerEntityId === providerEntityId);
        if (forPe.length === 0) return null;
        return forPe.reduce((latest, s) => (transmittedAt(s) > transmittedAt(latest) ? s : latest));
      },
      async submissionById(submissionId) {
        return submissions.find((s) => s.submissionId === submissionId) ?? null;
      },
    },
  };
}
