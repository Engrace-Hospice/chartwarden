// apps/backend/src/modules/20-field-safety/seams — M20's seam boundary.
//
// `./consumed` (M20-T04) holds the §4.4 accessors for the seams M20 READS: M17's `VisitReader` /
// `VisitAssignmentReader`, M18's `EvvLocationProvider`, M19's `OnCallProvider` and M5's `PatientReader`.
//
// The SEVEN §4.3 seams M20 PUBLISHES land here at M20-T05:
//
//   • `SafetyDashboardProvider` — the supervisor live-awareness board, also embedded by M17's visit-day
//                                 view (§4.2);
//   • `SafetyContextReader`     — M8's "was there an incident during the visit I am documenting?";
//   • `SafetyIncidentReader`    — M32's §8.6 minimum-necessary projection (rounded coordinates only);
//   • `SafetyMetricsProvider`   — M30/M33 aggregates, every rate WITH its denominator;
//   • `SafetyCheckInProvider`   — M17's per-visit pre/mid/post badge trio;
//   • `SafetyPolicyProvider`    — the ONLY read path to the effective policy (§2.2.4), incl. the replay
//                                 arm M19 reads for its after-hours-window default;
//   • `SafetySupervisorProvider`— who gets paged + the §7.8 coverage gaps, the M20 half of §4.5.
//
// `registerFieldSafetySeams` registers all seven real impls over their boot deny-stubs (before
// validateSeams()), driven from the composition root's `wireModuleSeams()`. All seven share ONE injected
// {@link SafetySeamStore} — the Drizzle adapter in production (`./store-drizzle`), an in-memory slice for
// tests — the M9…M19 / M21 seams/index.ts precedent.
//
// WITHOUT A DB CLIENT THIS REGISTERS NOTHING, exactly as M19-T06 decided for the same reason. A slice
// store answers `[]` for `coverageGapsForOrg` and an empty `clinicians` array for the board, and both of
// those are REAL answers: "nobody is uncovered" and "nobody is in the field". Standing an empty slice
// over the deny-stubs at a DB-less boot would manufacture "everyone is fine" out of a missing database,
// on the one surface where that is the worst possible lie. The deny-stubs throw, so a consumer sees "M20
// cannot answer" — which is the truth. Tests inject their own store explicitly and get the real impls.
import type {
  IsoInstant,
  SafetyCheckInProvider,
  SafetyContextReader,
  SafetyDashboardProvider,
  SafetyIncidentReader,
  SafetyMetricsProvider,
  SafetyPolicyProvider,
  SafetySupervisorProvider,
} from "@chartwarden/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import type { SafetyClinicianSignalCache } from "../consumers/m18-gps-spoof";
import {
  type SafetyCoordinateDecipher,
  type SafetySeamOrgResolver,
  type SafetySeamTimeZoneResolver,
  createSafetyCheckInProvider,
  createSafetyContextReader,
  createSafetyDashboardProvider,
  createSafetyIncidentReader,
  createSafetyMetricsProvider,
  createSafetyPolicyProvider,
  createSafetySupervisorProvider,
} from "./providers";
import type { SafetySeamStore } from "./store";

export {
  getEvvLocationProvider,
  getOnCallProvider,
  getPatientReader,
  getVisitAssignmentReader,
  getUpcomingVisitReader,
  getVisitReader,
} from "./consumed";
export {
  type SafetyEmergencyContactRead,
  emergencyContactConsentPresent,
  emergencyContactReadFrom,
  readEmergencyContact,
} from "./emergency-contact";
export {
  type InMemorySafetySeamStore,
  type SafetyClinicianBoardFacts,
  type SafetyEmergencyContactFacts,
  type SafetyIncidentGeoFacts,
  type SafetyIncidentSummaryFacts,
  type SafetySeamSeed,
  type SafetySeamStore,
  type SafetySosAfterHoursSample,
  type SafetyVisitScheduleFacts,
  createInMemorySafetySeamStore,
} from "./store";
export { buildDrizzleSafetySeamStore } from "./store-drizzle";
export {
  type SafetyCoordinateDecipher,
  type SafetySeamOrgResolver,
  type SafetySeamTimeZoneResolver,
  assertCallerOrg,
  checkInBadgeForState,
  createSafetyCheckInProvider,
  createSafetyContextReader,
  createSafetyDashboardProvider,
  createSafetyIncidentReader,
  createSafetyMetricsProvider,
  createSafetyPolicyProvider,
  createSafetySupervisorProvider,
  defaultSafetySeamOrgResolver,
  incidentSummaryOf,
  percentileOf,
  perHundredVisits,
  pointInPolygon,
  rateOf,
  roundCoordinates,
  supervisorRecipientsFrom,
  visitCheckInBadges,
} from "./providers";

/** Deps for M20's owned-seam registration. */
export interface FieldSafetySeamDeps {
  /** The §4.3 data port (Drizzle over M20's thirteen tables in prod; an in-memory slice in tests).
   *  Absent ⇒ the registration is a NO-OP and the fail-closed deny-stubs stand (see the header). */
  store?: SafetySeamStore;
  /** The caller's org, for the `assertCallerOrg` check. Defaults to the ambient request context. */
  orgOf?: SafetySeamOrgResolver;
  /** The org's IANA zone for the D14 after-hours metric. Absent ⇒ `getAfterHoursSosCount` REFUSES
   *  rather than counting against UTC (see ./providers.ts). */
  timeZoneOf?: SafetySeamTimeZoneResolver;
  /** §8.6 — opens `posted_coordinates_cipher` inside M20's boundary. Absent ⇒ `SafetyIncidentReader`
   *  refuses with `SAFETY_COORDINATE_DECIPHER_UNBOUND` rather than answering `roundedCoordinates: null`
   *  for every incident, which would read to M32 as "nothing happened there". */
  decipher?: SafetyCoordinateDecipher;
  /** §7.7 — the M18 GPS-spoof badge cache the board reads. Absent ⇒ no badge is shown (the documented
   *  cost of holding the suspicion in memory: a MISSING caveat, never a missing alert). */
  signals?: SafetyClinicianSignalCache;
  /** Injected clock, so the seam reads are deterministic in tests. */
  now?: () => IsoInstant;
}

/**
 * Register M20's seven §4.3 owned seams into the M1 registry over their boot deny-stubs (M20-T05; before
 * validateSeams()). All seven share one {@link SafetySeamStore}. Called by the composition root's
 * `wireModuleSeams()`. With no store, registers nothing — see the header.
 */
export function registerFieldSafetySeams(deps: FieldSafetySeamDeps = {}): void {
  const store = deps.store;
  if (store === undefined) return;

  registerSeam("SafetyPolicyProvider", createSafetyPolicyProvider(store, deps.orgOf, deps.now));
  registerSeam(
    "SafetySupervisorProvider",
    createSafetySupervisorProvider(store, deps.orgOf, deps.now),
  );
  registerSeam("SafetyContextReader", createSafetyContextReader(store, deps.orgOf));
  registerSeam("SafetyCheckInProvider", createSafetyCheckInProvider(store, deps.orgOf));
  registerSeam(
    "SafetyIncidentReader",
    createSafetyIncidentReader(store, deps.orgOf, deps.decipher),
  );
  registerSeam(
    "SafetyMetricsProvider",
    createSafetyMetricsProvider(store, deps.orgOf, deps.timeZoneOf),
  );
  registerSeam(
    "SafetyDashboardProvider",
    createSafetyDashboardProvider(store, deps.orgOf, deps.signals),
  );
}

/** Typed resolver for M20's SafetyDashboardProvider (M17's visit-day board embed, M20's own §5 screens). */
export function getSafetyDashboardProvider(): SafetyDashboardProvider {
  return getSeam("SafetyDashboardProvider");
}

/** Typed resolver for M20's SafetyContextReader (M8's encounter-authoring safety context). */
export function getSafetyContextReader(): SafetyContextReader {
  return getSeam("SafetyContextReader");
}

/** Typed resolver for M20's SafetyIncidentReader (M32's §8.6 high-risk-area suggestion input). */
export function getSafetyIncidentReader(): SafetyIncidentReader {
  return getSeam("SafetyIncidentReader");
}

/** Typed resolver for M20's SafetyMetricsProvider (M30 measures, M33 dashboards). */
export function getSafetyMetricsProvider(): SafetyMetricsProvider {
  return getSeam("SafetyMetricsProvider");
}

/** Typed resolver for M20's SafetyCheckInProvider (M17's per-visit badge trio). */
export function getSafetyCheckInProvider(): SafetyCheckInProvider {
  return getSeam("SafetyCheckInProvider");
}

/** Typed resolver for M20's SafetyPolicyProvider (M19's after-hours default, M20's own workers). */
export function getSafetyPolicyProvider(): SafetyPolicyProvider {
  return getSeam("SafetyPolicyProvider");
}

/** Typed resolver for M20's SafetySupervisorProvider (M36's §4.5 composed resolver, §7.8 watchdog). */
export function getSafetySupervisorProvider(): SafetySupervisorProvider {
  return getSeam("SafetySupervisorProvider");
}
