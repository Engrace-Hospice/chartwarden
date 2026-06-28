// apps/backend/src/modules/08-encounters/seams — M8's published §4.7 owned seams + the M7 CarePlanReader
// it CONSUMES (M8-T08). M8 publishes FOUR leaf-typed surfaces every downstream module consumes instead
// of importing M8's schema (architecture §11 blocks the schema import): BillableEncounterReader (M23/M24
// claim-line eligibility), SignedEncountersReader (M14 IDG digests + M22 render payload), MileagePayrollReader
// (M27 payroll/AP, §4.5 D10), and EncounterCreator (M16 bereavement / M17 visit-seeding open a draft).
// `registerEncounterSeams` registers all four real impls over their boot deny-stubs (before
// validateSeams()), driven from the composition root's wireModuleSeams(). The impls are pure orchestration
// over an injected EncounterReaderStore (in-memory slice here; Drizzle in prod, under the consumer's RLS).
//
// M8 also CONSUMES M7's §7.8 CarePlanReader (the encounter authoring picker + the 5-/15-day overdue
// sign-gate): `getCarePlanReader()` resolves it from the M1 registry — a boot-validated seam, NOT a
// schema import — so the encounter routes (M8-T09) gate signing on the care-plan review window.
import type {
  BillableEncounterReader,
  CarePlanReader,
  EncounterCreator,
  EvvBracketResolver,
  MileagePayrollReader,
  SignedEncountersReader,
} from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import {
  createBillableEncounterReader,
  createEncounterCreator,
  createMileagePayrollReader,
  createSignedEncountersReader,
} from "./readers";
import { type EncounterReaderStore, createInMemoryEncounterReaderStore } from "./store";

export {
  type EncounterReaderSeed,
  type EncounterReaderStore,
  type StoredEncounterFacts,
  createInMemoryEncounterReaderStore,
} from "./store";
export { createDrizzleEncounterReaderStore } from "./drizzle-store";
export {
  EncounterNotFoundError,
  createBillableEncounterReader,
  createEncounterCreator,
  createMileagePayrollReader,
  createSignedEncountersReader,
  deriveBillability,
} from "./readers";

/** Deps for M8's owned-seam registration (slice defaults to the in-memory store). */
export interface EncounterSeamDeps {
  /** The §4.7 data port (Drizzle over M8's tables in prod; in-memory slice in tests). */
  store?: EncounterReaderStore;
}

/**
 * Register every M8 §4.7 owned seam into the M1 registry over its boot deny-stub (M8-T08; before
 * validateSeams()). All four share one {@link EncounterReaderStore} so a single Drizzle adapter backs
 * the whole encounter read/create surface. Called by the composition root's wireModuleSeams().
 */
export function registerEncounterSeams(deps: EncounterSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryEncounterReaderStore().store;
  registerSeam("BillableEncounterReader", createBillableEncounterReader(store));
  registerSeam("SignedEncountersReader", createSignedEncountersReader(store));
  registerSeam("MileagePayrollReader", createMileagePayrollReader(store));
  registerSeam("EncounterCreator", createEncounterCreator(store));
}

/** Typed resolver for M8's BillableEncounterReader (sound: registered real impl; validateSeams guards it). */
export function getBillableEncounterReader(): BillableEncounterReader {
  return getSeam("BillableEncounterReader");
}

/** Typed resolver for M8's SignedEncountersReader. */
export function getSignedEncountersReader(): SignedEncountersReader {
  return getSeam("SignedEncountersReader");
}

/** Typed resolver for M8's MileagePayrollReader. */
export function getMileagePayrollReader(): MileagePayrollReader {
  return getSeam("MileagePayrollReader");
}

/** Typed resolver for M8's EncounterCreator. */
export function getEncounterCreator(): EncounterCreator {
  return getSeam("EncounterCreator");
}

/** M8 CONSUMES M7's §7.8 CarePlanReader (encounter authoring picker + the overdue sign-gate). */
export function getCarePlanReader(): CarePlanReader {
  return getSeam("CarePlanReader");
}

/**
 * M8 CONSUMES M18's §4.7 EvvBracketResolver (the authoritative EVV bracket at finalize, D9). FORWARD
 * SEAM: deny-stubbed in the M1 registry until M18 lands (Wave F), so resolving it today returns the
 * fail-closed stub — M8's EVV-missing-documented fallback (route 10) is the operative path meanwhile.
 */
export function getEvvBracketResolver(): EvvBracketResolver {
  return getSeam("EvvBracketResolver");
}
