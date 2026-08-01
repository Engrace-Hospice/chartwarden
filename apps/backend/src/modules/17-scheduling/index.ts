// apps/backend/src/modules/17-scheduling — M17 (Scheduling & Route Optimization) backend module surface.
//
// M17-T05 lands the four §4.3 owned seams (VisitReader — the visit read path M8 (encounter-authoring context,
// which CLOSES M8's visit-seeding inert consumer M8 D9) / M18 (EVV geofence target) / M14 (IDG since-meeting)
// consume — + VisitAssignmentReader — the assignment read path M5 (§4.5 D11 caseload contribution) / M19
// (on-call) / M20 (field-safety) consume — + PortalVisitReader — the M31 portal upcoming-visit read path
// (lay-language, scrubbed) — + VisitMetricsProvider — the M30/M33 productivity + quality measures read path)
// registered into the M1 registry via `registerSchedulingSeams` (driven from the composition root's
// wireModuleSeams()). Routes / ABAC predicates / outbox / screens land in M17-T07/T08.
//
// M17-T06 lands the §4.4 CONSUMED surface: the M8-bidirectional `m8.encounter.signed` consumer (the visit's
// terminal completion, `consumers/index.ts`) + the typed accessors for the upstream reads M17 consumes — M8's
// `MileagePayrollReader`/`BillableEncounterReader` (Wave E, live) and M15's `VolunteerComplianceProvider`/
// `SupervisoryCadenceReader` (Phase 2, fail-closed deny-stubs per M17-F06/ADR-0009) — in `seams/consumed.ts`.
// M17-T07 lands the §4.10 D1 OSRM `RoutingProvider` adapter (`@wardenx/routing-client`), the §4.1 route
// inventory behind the M3 Authorization Contract over the §4.6 keys (`M17_CONTRIBUTED_PERMISSIONS`), and the
// four §4.7 pre-schedule ABAC predicates (`clinician_credentials_active` / `discipline_matches_visit` /
// `not_on_pto` / `within_caseload_or_unassigned_pool`). Route optimisation stays behind
// `scheduling.route_optimization` (OFF; §7.9 OSRM degraded mode is the Phase-1 path).
//
// M17-T08 lands the §4.11 outbox-event catalog (the full `m17.*` taxonomy — `events-by-m17.ts`; check-fitness-
// gaps.ts scans it for naming + ownership + declared consumers). **`m17.visit.published` wires LIVE M8's
// visit-seeding inert consumer (M8 D9); M18 consumes the bracket events; M5 reads the assigned/unassigned
// caseload-contribution stream (§4.5 D11).** M19/M31 (and the M15/M16 seam consumers) stay inert deny-stubs
// until Phase 2. It also lands the §4.9 M36 typed alert payloads (`alerts-by-m17.ts`; registered onto M36's
// Foundation registry at boot, composition + recipient resolution is M36's per ADR-0024) and the Track B §5.1
// web screens (apps/web/src/modules/17-scheduling, ADR-0030).
import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import { registerSchedulingAbacPredicates as _registerM17Abac } from "./abac-predicates";
import { registerSchedulingRoutes as _registerM17Routes } from "./routes/scheduling-routes";
import { createDbSchedulingBackend } from "./scheduling-route-service-db";

/**
 * M17L — mount the M17 scheduling routes over the PRODUCTION Drizzle backend (RLS-scoped under
 * `withOrgContext`). The scaffold uses ONE object as BOTH the route service AND the §4.7 ABAC resolver, so a
 * single `createDbSchedulingBackend(db)` serves both registrations. Reads are live (visit lists / day-week-map
 * views, proposal inbox, recurring cadences, availability, time-off, portal upcoming, metrics); writes fail-
 * closed 501 until the M17L write lifecycle lands. Replaces the in-memory clinical-core scaffold mount for M17.
 */
export function mountSchedulingRoutes(app: FastifyInstance, db: DbClient): void {
  const backend = createDbSchedulingBackend(db);
  _registerM17Abac({ resolver: backend });
  _registerM17Routes(app, { service: backend });
}

export { createDbSchedulingBackend } from "./scheduling-route-service-db";
export { M17_OUTBOX_EVENTS } from "./events-by-m17";
export { M17_ALERT_PAYLOADS } from "./alerts-by-m17";
export {
  type EncounterSignedConsumed,
  type VisitCompletionPlan,
  M17_OUTBOX_SUBSCRIPTIONS,
  planVisitCompletionFromEncounter,
} from "./consumers/index";
// M17-T07 — the four §4.7 pre-schedule ABAC predicate resolvers M17 owns + registers into M3.
export {
  type SchedulingAbacDeps,
  type SchedulingAbacResolver,
  M17_ABAC_PREDICATES,
  buildSchedulingAbacPredicates,
  registerSchedulingAbacPredicates,
} from "./abac-predicates";
// M17-T07 — the §4.1 route inventory over an in-memory backend + the route service contract (in-mem slice;
// Drizzle in prod under withOrgContext so RLS backstops). The service also implements SchedulingAbacResolver.
export { type SchedulingRouteDeps, registerSchedulingRoutes } from "./routes/scheduling-routes";
export {
  type AvailabilityView,
  type CreateRecurringInput,
  type CreateVisitInput,
  type EditVisitInput,
  type OptimizeDayInput,
  type ProposalView,
  type RecordedSchedulingEvent,
  type RecurringView,
  type RequestTimeOffInput,
  type RescheduleVisitInput,
  type SchedulingSeed,
  type SchedulingServiceDeps,
  type TimeOffView,
  type UpsertAvailabilityInput,
  type VisitView,
  SchedulingRouteService,
} from "./routes/service";
export {
  getBillableEncounterReader,
  getMileagePayrollReader,
  getSupervisoryCadenceReader,
  getVolunteerComplianceProvider,
} from "./seams/consumed";
export {
  type PortalVisitSeedRow,
  type RouteEfficiencySeedRow,
  type SchedulingMetricsCounts,
  type SchedulingRouteEfficiency,
  type SchedulingSeamDeps,
  type SchedulingSeamSeed,
  type SchedulingSeamStore,
  createInMemorySchedulingSeamStore,
  createPortalVisitReader,
  createVisitAssignmentReader,
  createVisitMetricsProvider,
  createVisitReader,
  getPortalVisitReader,
  getVisitAssignmentReader,
  getVisitMetricsProvider,
  getVisitReader,
  registerSchedulingSeams,
} from "./seams/index";
