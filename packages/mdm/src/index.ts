// @chartwarden/mdm — Master Data Management (Module 40).
//
// Public surface of the package. M40-T01 ships the §3.2 enum mirror and the §2.3
// canonical-vs-overlay dividing line — the shared kind/enum types every later task builds on
// (the MDM analog of M36's `channel_kind` discriminator). The Drizzle schema (M40-T02) and
// RLS/audit triggers (M40-T03) follow; the resolution & merge-redirect engine (M40-T04), the
// MdmEntityProvider / BaaStatusProvider seams (M40-T05/T06), routes + permission keys
// (M40-T07), the NPPES nightly job (M40-T08), and screens/eraser (M40-T10) land in their tasks.

export {
  MDM_ENTITY_KINDS,
  MDM_ENTITY_KIND_DESCRIPTORS,
  PHASE_1_CANONICAL_KINDS,
  FIELD_PLACEMENT_RULES,
} from "./interfaces/kinds";

export type {
  MdmEntityKind,
  MdmEntityKindDescriptor,
  CanonicalIdentifier,
  MdmEntityStatus,
  MdmMergeStatus,
  MdmMergeProposer,
  MdmProvisionalStatus,
  MdmNppesSyncMode,
  MdmBaaStatus,
  FacilityKind,
  PayerKind,
  FieldPlacement,
  FieldClass,
  FieldPlacementRule,
} from "./interfaces/kinds";

// The resolution & merge-redirect engine (M40-T04, §2.1, §7.1–7.2). Pure core the T05
// `MdmEntityProvider` composes over Drizzle: the transparent redirect chase + overlay join.
export {
  resolveRedirect,
  followMerge,
  joinOverlay,
  MergeRedirectError,
  MAX_REDIRECT_DEPTH,
} from "./resolve";

export type {
  CanonicalRedirectRow,
  CanonicalRowLoader,
  MergeRedirect,
  ResolvedStatus,
  ResolvedEntity,
} from "./resolve";

// The `MdmEntityProvider` seam — the contract every consumer imports (M40-T05, §4.5). The rich
// interface + the real provider (pure orchestration over the T04 engine) + the `MdmStore` port.
export {
  createMdmEntityProvider,
  createInMemoryMdmStore,
  type MdmStore,
  type InMemoryMdmSeed,
  type SeedCanonical,
  type SeedOverlay,
  type SeedRelationship,
  type SeedBaa,
} from "./provider";

export type {
  MdmEntityProvider,
  MdmResolved,
  CanonicalFields,
  CanonicalFieldsByKind,
  CanonicalBaseFields,
  CanonicalPhysicianFields,
  CanonicalFacilityFields,
  CanonicalPayerFields,
  OverlayFields,
  OverlayFieldsByKind,
  OverlayPhysicianFields,
  SearchSpec,
  IdentifyingFields,
  MdmBaaGateResult,
} from "./interfaces/entity-provider";

// The `BaaStatusProvider` seam — the focused §7.7 disclosure gate (M40-T06, §4.6). Registered
// SEPARATELY from MdmEntityProvider; M22/M28/M29 import this for the as-of BAA gate.
export {
  createBaaStatusProvider,
  createInMemoryBaaStore,
  decideBaaStatus,
  defaultBaaRequired,
  NO_MATCH_RESULT,
  type BaaStore,
  type BaaRecordRow,
  type InMemoryBaaSeed,
  type SeedBaaFacility,
  type SeedBaaRequired,
  type SeedBaaRecord,
} from "./baa";

export type {
  BaaStatusProvider,
  BaaStatusResult,
  BaaStatusKind,
  BaaEntityKind,
} from "./interfaces/baa-status-provider";

// The route service + shared in-memory backend — the write/admin surface backing M40's routes
// (M40-T07, §4.1, §7.6). Reads go through MdmEntityProvider; this covers overlay/baa/merge/etc.
export {
  createInMemoryMdmBackend,
  type MdmRouteService,
  type MergeRequestRow,
  type BaaRegisterEntry,
  type NppesSyncRun,
  type InMemoryMdmBackendSeed,
} from "./routes";

// Platform-owned reference-data seed (M40-T08, §3.8) — Medicare + per-state Medicaid placeholders.
export {
  MDM_PAYER_SEED,
  MEDICARE_SEED,
  US_STATES,
  toPayerCanonicalSeed,
  type PayerSeedRow,
  type SeededPayerCanonical,
} from "./seed";

// Background jobs (M40-T08, §4.3, §7.5) — the §4.3 queue catalog + the NPPES nightly-delta
// processor and the pure §7.5 drift engine.
export {
  MDM_QUEUES,
  MDM_JOB_SCHEDULES,
  M29_FALLBACK_THRESHOLD_HOURS,
  repointQueueName,
  detectNppesDrift,
  runNppesNightlyDelta,
  BAA_SCAN_LOOKAHEAD_DAYS,
  PROVISIONAL_AGING_MAX_IDS,
  PROVISIONAL_AGING_THRESHOLD_DAYS,
  planBaaExpiryAlerts,
  planLicenseExpiryAlerts,
  planProvisionalAging,
  runNppesWeeklyFull,
  type LicenseExpiryAlertPlan,
  type LicenseScanRecord,
  type ProvisionalAgingPlan,
  type ProvisionalRow,
  type BaaExpiryAlertPlan,
  type BaaExpirySeverity,
  type BaaExpiryWindow,
  type BaaScanRecord,
  type MdmQueueName,
  type NppesKnownPhysician,
  type NppesFreshRecord,
  type NppesDriftKind,
  type NppesDriftEvent,
  type NppesNightlyPorts,
  type NppesNightlyResult,
  type NppesSyncLogEntry,
} from "./jobs";

// M29 NPPES-sync consumer logic (M40-T09, §4.7, §7.11–7.12) — pure decisions + port-bound handlers
// M40 runs on M29's events. Forward-seam: deny-stub registration in the backend until M29 (Wave H).
export {
  decideProviderSynced,
  decideProviderDeactivated,
  handleProviderSynced,
  handleProviderDeactivated,
  type NppesCanonicalPhysician,
  type NppesProviderSnapshot,
  type M29ProviderSyncedPayload,
  type M29ProviderDeactivatedPayload,
  type NppesProvenance,
  type ProviderSyncedDecision,
  type ProviderDeactivatedOutcome,
  type NppesConsumerPorts,
} from "./nppes-consumers";

// Cache key grammar + TTLs + invalidation (M40-T10, §4.8) — pure key builders.
export {
  MDM_CACHE_TTL_SECONDS,
  resolvedEntityKey,
  canonicalKeyPrefix,
  canonicalChangedChannel,
  overlayChangedChannel,
  asOfMinuteBucket,
  baaStatusKey,
} from "./cache";

// D7 tenant-offboarding destruction (M40-T10, §7.8) — the pure eraseFn + its store port.
export {
  eraseTenantMdm,
  createInMemoryMdmEraseStore,
  type MdmEraseStore,
  type MdmEraseCounts,
} from "./destruction";
