// apps/backend/src/modules/09-assessments/seams/store.ts — M9-T04 the data PORT the §4.7 / D7 seam
// providers (LatestAssessmentProvider + ScaleSeriesProvider) compose over, plus an in-memory slice for
// tests/boot-without-DB. The providers (./providers.ts) are pure orchestration over this port;
// production injects a Drizzle-backed store that reads M9's partitioned `clinical_assessment` table
// (§3.4 `(organization_id, patient_id, scale_type, captured_at DESC)` btree) under the CONSUMER's
// `withOrgContext` — the providers never switch tenants; RLS scopes every read by `app.org_id` (§4.7).
// Mirrors the M7/M8 seams/store.ts precedent.
//
// SUD/AIMS redaction (D10): the store resolves the disclosure decision SQL-side — via the M39 Part-2
// consent fact — and tags the projected `LatestAssessment.redacted` / `ScaleSeriesPoint` accordingly. It
// does NOT trust a caller-asserted scope (§4.7). The in-memory slice seeds the DTOs directly so provider
// tests can exercise both the entitled and the redacted paths.
import type {
  IsoInstant,
  LatestAssessment,
  PatientId,
  ScaleSeriesPoint,
  ScaleType,
} from "@wardenx/types";

/**
 * The data port the §4.7 seam providers compose over. Methods return read-only DTO shapes (never
 * Drizzle rows); the Drizzle adapter projects partition-pruned rows to these under the consumer's RLS
 * context. Reads key only on `patientId` (+ scale/window) — the org is already pinned by RLS — and
 * return null / an empty slice when the patient has no visible active capture under the consumer's tenant.
 */
export interface AssessmentReaderStore {
  /** The latest `active` capture of one scale for a patient (D4 `latest`), or null when none exists. */
  latestActive(patientId: PatientId, scaleType: ScaleType): Promise<LatestAssessment | null>;
  /** The latest `active` capture of EACH requested scale for a patient (the latest-batch route). */
  latestActiveBatch(
    patientId: PatientId,
    scaleTypes: ReadonlyArray<ScaleType>,
  ): Promise<ReadonlyArray<LatestAssessment>>;
  /**
   * The scored captures of one scale for a patient within `[from, to]`, ordered by `capturedAt`
   * ASCENDING (D4 read-time series). The Drizzle adapter computes nothing — `score` is the canonical
   * value persisted at record time (D6) and `significantChange` is the row's detector marker.
   */
  seriesPoints(
    patientId: PatientId,
    scaleType: ScaleType,
    from: IsoInstant,
    to: IsoInstant,
  ): Promise<ReadonlyArray<ScaleSeriesPoint>>;
}

// ── in-memory slice store ─────────────────────────────────────────────────────────────────────────

/** Deterministic, I/O-free seed for the in-memory {@link AssessmentReaderStore} (slice + seam tests). */
export interface AssessmentReaderSeed {
  /** The latest active row per (patient, scale) the latest reads resolve. */
  readonly latest?: readonly LatestAssessment[];
  /** Every scored capture the series reads window over (any order; the slice sorts ascending). */
  readonly points?: ReadonlyArray<
    ScaleSeriesPoint & { readonly patientId: PatientId; readonly scaleType: ScaleType }
  >;
}

/** A scored capture in the in-memory slice, tagged with its (patient, scale) so the slice can window it. */
export type SeededSeriesPoint = ScaleSeriesPoint & {
  readonly patientId: PatientId;
  readonly scaleType: ScaleType;
};

/** An in-memory {@link AssessmentReaderStore} for the slice/tests — no DB, deterministic, RLS-free. */
export function createInMemoryAssessmentReaderStore(seed: AssessmentReaderSeed = {}): {
  store: AssessmentReaderStore;
} {
  const latest = seed.latest ?? [];
  const points = seed.points ?? [];
  return {
    store: {
      async latestActive(patientId, scaleType) {
        return latest.find((l) => l.patientId === patientId && l.scaleType === scaleType) ?? null;
      },
      async latestActiveBatch(patientId, scaleTypes) {
        const wanted = new Set(scaleTypes);
        return latest.filter((l) => l.patientId === patientId && wanted.has(l.scaleType));
      },
      async seriesPoints(patientId, scaleType, from, to) {
        return points
          .filter(
            (p) =>
              p.patientId === patientId &&
              p.scaleType === scaleType &&
              p.capturedAt >= from &&
              p.capturedAt <= to,
          )
          .sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0))
          .map(({ patientId: _p, scaleType: _s, ...point }) => point);
      },
    },
  };
}
