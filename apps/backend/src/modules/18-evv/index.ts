// apps/backend/src/modules/18-evv — M18 (Electronic Visit Verification) backend module surface.
//
// M18-T05 lands the six §4.3 owned reader seams registered into the M1 registry via `registerEvvSeams` (driven
// from the composition root's wireModuleSeams()): `EvvBracketResolver` (published over M8's EXISTING
// `resolveBracket` contract — CLOSES M8's `encounter.period` forward seam, M8 D9), `EvvComplianceReader`
// (M23/M24 billing gate + M30 HQRP), `EvvAggregatorReferenceReader` (M24 claim / M25 denial), `EvvLocationProvider`
// (M20 field-safety live-awareness — the only coordinate-bearing seam, D10), `EvvMetricsProvider` (M30/M33
// dashboards), and `EvvVerificationProvider` (M31 portal arrival surface, timestamp only).
//
// M18-T06 lands: the §4.5 D1 `EvvAggregatorAdapter` seam (`@wardenx/evv-aggregators` — Sandata + open-model
// adapters + the per-state `StateAggregatorRegistry` selecting from M40 master data), the pure §2.2.5 D7
// submission state machine (`transitionAggregatorSubmission`) + the §7.8/§7.9 `dispatchSubmission` /
// `pollSubmissionOnce` orchestration, the §4.6 permission keys (`M18_CONTRIBUTED_PERMISSIONS` → M3), the two
// §4.7 ABAC predicates (`assigned_clinician_for_visit` / `evv_within_visit_window` → M3), and the §4.1 route
// inventory behind the M3 Authorization Contract over the in-memory `EvvRouteService` slice.
import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import { registerEvvAbacPredicates as _registerM18Abac } from "./abac-predicates";
import { type EvvWriteOutboxPort, createDbEvvBackend } from "./evv-route-service-db";
import { registerEvvRoutes as _registerM18Routes } from "./routes/evv-routes";

/**
 * Mount the M18 EVV routes over the PRODUCTION Drizzle backend (RLS-scoped under `withOrgContext`), mirroring
 * `mountAdmissionRoutes`. The SAME backend object is the route service AND the §4.7 ABAC resolver (the
 * predicates read the same dataset the handlers do). Reads AND the full write lifecycle (capture, device
 * lifecycle, geofence policy, missing-resolution + aggregator-submission machines) are live over Drizzle+RLS;
 * every mutation emits its strict `m18.evv.*` catalog payload on the bound transactional `outbox`. Replaces the
 * in-memory clinical-core scaffold mount for M18.
 */
export function mountEvvRoutes(
  app: FastifyInstance,
  db: DbClient,
  outbox?: EvvWriteOutboxPort,
  options: { readonly deviceAttestationEnforced?: boolean } = {},
): void {
  // GAP-055 follow-up: ONE value (from validated server config, default OFF) feeds BOTH the routes' attestation
  // gate and the service-layer guard, so they cannot disagree.
  const deviceAttestationEnforced = options.deviceAttestationEnforced ?? false;
  const backend = createDbEvvBackend(db, outbox, { deviceAttestationEnforced });
  _registerM18Abac({ resolver: backend });
  _registerM18Routes(app, { service: backend, deviceAttestationEnforced });
}

export { type EvvWriteOutboxPort, createDbEvvBackend } from "./evv-route-service-db";
export {
  type EvvAbacDeps,
  type EvvAbacResolver,
  type EvvCaptureWindow,
  M18_ABAC_PREDICATES,
  buildEvvAbacPredicates,
  registerEvvAbacPredicates,
} from "./abac-predicates";
export {
  type EvvCaptureAuthority,
  EVV_DEVICE_ATTESTATION_ENFORCED_ENV,
  assertCaptureAllowed,
  clinicianCapture,
  isEvvDeviceAttestationEnforced,
  selectBoundDevice,
  systemCapture,
} from "./capture-guards";
export { type EvvRouteDeps, registerEvvRoutes } from "./routes/evv-routes";
export {
  type ArrivalView,
  type CheckResultView,
  type DeviceView,
  type EvvAggregatorSubmissionSeed,
  type EvvMissingResolutionSeed,
  type EvvRoutePort,
  type EvvDeviceSeed,
  type EvvServiceSeed,
  type EvvVisitSeed,
  type GeofencePolicyView,
  type LocationView,
  type MetricsView,
  type MissingResolutionView,
  EvvRouteService,
} from "./routes/service";
export {
  type AggregatorSubmissionTransition,
  type EvvAggregatorSubmissionEvent,
  AGGREGATOR_SUBMISSION_GRAPH,
  isAggregatorSubmissionCancellable,
  isAggregatorSubmissionResubmittable,
  isAggregatorSubmissionTerminal,
  transitionAggregatorSubmission,
} from "./domain/aggregator-submission";
export {
  type SubmissionPassResult,
  dispatchSubmission,
  pollSubmissionOnce,
} from "./submission-flow";
// M18-T07 — the §4.10 outbox-event catalog (the full `m18.evv.*` taxonomy; check-fitness-gaps.ts scans
// events-by-m18.ts for naming + ownership + declared consumers). **`m18.evv.check_in_recorded` /
// `m18.evv.check_out_recorded` wire LIVE M8's encounter.period EVV-bracket forward seam (M8 D9) and drive M17's
// visit-state transitions (D14).** M19/M25 stay inert Phase-2 consumers (`late_check_out_detected` /
// `aggregator_rejected`).
export { M18_OUTBOX_EVENTS } from "./events-by-m18";
export {
  M18_VISIT_PUBLISHED_CONSUMER,
  buildM18VisitPublishedConsumer,
} from "./outbox-consumers/m17-visit-published";
// F-153 (#248) — the D14 `m17.visit.cancelled` bracket close (cancel pending aggregator submissions +
// void open missing-resolution rows) and the D6/§2.2.4 `m8.encounter.signed` auto-resolution.
export {
  M18_VISIT_CANCELLED_CONSUMER,
  buildM18VisitCancelledConsumer,
} from "./outbox-consumers/m17-visit-cancelled";
export {
  M18_ENCOUNTER_SIGNED_CONSUMER,
  buildM18EncounterSignedConsumer,
} from "./outbox-consumers/m8-encounter-signed";
// M18-T07 — the §4.9 M36 typed alert payloads M18 OWNS (late-checkout / geofence-breach / GPS-spoof / device
// pending+suspended / aggregator rejected+timeout). Registered onto M36's Foundation alert-payload registry at
// boot; composition + recipient resolution is M36's (ADR-0024). M18-F16: out-of-band channels carry no PHI.
export { M18_ALERT_PAYLOADS } from "./alerts-by-m18";
export {
  type EvvAggregatorWindowCounts,
  type EvvAggregatorWindowSeedRow,
  type EvvArrival,
  type EvvComplianceState,
  type EvvDeviceCoverage,
  type EvvMetricWindowCounts,
  type EvvSeamDeps,
  type EvvSeamSeed,
  type EvvSeamStore,
  type EvvVerificationSummary,
  type EvvWindowSeedRow,
  complianceStatesForVisitsForOrg,
  createDrizzleEvvSeamStore,
  createEvvAggregatorReferenceReader,
  createEvvBracketResolver,
  createEvvComplianceReader,
  createEvvLocationProvider,
  createEvvMetricsProvider,
  createEvvVerificationProvider,
  createInMemoryEvvSeamStore,
  getEvvAggregatorReferenceReader,
  getEvvBracketResolver,
  getEvvComplianceReader,
  getEvvLocationProvider,
  getEvvMetricsProvider,
  getEvvVerificationProvider,
  registerEvvSeams,
} from "./seams/index";
