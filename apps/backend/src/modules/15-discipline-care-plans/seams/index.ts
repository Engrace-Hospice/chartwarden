// apps/backend/src/modules/15-discipline-care-plans/seams — M15's §4.3 owned seams (M15-T05) + the barrel over
// the consumed side (`./consumed.ts`, M15-T03).
//
// M15 publishes SEVEN leaf-typed READ surfaces forward consumers attach to instead of importing M15's schema
// (architecture §25.15 blocks the schema import):
//
//   • `DisciplinePlanReader`         — the plan read path M14 (IDG one-pager), M22 (plan PDF), M28 (FHIR
//                                      `CarePlan`), M31 (portal) and M33 (dashboards) consume;
//   • `MswRiskFactorReader`          — the psychosocial factors M16's bereavement rubric SCORES (§1.2);
//   • `VolunteerComplianceProvider`  — **LOCKED** in `@wardenx/types/scheduling` by M17 (M17-F06/ADR-0009).
//                                      Registering it CLOSES M17's Wave-F volunteer-gate deny-stub — the D8
//                                      pre-schedule predicate 6 (`VOLUNTEER_GATE_UNMET`, 42 CFR §418.78(b));
//   • `SupervisoryCadenceReader`     — **LOCKED** likewise, per-ADMISSION. Registering it CLOSES M17's
//                                      Wave-F supervisory-advisory deny-stub (day view + propose-from-frequency);
//   • `VolunteerGateExpiryReader`    — the additive 418.78 expiry sweep the two locked contracts do not cover;
//   • `SupervisoryCadencePlanReader` — the additive per-PLAN cadence state + overdue worklist (M14, M30);
//   • `DisciplineComplianceProvider` — the M30 HQRP measure inputs + M33 operational rollups.
//
// `registerDisciplinePlanSeams` registers all seven real impls over their boot deny-stubs (before
// validateSeams()), driven from the composition root's wireModuleSeams(). All seven share ONE injected
// DisciplinePlanSeamStore (in-memory slice here; Drizzle in prod, reads under the consumer's RLS) — mirrors the
// M9…M14/M17/M18 seams/index.ts precedents. None is a mutate path: M15 owns the plan, supervisory and volunteer
// lifecycles internally.
import type {
  DisciplineComplianceProvider,
  DisciplinePlanReader,
  IsoInstant,
  MswRiskFactorReader,
  SupervisoryCadencePlanReader,
  SupervisoryCadenceReader,
  VolunteerComplianceProvider,
  VolunteerGateExpiryReader,
} from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import {
  DEFAULT_ORG_TIME_ZONE,
  type SeamClock,
  createDisciplineComplianceProvider,
  createDisciplinePlanReader,
  createMswRiskFactorReader,
  createSupervisoryCadencePlanReader,
  createSupervisoryCadenceReader,
  createVolunteerComplianceProvider,
  createVolunteerGateExpiryReader,
} from "./providers";
import { type DisciplinePlanSeamStore, createInMemoryDisciplinePlanSeamStore } from "./store";

export { getCarePlanReader, getSignedEncountersReader } from "./consumed";
export {
  type DrizzleDisciplinePlanSeamDeps,
  createDrizzleDisciplinePlanSeamStore,
} from "./drizzle-store";
export {
  type DisciplineComplianceCounts,
  type DisciplinePlanSeamSeed,
  type DisciplinePlanSeamSeedPlan,
  type DisciplinePlanSeamStore,
  type RateCounts,
  type SupervisoryClockRow,
  type VolunteerHourTotals,
  createInMemoryDisciplinePlanSeamStore,
} from "./store";
export {
  DEFAULT_ORG_TIME_ZONE,
  type SeamClock,
  createDisciplineComplianceProvider,
  createDisciplinePlanReader,
  createMswRiskFactorReader,
  createSupervisoryCadencePlanReader,
  createSupervisoryCadenceReader,
  createVolunteerComplianceProvider,
  createVolunteerGateExpiryReader,
  orgLocalDateOf,
  rateOf,
} from "./providers";

/** Deps for M15's owned-seam registration (slice defaults to the in-memory store + the real clock). */
export interface DisciplinePlanSeamDeps {
  /** The §4.3 data port (Drizzle over M15's tables in prod; in-memory slice in tests). */
  store?: DisciplinePlanSeamStore;
  /** Injected clock — every cadence/expiry derivation runs against it, so seam reads are testable. */
  clock?: SeamClock;
  /** The org's timezone for the LOCKED per-admission cadence DATE (M2 `organization.timezone`, D8). */
  timeZone?: string;
}

/**
 * Register M15's seven §4.3 owned seams into the M1 registry over their boot deny-stubs (M15-T05; before
 * validateSeams()). All seven share one {@link DisciplinePlanSeamStore} so a single Drizzle adapter backs the
 * whole plan + risk-factor + supervisory + volunteer read surface. Called by the composition root's
 * wireModuleSeams().
 *
 * Registering the two LOCKED contracts CLOSES M17's Wave-F deny-stubs: from here a `volunteer_visit` schedule
 * resolves the REAL 418.78 gate rather than denying loudly, and the day view's supervisory advisory reads
 * M15's cadence.
 */
export function registerDisciplinePlanSeams(deps: DisciplinePlanSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryDisciplinePlanSeamStore().store;
  const clock: SeamClock = deps.clock ?? (() => new Date().toISOString() as IsoInstant);
  const timeZone = deps.timeZone ?? DEFAULT_ORG_TIME_ZONE;

  registerSeam("DisciplinePlanReader", createDisciplinePlanReader(store));
  registerSeam("MswRiskFactorReader", createMswRiskFactorReader(store));
  // The two LOCKED M17 contracts — this is the M15-T05 bind that closes the Wave-F deny-stubs.
  registerSeam("VolunteerComplianceProvider", createVolunteerComplianceProvider(store, clock));
  registerSeam("SupervisoryCadenceReader", createSupervisoryCadenceReader(store, timeZone));
  registerSeam("VolunteerGateExpiryReader", createVolunteerGateExpiryReader(store, clock));
  registerSeam("SupervisoryCadencePlanReader", createSupervisoryCadencePlanReader(store, clock));
  registerSeam("DisciplineComplianceProvider", createDisciplineComplianceProvider(store));
}

/** Typed resolver for M15's DisciplinePlanReader (M14 IDG packet + M22/M28/M31/M33 consume the read seam). */
export function getDisciplinePlanReader(): DisciplinePlanReader {
  return getSeam("DisciplinePlanReader");
}

/** Typed resolver for M15's MswRiskFactorReader (M16's bereavement risk rubric consumes the read seam). */
export function getMswRiskFactorReader(): MswRiskFactorReader {
  return getSeam("MswRiskFactorReader");
}

/** Typed resolver for the LOCKED VolunteerComplianceProvider (M17's D8 pre-schedule gate predicate 6). */
export function getVolunteerComplianceProvider(): VolunteerComplianceProvider {
  return getSeam("VolunteerComplianceProvider");
}

/** Typed resolver for the LOCKED per-admission SupervisoryCadenceReader (M17 day view / propose worker). */
export function getSupervisoryCadenceReader(): SupervisoryCadenceReader {
  return getSeam("SupervisoryCadenceReader");
}

/** Typed resolver for M15's VolunteerGateExpiryReader (coordinator worklist + the §4.7 M36 alerts). */
export function getVolunteerGateExpiryReader(): VolunteerGateExpiryReader {
  return getSeam("VolunteerGateExpiryReader");
}

/** Typed resolver for M15's per-plan SupervisoryCadencePlanReader (M14 dashboard + M30 supervisory measure). */
export function getSupervisoryCadencePlanReader(): SupervisoryCadencePlanReader {
  return getSeam("SupervisoryCadencePlanReader");
}

/** Typed resolver for M15's DisciplineComplianceProvider (M30 HQRP measures + M33 dashboards). */
export function getDisciplineComplianceProvider(): DisciplineComplianceProvider {
  return getSeam("DisciplineComplianceProvider");
}
