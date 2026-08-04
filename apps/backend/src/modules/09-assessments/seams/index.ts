// apps/backend/src/modules/09-assessments/seams — M9's published §4.7 / D7 owned seams (M9-T04). M9
// publishes TWO leaf-typed read-only DTO surfaces every downstream module consumes instead of importing
// M9's schema (architecture §11 blocks the schema import): LatestAssessmentProvider (M7 CTI narrative
// draft + IDG latest, M10 HOPE prognosis context, M14 IDG packet) and ScaleSeriesProvider (M14 deltas,
// M28 FHIR `Observation` series, M32 AI symptom-trajectory). `registerAssessmentSeams` registers both
// real impls over their boot deny-stubs (before validateSeams()), driven from the composition root's
// wireModuleSeams(). Both share ONE injected AssessmentReaderStore (in-memory slice here; Drizzle in
// prod, reads under the consumer's RLS) — mirrors the M7/M8 seams/index.ts precedent.
import type { LatestAssessmentProvider, ScaleSeriesProvider } from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import { createLatestAssessmentProvider, createScaleSeriesProvider } from "./providers";
import { type AssessmentReaderStore, createInMemoryAssessmentReaderStore } from "./store";

export {
  type AssessmentReaderSeed,
  type AssessmentReaderStore,
  type SeededSeriesPoint,
  createInMemoryAssessmentReaderStore,
} from "./store";
export { createLatestAssessmentProvider, createScaleSeriesProvider } from "./providers";
export { AssessmentSeamDataGapError, createDrizzleAssessmentReaderStore } from "./drizzle-store";

/** Deps for M9's owned-seam registration (slice defaults to the in-memory store). */
export interface AssessmentSeamDeps {
  /** The §4.7 data port (Drizzle over M9's tables in prod; in-memory slice in tests). */
  store?: AssessmentReaderStore;
}

/**
 * Register M9's two §4.7 / D7 owned seams into the M1 registry over their boot deny-stubs (M9-T04;
 * before validateSeams()). Both share one {@link AssessmentReaderStore} so a single Drizzle adapter
 * backs the whole assessment read surface. Called by the composition root's wireModuleSeams().
 */
export function registerAssessmentSeams(deps: AssessmentSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryAssessmentReaderStore().store;
  registerSeam("LatestAssessmentProvider", createLatestAssessmentProvider(store));
  registerSeam("ScaleSeriesProvider", createScaleSeriesProvider(store));
}

/** Typed resolver for M9's LatestAssessmentProvider (sound: registered real impl; validateSeams guards it). */
export function getLatestAssessmentProvider(): LatestAssessmentProvider {
  return getSeam("LatestAssessmentProvider");
}

/** Typed resolver for M9's ScaleSeriesProvider. */
export function getScaleSeriesProvider(): ScaleSeriesProvider {
  return getSeam("ScaleSeriesProvider");
}
