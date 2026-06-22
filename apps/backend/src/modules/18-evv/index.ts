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
export {
  type EvvAbacDeps,
  type EvvAbacResolver,
  type EvvCaptureWindow,
  M18_ABAC_PREDICATES,
  buildEvvAbacPredicates,
  registerEvvAbacPredicates,
} from "./abac-predicates";
export { type EvvRouteDeps, registerEvvRoutes } from "./routes/evv-routes";
export {
  type ArrivalView,
  type CheckResultView,
  type DeviceView,
  type EvvAggregatorSubmissionSeed,
  type EvvMissingResolutionSeed,
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
export { type SubmissionPassResult, dispatchSubmission, pollSubmissionOnce } from "./submission-flow";
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
