// apps/backend/src/modules/18-evv — M18 (Electronic Visit Verification) backend module surface.
//
// M18-T05 lands the six §4.3 owned reader seams registered into the M1 registry via `registerEvvSeams` (driven
// from the composition root's wireModuleSeams()): `EvvBracketResolver` (published over M8's EXISTING
// `resolveBracket` contract — CLOSES M8's `encounter.period` forward seam, M8 D9), `EvvComplianceReader`
// (M23/M24 billing gate + M30 HQRP), `EvvAggregatorReferenceReader` (M24 claim / M25 denial), `EvvLocationProvider`
// (M20 field-safety live-awareness — the only coordinate-bearing seam, D10), `EvvMetricsProvider` (M30/M33
// dashboards), and `EvvVerificationProvider` (M31 portal arrival surface, timestamp only). The §4.5 aggregator
// adapter seam + the §4.6 permission keys / §4.7 ABAC predicates / §4.1 routes land in M18-T06.
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
