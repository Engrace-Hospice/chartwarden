// apps/backend/src/modules/14-idg/seams — M14's published §4.8 owned seams (M14-T05). M14 publishes THREE
// leaf-typed READ surfaces forward consumers attach to instead of importing M14's schema (architecture §25.15
// blocks the schema import): `IdgPacketProvider` — the packet-snapshot + M22 render handshake M22 (minutes /
// packet PDF) + M33 (dashboards) consume; `IdgDecisionProvider` — the decision read path M30
// (decision-to-careplan-update latency measure) + M33 consume; `IdgScheduleProvider` — the meeting-schedule +
// 15-day-cadence read path M28 (FHIR `CareTeam`/`Encounter`) + M30 (cadence-adherence measure) + M33 consume.
// `registerIdgSeams` registers all three real impls over their boot deny-stubs (before validateSeams()), driven
// from the composition root's wireModuleSeams(). All three share ONE injected IdgSeamStore (in-memory slice
// here; Drizzle in prod, reads under the consumer's RLS) — mirrors the M9/M10/M11/M12/M13 seams/index.ts
// precedents. None is a mutate path: M14 owns the meeting/decision/packet lifecycle internally.
import type { IdgDecisionProvider, IdgPacketProvider, IdgScheduleProvider } from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import {
  createIdgDecisionProvider,
  createIdgPacketProvider,
  createIdgScheduleProvider,
} from "./providers";
import { type IdgSeamStore, createInMemoryIdgSeamStore } from "./store";

export {
  type IdgCadenceAdherence,
  type IdgDecisionSeedRow,
  type IdgSeamSeed,
  type IdgSeamStore,
  type StoredIdgPacket,
  createInMemoryIdgSeamStore,
} from "./store";
export {
  createIdgDecisionProvider,
  createIdgPacketProvider,
  createIdgScheduleProvider,
} from "./providers";

/** Deps for M14's owned-seam registration (slice defaults to the in-memory store). */
export interface IdgSeamDeps {
  /** The §4.8 data port (Drizzle over M14's tables in prod; in-memory slice in tests). */
  store?: IdgSeamStore;
}

/**
 * Register M14's three §4.8 owned seams into the M1 registry over their boot deny-stubs (M14-T05; before
 * validateSeams()). All three share one {@link IdgSeamStore} so a single Drizzle adapter backs the whole
 * packet + decision + schedule read surface. Called by the composition root's wireModuleSeams().
 */
export function registerIdgSeams(deps: IdgSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryIdgSeamStore().store;
  registerSeam("IdgPacketProvider", createIdgPacketProvider(store));
  registerSeam("IdgDecisionProvider", createIdgDecisionProvider(store));
  registerSeam("IdgScheduleProvider", createIdgScheduleProvider(store));
}

/** Typed resolver for M14's IdgPacketProvider (M22 render + M33 consume the read seam). */
export function getIdgPacketProvider(): IdgPacketProvider {
  return getSeam("IdgPacketProvider");
}

/** Typed resolver for M14's IdgDecisionProvider (M30 decision-latency measure + M33 consume the read seam). */
export function getIdgDecisionProvider(): IdgDecisionProvider {
  return getSeam("IdgDecisionProvider");
}

/** Typed resolver for M14's IdgScheduleProvider (M28 FHIR + M30 cadence measure + M33 consume the read seam). */
export function getIdgScheduleProvider(): IdgScheduleProvider {
  return getSeam("IdgScheduleProvider");
}
