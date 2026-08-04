// apps/backend/src/modules/09-assessments/seams/providers.ts — M9-T04 the §4.7 / D7 seam
// implementations: pure orchestration over an injected {@link AssessmentReaderStore}. Each returns the
// leaf-typed seam interface (@wardenx/types) the M1 registry validates and M7/M10/M14/M28/M32 resolve.
// The providers add NO tenant logic — RLS scopes every store read by the consumer's `app.org_id` (§4.7);
// they only project store DTOs and apply the D4 read-time series/delta math with one home each.
import type {
  DateRange,
  IsoInstant,
  LatestAssessment,
  LatestAssessmentProvider,
  PatientId,
  ScaleDelta,
  ScaleSeries,
  ScaleSeriesPoint,
  ScaleSeriesProvider,
  ScaleType,
} from "@wardenx/types";
import type { AssessmentReaderStore } from "./store";

/**
 * §4.7 / D7 LatestAssessmentProvider over the store — the hot "give me the latest PPS/FAST/ESAS-r right
 * now" read M7 (CTI narrative draft) + M10 (HOPE prognosis) + M14 (IDG packet) consume synchronously.
 * `latest` returns the single latest-active row per (patient, scale); `latestBatch` resolves several
 * scales for one patient in a single call (the `/internal/assessments/latest-batch` route). The store's
 * SQL-side D10 disclosure decision is already baked into each DTO's `redacted` flag.
 */
export function createLatestAssessmentProvider(
  store: AssessmentReaderStore,
): LatestAssessmentProvider {
  return {
    latest(patientId: PatientId, scaleType: ScaleType): Promise<LatestAssessment | null> {
      return store.latestActive(patientId, scaleType);
    },
    latestBatch(
      patientId: PatientId,
      scaleTypes: ReadonlyArray<ScaleType>,
    ): Promise<ReadonlyArray<LatestAssessment>> {
      return store.latestActiveBatch(patientId, scaleTypes);
    },
  };
}

/** The instant covering the START of a §4.1 LocalDate window (00:00:00.000Z of `from`). */
function startOfDay(localDate: string): IsoInstant {
  return `${localDate}T00:00:00.000Z`;
}
/** The instant covering the END of a §4.1 LocalDate window (23:59:59.999Z of `to`, inclusive). */
function endOfDay(localDate: string): IsoInstant {
  return `${localDate}T23:59:59.999Z`;
}

/**
 * §4.7 / D7 ScaleSeriesProvider over the store — the trend surface M14 (IDG packet deltas) + M28 (FHIR
 * `Observation` series) + M32 (AI symptom-trajectory) consume. `series` returns the windowed scored
 * captures (D4 read-time computation, ascending by `capturedAt`); `delta` returns the latest-vs-window
 * change, computed from the same window's points — null for every field when fewer than two comparable
 * captures exist in the window (§4.1). The `window` is a §4.1 LocalDate range, mapped to inclusive
 * instant bounds here so the math has one home.
 */
export function createScaleSeriesProvider(store: AssessmentReaderStore): ScaleSeriesProvider {
  return {
    async series(
      patientId: PatientId,
      scaleType: ScaleType,
      from: IsoInstant,
      to: IsoInstant,
    ): Promise<ScaleSeries> {
      const points = await store.seriesPoints(patientId, scaleType, from, to);
      return { scaleType, patientId, from, to, points };
    },

    async delta(
      patientId: PatientId,
      scaleType: ScaleType,
      window: DateRange,
    ): Promise<ScaleDelta> {
      const points: ReadonlyArray<ScaleSeriesPoint> = await store.seriesPoints(
        patientId,
        scaleType,
        startOfDay(window.from),
        endOfDay(window.to),
      );
      // "latest-vs-window": the most recent capture vs the earliest, both within the window. A delta
      // needs at least two comparable captures (§4.1) — otherwise every numeric field is null.
      if (points.length < 2) {
        return { scaleType, patientId, window, latestScore: null, priorScore: null, delta: null };
      }
      const priorScore = points[0]!.score;
      const latestScore = points[points.length - 1]!.score;
      const delta = latestScore !== null && priorScore !== null ? latestScore - priorScore : null;
      return { scaleType, patientId, window, latestScore, priorScore, delta };
    },
  };
}
