// apps/backend/src/modules/07-care-plan/seams/store.ts — M7-T04 the data PORT the §7.8 CarePlanReader
// composes over, plus an in-memory slice for tests/boot-without-DB. The reader (./reader.ts) is pure
// orchestration over this port; production injects a Drizzle-backed store that reads M7's tables under
// the CONSUMER's `withOrgContext` (the reader never switches tenants — RLS scopes every read by
// `app.org_id`, §7.8). Mirrors the M6 seams/store.ts precedent.
//
// SUD redaction (D7): the store resolves `sudReadAllowed` SQL-side — joining the patient's
// privacy-flag snapshot / the M39 Part-2 consent fact — and tags each problem `containsSud`. It does
// NOT trust a caller-asserted scope (§7.8). The in-memory slice seeds the decision directly so reader
// tests can exercise both the entitled and the redacted paths.
import type {
  CarePlanId,
  IsoInstant,
  PatientId,
  RelevantGoal,
  RelevantIntervention,
  RelevantProblem,
} from "@wardenx/types";

/** A care-plan problem the store hands the reader, carrying the SQL-resolved `containsSud` flag (D7). */
export interface StoredRelevantProblem extends RelevantProblem {
  /** True when this problem is a 42 CFR Part 2 SUD problem — dropped by the reader unless entitled. */
  readonly containsSud: boolean;
}

/**
 * The active care plan's element set for a patient, already tenant-scoped by RLS. `sudReadAllowed` is
 * the store's SQL-side D7 decision (the caller's scope is never trusted); the reader filters SUD
 * problems out and flags `redacted` when it does.
 */
export interface CarePlanElementsRecord {
  readonly planId: CarePlanId;
  readonly patientId: PatientId;
  readonly problems: readonly StoredRelevantProblem[];
  readonly goals: readonly RelevantGoal[];
  readonly interventions: readonly RelevantIntervention[];
  /** Whether the caller is entitled to read SUD-flagged content for this patient (resolved SQL-side). */
  readonly sudReadAllowed: boolean;
}

/** The version-clock facts driving the overdue gate — the columns M7's cron maintains (§2.6). */
export interface CarePlanClockRecord {
  readonly planId: CarePlanId;
  readonly patientId: PatientId;
  readonly hasSignedInitialVersion: boolean;
  readonly initialDueAt: IsoInstant;
  readonly nextReviewDueAt: IsoInstant | null;
}

/**
 * The data port the §7.8 CarePlanReader composes over. Methods return read-only DTO shapes (never
 * Drizzle rows); the Drizzle adapter projects rows to these under the consumer's RLS context. Both
 * reads key only on `patientId` — the org is already pinned by RLS — and return null when the patient
 * has no active care plan (or it is not visible under the consumer's tenant).
 */
export interface CarePlanReaderStore {
  /** The active care plan's problems/goals/interventions for a patient + the D7 redaction decision. */
  activeCarePlanElements(patientId: PatientId): Promise<CarePlanElementsRecord | null>;
  /** The active care plan's overdue-gate clock facts for a patient (initial/review due columns). */
  activeCarePlanClock(patientId: PatientId): Promise<CarePlanClockRecord | null>;
}

// ── in-memory slice store ─────────────────────────────────────────────────────────────────────────

/** Deterministic, I/O-free seed for the in-memory {@link CarePlanReaderStore} (slice + seam tests). */
export interface CarePlanReaderSeed {
  readonly elements?: readonly CarePlanElementsRecord[];
  readonly clocks?: readonly CarePlanClockRecord[];
}

/** An in-memory {@link CarePlanReaderStore} for the slice/tests — no DB, deterministic, RLS-free. */
export function createInMemoryCarePlanReaderStore(seed: CarePlanReaderSeed = {}): {
  store: CarePlanReaderStore;
} {
  const elements = seed.elements ?? [];
  const clocks = seed.clocks ?? [];
  return {
    store: {
      async activeCarePlanElements(patientId) {
        return elements.find((e) => e.patientId === patientId) ?? null;
      },
      async activeCarePlanClock(patientId) {
        return clocks.find((c) => c.patientId === patientId) ?? null;
      },
    },
  };
}
