// apps/backend/src/modules/16-bereavement/seams — M16's §4.6 / D13 owned seams (M16-T05) + the barrel over
// the consumed side (`./consumed.ts`, M16-T03/T04).
//
// M16 publishes SEVEN surfaces forward consumers attach to instead of importing M16's schema (architecture
// §25.15 blocks the schema import):
//
//   • `BereavementPlanProvider`        — the plan header + roster + closeout rollup M28 (FHIR `CarePlan`),
//                                        M30 (HQRP), M31 (portal), M33 (dashboards) and M36 (bereavement
//                                        channel membership + `archives_at`) consume;
//   • `BereavementOutreachProvider`    — the touchpoint reads + the CoP 418.64(d) counts (M30, M33);
//   • `BereavementRiskFactorsProvider` — the D3/D17 factor snapshot M32 narrates from, the deterministic
//                                        score, and the Layer-2 write-back (the ONE write in the set);
//   • `BereavementAssignmentReader`    — who is on the hook for a plan (M36's recipient resolver) + the
//                                        counselor caseload;
//   • `BereavedPortalScopeProvider`    — what an M31 bereaved-family session may see (§1.2 / D10 narrow);
//   • `BereavementComplianceProvider`  — the M30 HQRP measure inputs + M33 rollups, as COUNTS;
//   • `BereavementRiskTierProvider`    — the tier distribution M30's chart and M33's dashboard read.
//
// `registerBereavementSeams` registers all seven real impls over their boot deny-stubs (before
// validateSeams()), driven from the composition root's `wireModuleSeams()`. All seven share ONE injected
// {@link BereavementSeamStore} (in-memory slice here; the Drizzle adapter lands with M16's routes in T06) —
// the M9…M15/M17/M18 seams/index.ts precedent verbatim.
//
// Unlike M15-T05, registering these CLOSES no live deny-stub today: M30's `QualityBereavementConsumer` and
// M33's `ReportingBereavementConsumer` are FORWARD-seam stubs inside their own packages, and flipping them to
// resolve through the M1 registry is an M30/M33 wiring change (the M26 precedent, PRs #129/#130), not M16's.
// What lands here is the producer side: the contracts are real, registered and boot-validated, so those binds
// have something to attach to.
import type {
  BereavedPortalScopeProvider,
  BereavementAssignmentReader,
  BereavementComplianceProvider,
  BereavementOutreachProvider,
  BereavementPlanProvider,
  BereavementRiskFactorsProvider,
  BereavementRiskTierProvider,
  IsoInstant,
} from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import {
  type BereavementSeamClock,
  createBereavedPortalScopeProvider,
  createBereavementAssignmentReader,
  createBereavementComplianceProvider,
  createBereavementOutreachProvider,
  createBereavementPlanProvider,
  createBereavementRiskFactorsProvider,
  createBereavementRiskTierProvider,
} from "./providers";
import { type BereavementSeamStore, createInMemoryBereavementSeamStore } from "./store";

export {
  getAdmissionStatusReader,
  getBereavementEncounterReader,
  getDeathDischargeReader,
  getMswRiskFactorReader,
  getPatientReader,
  getScaleSeriesProvider,
  getVolunteerComplianceProvider,
} from "./consumed";
export { createDrizzleBereavementSeamStore } from "./drizzle-store";
export {
  type BereavementAugmentedScoreDraft,
  type BereavementClosureFacts,
  type BereavementPlanFacts,
  type BereavementRiskScoreFacts,
  type BereavementSeamSeed,
  type BereavementSeamStore,
  type BereavedPortalRow,
  COP_DENOMINATOR_STATUSES,
  COP_NUMERATOR_STATUSES,
  EMPTY_CLOSURE_COUNTS,
  EMPTY_OUTREACH_STATUS_COUNTS,
  EMPTY_TIER_DISTRIBUTION,
  createInMemoryBereavementSeamStore,
} from "./store";
export {
  type BereavementSeamClock,
  applyOutreachFilters,
  createBereavedPortalScopeProvider,
  createBereavementAssignmentReader,
  createBereavementComplianceProvider,
  createBereavementOutreachProvider,
  createBereavementPlanProvider,
  createBereavementRiskFactorsProvider,
  createBereavementRiskTierProvider,
  isPlanInWindow,
  planViewOf,
} from "./providers";

/** Deps for M16's owned-seam registration (slice defaults to the in-memory store + the real clock). */
export interface BereavementSeamDeps {
  /** The §4.6 data port (Drizzle over M16's tables in prod; in-memory slice in tests). */
  store?: BereavementSeamStore;
  /** Injected clock — the D4 window and the D9 rescind window both derive "now" from it, so seam reads are
   *  deterministic under test and a frozen clock cannot disagree with itself across two seams. */
  clock?: BereavementSeamClock;
}

/**
 * Register M16's seven §4.6 owned seams into the M1 registry over their boot deny-stubs (M16-T05; before
 * validateSeams()). All seven share one {@link BereavementSeamStore} so a single Drizzle adapter backs the
 * whole plan + outreach + risk + portal read surface. Called by the composition root's `wireModuleSeams()`.
 */
export function registerBereavementSeams(deps: BereavementSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryBereavementSeamStore().store;
  const clock: BereavementSeamClock = deps.clock ?? (() => new Date().toISOString() as IsoInstant);

  registerSeam("BereavementPlanProvider", createBereavementPlanProvider(store));
  registerSeam("BereavementOutreachProvider", createBereavementOutreachProvider(store));
  registerSeam(
    "BereavementRiskFactorsProvider",
    createBereavementRiskFactorsProvider(store, clock),
  );
  registerSeam("BereavementAssignmentReader", createBereavementAssignmentReader(store));
  registerSeam("BereavedPortalScopeProvider", createBereavedPortalScopeProvider(store, clock));
  registerSeam("BereavementComplianceProvider", createBereavementComplianceProvider(store));
  registerSeam("BereavementRiskTierProvider", createBereavementRiskTierProvider(store));
}

/** Typed resolver for M16's BereavementPlanProvider (M28/M30/M31/M33/M36 consume the plan read seam). */
export function getBereavementPlanProvider(): BereavementPlanProvider {
  return getSeam("BereavementPlanProvider");
}

/** Typed resolver for M16's BereavementOutreachProvider (M30's CoP rate + M33's operational dashboard). */
export function getBereavementOutreachProvider(): BereavementOutreachProvider {
  return getSeam("BereavementOutreachProvider");
}

/** Typed resolver for M16's BereavementRiskFactorsProvider (M32's Layer-2 read + write-back; M30/M33 reads). */
export function getBereavementRiskFactorsProvider(): BereavementRiskFactorsProvider {
  return getSeam("BereavementRiskFactorsProvider");
}

/** Typed resolver for M16's BereavementAssignmentReader (M36's recipient resolver, M3's ABAC predicate). */
export function getBereavementAssignmentReader(): BereavementAssignmentReader {
  return getSeam("BereavementAssignmentReader");
}

/** Typed resolver for M16's BereavedPortalScopeProvider (M31's bereaved-family session class). */
export function getBereavedPortalScopeProvider(): BereavedPortalScopeProvider {
  return getSeam("BereavedPortalScopeProvider");
}

/** Typed resolver for M16's BereavementComplianceProvider (M30 HQRP CoP 418.64(d) + M33 rollups). */
export function getBereavementComplianceProvider(): BereavementComplianceProvider {
  return getSeam("BereavementComplianceProvider");
}

/** Typed resolver for M16's BereavementRiskTierProvider (M30's tier chart + M33's dashboard). */
export function getBereavementRiskTierProvider(): BereavementRiskTierProvider {
  return getSeam("BereavementRiskTierProvider");
}
