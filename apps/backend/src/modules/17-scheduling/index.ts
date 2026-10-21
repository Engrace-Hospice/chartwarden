// apps/backend/src/modules/17-scheduling — M17 (Scheduling & Route Optimization) backend module surface.
//
// M17-T05 lands the four §4.3 owned seams (VisitReader — the visit read path M8 (encounter-authoring context,
// including the live M8 visit seed) / M18 (EVV geofence target) / M14 (IDG since-meeting)
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
// M17-T07 lands the §4.10 D1 OSRM `RoutingProvider` adapter (`@chartwarden/routing-client`), the §4.1 route
// inventory behind the M3 Authorization Contract over the §4.6 keys (`M17_CONTRIBUTED_PERMISSIONS`), and the
// four §4.7 pre-schedule ABAC predicates (`clinician_credentials_active` / `discipline_matches_visit` /
// `not_on_pto` / `within_caseload_or_unassigned_pool`). Route optimisation stays behind
// `scheduling.route_optimization` (OFF; §7.9 OSRM degraded mode is the Phase-1 path).
//
// M17-T08 lands the §4.11 outbox-event catalog (the full `m17.*` taxonomy — `events-by-m17.ts`; check-fitness-
// gaps.ts scans it for naming + ownership + declared consumers). `m17.visit.published` wires M8's visit
// seed live. Its M18/M31/M33 fan-out remains pending until those event handlers bind; M5 reads the separate
// assigned/unassigned caseload stream (§4.5 D11). It also lands the §4.9 M36 typed alert payloads
// (`alerts-by-m17.ts`; registered onto M36's
// Foundation registry at boot, composition + recipient resolution is M36's per ADR-0024) and the Track B §5.1
// web screens (apps/web/src/modules/17-scheduling, ADR-0030).
import type { DbClient } from "@chartwarden/db";
import type { FastifyInstance } from "fastify";
import { registerSchedulingAbacPredicates as _registerM17Abac } from "./abac-predicates";
import { registerSchedulingRoutes as _registerM17Routes } from "./routes/scheduling-routes";
import {
  type SchedulingWriteOutboxPort,
  createDbSchedulingBackend,
} from "./scheduling-route-service-db";

/**
 * M17L — mount the M17 scheduling routes over the PRODUCTION Drizzle backend (RLS-scoped under
 * `withOrgContext`). The scaffold uses ONE object as BOTH the route service AND the §4.7 ABAC resolver, so a
 * single `createDbSchedulingBackend(db, outbox)` serves both registrations. Reads AND the full write lifecycle
 * (the visit machine, proposals, recurring policies, availability, time-off, route-optimisation degraded path)
 * are live over Drizzle+RLS; every mutation emits its strict `m17.*` catalog payload on the bound transactional
 * `outbox`. Replaces the in-memory clinical-core scaffold mount for M17.
 */
export function mountSchedulingRoutes(
  app: FastifyInstance,
  db: DbClient,
  outbox?: SchedulingWriteOutboxPort,
): void {
  const backend = createDbSchedulingBackend(db, outbox);
  _registerM17Abac({ resolver: backend });
  _registerM17Routes(app, { service: backend });
}

export {
  type SchedulingWriteOutboxPort,
  type SchedulingAutomationService,
  createDbSchedulingBackend,
} from "./scheduling-route-service-db";
export {
  buildM17WorkerDeps,
  registerM17CronWorkers,
  runCaregiverReminderCron,
  runReassignmentScanCron,
  runRecurringMaterializationCron,
  runVisitAttentionCron,
  scheduleM17Jobs,
} from "./jobs/cron-workers";
export { M17_OUTBOX_EVENTS } from "./events-by-m17";
export { M17_ALERT_PAYLOADS } from "./alerts-by-m17";
export {
  type EncounterSignedConsumed,
  buildM17EncounterSignedConsumer,
  type VisitCompletionPlan,
  M17_OUTBOX_SUBSCRIPTIONS,
  planVisitCompletionFromEncounter,
} from "./consumers/index";
export { buildM17AdmissionLifecycleConsumer } from "./consumers/admission-lifecycle";
export { buildM17CarePlanProposalConsumer } from "./consumers/care-plan-proposals";
// F-152 (#248) — the D14 EVV-authoritative visit advances + the §7.5 SOS-resolution cancellation, bound live.
export {
  M17_EVV_CHECK_IN_CONSUMER,
  buildM17EvvCheckInConsumer,
  type EvvCheckInDeps,
} from "./outbox-consumers/m18-evv-check-in";
export {
  M17_EVV_AT_PATIENT_ADDRESS_CONSUMER,
  buildM17EvvAtPatientAddressConsumer,
  type EvvAtPatientAddressDeps,
} from "./outbox-consumers/m18-evv-at-patient-address";
// F-196 (#248) — the §4.10 missing-EVV resolution stamp, bound live.
export {
  M17_EVV_LATE_CHECK_RESOLVED_CONSUMER,
  buildM17EvvLateCheckResolvedConsumer,
  type EvvLateCheckResolvedDeps,
} from "./outbox-consumers/m18-evv-late-check-resolved";
export {
  M17_SOS_VISIT_CANCELLATION_CONSUMER,
  buildM17SosVisitCancellationConsumer,
  type SosVisitCancellationDeps,
} from "./outbox-consumers/m20-safety-visit-cancellation";
// F-158 (#248) — the §3.3 EVV checkout/correction provenance-pointer consumers, bound live.
export {
  M17_EVV_CHECK_OUT_CONSUMER,
  buildM17EvvCheckOutConsumer,
  type EvvCheckOutDeps,
} from "./outbox-consumers/m18-evv-check-out";
export {
  M17_EVV_EVENT_CORRECTED_CONSUMER,
  buildM17EvvEventCorrectedConsumer,
  type EvvEventCorrectedDeps,
} from "./outbox-consumers/m18-evv-event-corrected";
// F-166 (#248) — the §7.5 volunteer-gate scheduler warning + the §2.2.4 D5 after-hours triage proposal.
export {
  M17_VOLUNTEER_ASSIGNMENT_INACTIVATED_CONSUMER,
  buildM17VolunteerAssignmentInactivatedConsumer,
  type VolunteerAssignmentInactivatedConsumerDeps,
} from "./outbox-consumers/m15-volunteer-assignment-inactivated";
export {
  M17_TRIAGE_VISIT_NEEDED_CONSUMER,
  buildM17TriageVisitNeededConsumer,
  type TriageVisitNeededConsumerDeps,
  type TriageVisitAdmissionSiting,
  type TriageVisitAdmissionSitingReader,
} from "./outbox-consumers/m19-triage-visit-needed";
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
  type CredentialDiscipline,
  type CredentialRecord,
  type CredentialRecordStatus,
  type CredentialSeamDeps,
  type CredentialStore,
  type GrantCredentialInput,
  type PortalVisitSeedRow,
  type RouteEfficiencySeedRow,
  type SchedulingMetricsCounts,
  type SchedulingRouteEfficiency,
  type SchedulingSeamDeps,
  type SchedulingSeamSeed,
  type SchedulingSeamStore,
  SchedulingOnCallRosterUnavailableError,
  createCredentialReader,
  createDrizzleCredentialStore,
  createDrizzleSchedulingSeamStore,
  createInMemoryCredentialStore,
  createInMemorySchedulingSeamStore,
  createPortalVisitReader,
  createVisitAssignmentReader,
  createVisitMetricsProvider,
  createVisitReader,
  getCredentialReader,
  getPortalVisitReader,
  getVisitAssignmentReader,
  getVisitMetricsProvider,
  getVisitReader,
  registerCredentialSeam,
  registerSchedulingSeams,
} from "./seams/index";
