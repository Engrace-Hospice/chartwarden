// apps/backend/src/modules/07-care-plan/seams — M7's published §7.8 CarePlanReader seam (M7-T04). M7
// publishes ONE leaf-typed read-only DTO surface every downstream clinical module consumes instead of
// importing M7's schema (architecture §11 blocks the schema import): M8 (encounter authoring picker +
// the encounter-sign overdue gate), M14 (IDG packet), M15 (discipline care plans). `registerCarePlanSeams`
// registers the real reader over its boot deny-stub (before validateSeams()), driven from the
// composition root's wireModuleSeams(). The reader is pure orchestration over an injected
// CarePlanReaderStore (in-memory slice here; Drizzle in prod, reads under the consumer's RLS).
import type { CarePlanReader } from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import { type NowClock, createCarePlanReader } from "./reader";
import { type CarePlanReaderStore, createInMemoryCarePlanReaderStore } from "./store";

export {
  type CarePlanClockRecord,
  type CarePlanElementsRecord,
  type CarePlanReaderSeed,
  type CarePlanReaderStore,
  type StoredRelevantProblem,
  createInMemoryCarePlanReaderStore,
} from "./store";
export { type NowClock, createCarePlanReader } from "./reader";
// FY2027 — the election statement addendum's M7 sources (42 CFR 418.24(c)(4)–(5)).
export {
  UNRELATED_PROBLEM_REASON,
  createAddendumDiagnosesReader,
  createUnrelatedProblemItemsReader,
} from "./addendum-sources";
// TASK-002 — the FULL Drizzle-backed store (no in-memory fallback); the composition root binds it as
// `registerCarePlanSeams({ store: createDrizzleCarePlanReaderStore(db) })` (the M8 pattern).
export {
  type ClaimDiagnosisRecord,
  type ClaimDiagnosisResult,
  claimDiagnosesForOrg,
  createDrizzleCarePlanReaderStore,
  type IdgPacketCarePlanContext,
  activeProblemIdsForOrg,
  idgPacketCarePlanContextForOrg,
} from "./drizzle-store";

/** Deps for M7's reader-seam registration (slice defaults to the in-memory store + real clock). */
export interface CarePlanSeamDeps {
  /** The §7.8 data port (Drizzle over M7's tables in prod; in-memory slice in tests). */
  store?: CarePlanReaderStore;
  /** Injected wall clock for the overdue gate (deterministic in tests; real time in prod). */
  now?: NowClock;
}

/**
 * Register M7's §7.8 CarePlanReader into the M1 registry over its boot deny-stub (M7-T04; before
 * validateSeams()). Called by the composition root's wireModuleSeams().
 */
export function registerCarePlanSeams(deps: CarePlanSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryCarePlanReaderStore().store;
  registerSeam("CarePlanReader", createCarePlanReader(store, deps.now));
}

/** Typed resolver for M7's CarePlanReader (sound: registered real impl; validateSeams guards it). */
export function getCarePlanReader(): CarePlanReader {
  return getSeam("CarePlanReader");
}
