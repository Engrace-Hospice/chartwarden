// apps/backend/src/modules/19-oncall/seams — M19's §4.3 owned seams (M19-T06) + the barrel over the
// consumed side (`./consumed.ts`, M19-T04/T05).
//
// M19 publishes FIVE read surfaces forward consumers attach to instead of importing M19's schema
// (architecture §25.15 blocks the schema import):
//
//   • `OnCallProvider`             — who is on call NOW for a ProviderEntity, and the active shifts M36's
//                                    `on_call` channel synchronizer re-syncs membership from (§4.5). M20's
//                                    after-hours SOS parallel recipient (M20 §7.5 D14) resolves here too;
//   • `TriageCallReader`           — M32's PHI-free feature read + M14's since-last-IDG digest;
//   • `TriageCallProvider`         — M14's full packet slice + M11's verbal-order → triage-context lookup;
//   • `PortalTriageReader`         — the ONLY M19 surface M31's portal may reach (lay-language, scrubbed);
//   • `TriageCallMetricsProvider`  — M30/M33 operational + quality measures, as rates AND the counts
//                                    behind them (never a bare rate — M30 owns the small-N suppression).
//
// `registerOncallSeams` registers all five real impls over their boot deny-stubs (before validateSeams()),
// driven from the composition root's `wireModuleSeams()`. All five share ONE injected
// {@link OncallSeamStore} — the Drizzle adapter in production (`./store-drizzle`), an in-memory slice for
// tests — the M9…M18 / M21 seams/index.ts precedent.
//
// WITHOUT A DB CLIENT THIS REGISTERS NOTHING, and that is the one place M19 departs from the M21 shape.
// A slice store answers `[]` for `currentOnCallActors`, and `[]` from that seam is a REAL answer: it means
// nobody is covering, the fact the §4.8 watchdog and M36's escalation routing both act on. Standing an
// empty slice over the deny-stub at a DB-less boot would manufacture a coverage gap out of a missing
// database. The deny-stubs throw, so a consumer sees "M19 cannot answer" instead — which is the truth.
// Tests inject their own store explicitly and get the real impls.
import type {
  OnCallProvider,
  PortalTriageReader,
  TriageCallMetricsProvider,
  TriageCallProvider,
  TriageCallReader,
} from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import {
  type OncallSeamClock,
  type OncallSeamOrgResolver,
  createOnCallProvider,
  createPortalTriageReader,
  createTriageCallMetricsProvider,
  createTriageCallProvider,
  createTriageCallReader,
} from "./providers";
import type { OncallSeamStore } from "./store";

export {
  getEncounterCreator,
  getHospitalizationRiskProvider,
  getMedicationOrderProvider,
  getOrderProvider,
  getOrderSignatureProvider,
  getProtocolSuggestionProvider,
  getRefillInboxProvider,
  getVisitAssignmentReader,
  getVisitReader,
} from "./consumed";
export {
  EMPTY_MEASURE_COUNTS,
  type ChiefComplaintTally,
  type EscalationTierTally,
  type InMemoryOncallSeamStore,
  type OncallSeamSeed,
  type OncallSeamStore,
  type PortalTriageCallRow,
  type RnCoverageRead,
  type RnCoverageWindow,
  createInMemoryOncallSeamStore,
} from "./store";
export { buildDrizzleOncallSeamStore } from "./store-drizzle";
// F-218/F-219 — the one org-explicit GIP-proposal read M14 (flagged events) and M37 (intake worklist) share.
export {
  GIP_PROPOSALS_MAX_ROWS,
  IDG_TRIAGE_CHANGES_MAX_PATIENTS,
  type GipProposalFact,
  type IdgTriageCarePlanChangeEvent,
  gipProposalsForOrg,
  idgTriageCarePlanChangesForOrg,
} from "./gip-proposals-for-org";
export {
  PORTAL_DISPOSITION_LAY_SUMMARY,
  PORTAL_IN_PROGRESS_LAY_SUMMARY,
  type OncallSeamClock,
  type OncallSeamOrgResolver,
  actorsOfShift,
  assertCallerOrg,
  coverageGapMinutesOf,
  createOnCallProvider,
  createPortalTriageReader,
  createTriageCallMetricsProvider,
  createTriageCallProvider,
  createTriageCallReader,
  defaultOncallSeamClock,
  defaultOncallSeamOrgResolver,
  percentileOf,
  portalSummaryOf,
  rateOf,
} from "./providers";

/** Deps for M19's owned-seam registration. */
export interface OncallSeamDeps {
  /** The §4.3 data port (Drizzle over M19's tables in prod; an in-memory slice in tests). Absent ⇒ the
   *  registration is a NO-OP and the fail-closed deny-stubs stand (see the header). */
  store?: OncallSeamStore;
  /** The caller's org, for the `assertCallerOrg` check. Defaults to the ambient request context. */
  orgOf?: OncallSeamOrgResolver;
  /** Injected clock — the portal reader's look-back window derives "now" from it. */
  clock?: OncallSeamClock;
}

/**
 * Register M19's five §4.3 owned seams into the M1 registry over their boot deny-stubs (M19-T06; before
 * validateSeams()). All five share one {@link OncallSeamStore}. Called by the composition root's
 * `wireModuleSeams()`. With no store, registers nothing — see the header.
 */
export function registerOncallSeams(deps: OncallSeamDeps = {}): void {
  const store = deps.store;
  if (store === undefined) return;

  registerSeam("OnCallProvider", createOnCallProvider(store, deps.orgOf));
  registerSeam("TriageCallReader", createTriageCallReader(store, deps.orgOf));
  registerSeam("TriageCallProvider", createTriageCallProvider(store, deps.orgOf));
  registerSeam("PortalTriageReader", createPortalTriageReader(store, deps.orgOf, deps.clock));
  registerSeam("TriageCallMetricsProvider", createTriageCallMetricsProvider(store, deps.orgOf));
}

/** Typed resolver for M19's OnCallProvider (M36's `on_call` recipient resolver, M20's SOS recipient). */
export function getOnCallProvider(): OnCallProvider {
  return getSeam("OnCallProvider");
}

/** Typed resolver for M19's TriageCallReader (M32's feature read, M14's IDG digest). */
export function getTriageCallReader(): TriageCallReader {
  return getSeam("TriageCallReader");
}

/** Typed resolver for M19's TriageCallProvider (M14's packet slice, M11's verbal-order lookup). */
export function getTriageCallProvider(): TriageCallProvider {
  return getSeam("TriageCallProvider");
}

/** Typed resolver for M19's PortalTriageReader (M31's family care-log). */
export function getPortalTriageReader(): PortalTriageReader {
  return getSeam("PortalTriageReader");
}

/** Typed resolver for M19's TriageCallMetricsProvider (M30 measures, M33 dashboards). */
export function getTriageCallMetricsProvider(): TriageCallMetricsProvider {
  return getSeam("TriageCallMetricsProvider");
}
