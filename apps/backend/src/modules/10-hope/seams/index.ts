// apps/backend/src/modules/10-hope/seams — M10's published §2 / D10 owned seams (M10-T05). M10 publishes
// THREE leaf-typed read-only DTO surfaces downstream modules consume instead of importing M10's schema
// (architecture §11 blocks the schema import): HopeTimepointProvider (M14 open HOPE windows on the IDG
// packet, M22 per-admission timeline PDF, M30 on-time rate, M32 decline-prediction), HopeJ2051Provider
// (M30 Timely-Follow-Up, M32 symptom-trajectory) and HopeSubmissionProvider (M30 acceptance posture /
// HQRP counter, M33 submission dashboards). `registerHopeSeams` registers all three real impls over their
// boot deny-stubs (before validateSeams()), driven from the composition root's wireModuleSeams(). All
// three share ONE injected HopeSeamStore (in-memory slice here; Drizzle in prod, reads under the
// consumer's RLS) — mirrors the M9 seams/index.ts precedent.
import type {
  HopeJ2051Provider,
  HopeSubmissionProvider,
  HopeTimepointProvider,
} from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import {
  createHopeJ2051Provider,
  createHopeSubmissionProvider,
  createHopeTimepointProvider,
} from "./providers";
import { type HopeSeamStore, createInMemoryHopeSeamStore } from "./store";

export {
  type HopeSeamSeed,
  type HopeSeamStore,
  createInMemoryHopeSeamStore,
} from "./store";
export {
  createHopeJ2051Provider,
  createHopeSubmissionProvider,
  createHopeTimepointProvider,
} from "./providers";

/** Deps for M10's owned-seam registration (slice defaults to the in-memory store). */
export interface HopeSeamDeps {
  /** The §2 / D10 data port (Drizzle over M10's tables in prod; in-memory slice in tests). */
  store?: HopeSeamStore;
}

/**
 * Register M10's three §2 / D10 owned seams into the M1 registry over their boot deny-stubs (M10-T05;
 * before validateSeams()). All three share one {@link HopeSeamStore} so a single Drizzle adapter backs the
 * whole HOPE read surface. Called by the composition root's wireModuleSeams().
 */
export function registerHopeSeams(deps: HopeSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryHopeSeamStore().store;
  registerSeam("HopeTimepointProvider", createHopeTimepointProvider(store));
  registerSeam("HopeJ2051Provider", createHopeJ2051Provider(store));
  registerSeam("HopeSubmissionProvider", createHopeSubmissionProvider(store));
}

/** Typed resolver for M10's HopeTimepointProvider (sound: registered real impl; validateSeams guards it). */
export function getHopeTimepointProvider(): HopeTimepointProvider {
  return getSeam("HopeTimepointProvider");
}

/** Typed resolver for M10's HopeJ2051Provider. */
export function getHopeJ2051Provider(): HopeJ2051Provider {
  return getSeam("HopeJ2051Provider");
}

/** Typed resolver for M10's HopeSubmissionProvider. */
export function getHopeSubmissionProvider(): HopeSubmissionProvider {
  return getSeam("HopeSubmissionProvider");
}
