// apps/backend/src/modules/17-scheduling — M17 (Scheduling & Route Optimization) backend module surface.
//
// M17-T05 lands the four §4.3 owned seams (VisitReader — the visit read path M8 (encounter-authoring context,
// which CLOSES M8's visit-seeding inert consumer M8 D9) / M18 (EVV geofence target) / M14 (IDG since-meeting)
// consume — + VisitAssignmentReader — the assignment read path M5 (§4.5 D11 caseload contribution) / M19
// (on-call) / M20 (field-safety) consume — + PortalVisitReader — the M31 portal upcoming-visit read path
// (lay-language, scrubbed) — + VisitMetricsProvider — the M30/M33 productivity + quality measures read path)
// registered into the M1 registry via `registerSchedulingSeams` (driven from the composition root's
// wireModuleSeams()). Routes / ABAC predicates / outbox / screens land in M17-T07/T08.
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
