// @wardenx/terminology — Clinical Terminology Service (Module 38).
//
// Public surface of the package. M38-T01 ships the seam contract + the type-level
// code-system identity and per-system concept shapes (§2.3, §3.1, §3.2, §4.5).
// M38-T04 adds the pure as-of resolution engine (§2.1, §7.1–7.2) below. Later tasks
// add the registry wiring + real provider (T05), routes (T06), value-set
// expansion/deprecation (T07), seed (T08), FHIR projection + flag-gated semantic
// search (T09), and jobs/cache/eraser (T10).

export { CODE_SYSTEM_IDS } from "./interfaces/kinds";

export type {
  CodeSystemId,
  ConceptStatus,
  ValueSetScope,
  DeprecationMappingKind,
  VersionLoadStatus,
  TerminologyUpdateAction,
  Icd10cmProperties,
  SnomedProperties,
  LoincProperties,
  RxnormProperties,
  HcpcsProperties,
  GenericConceptProperties,
  ConceptPropertiesBySystem,
  ConceptProperties,
  ResolvedConcept,
  ExpansionMember,
  ValueSetMembershipSource,
  FhirCodeSystemProjection,
  FhirValueSetProjection,
} from "./interfaces/kinds";

export type {
  TerminologyProvider,
  DeprecationMappingResponse,
  ValidateResult,
  MembershipResult,
  ExpandOptions,
  MembershipOptions,
  SearchOptions,
} from "./interfaces/provider";

// The as-of resolution engine (M38-T04, §2.1, §7.1–7.2).
export {
  toIsoDate,
  normalizeAsOf,
  includesAsOf,
  resolveAsOf,
  resolveBatchAsOf,
  isUsableStatus,
  toValidateResult,
  type ConceptCandidate,
} from "./resolution";

// The real TerminologyProvider seam + its injectable data port (M38-T05, §4.5).
export {
  createTerminologyProvider,
  createInMemoryTerminologyStore,
  type TerminologyStore,
  type TenantExtensionInput,
  type CodeSystemMeta,
  type InMemoryTerminologySeed,
} from "./provider";

// Value-set expansion engine (M38-T07, §7.5) — materialized expansion + B-tree membership + freshness.
export {
  computeExpansion,
  expansionIncludesAsOf,
  memberRowAtAsOf,
  isMemberAtAsOf,
  staleIncludedSystems,
  isExpansionStale,
  toExpansionMember,
  type ValueSetMemberRow,
  type ExpansionRow,
  type SystemVersionLoad,
} from "./expansion";

// Tenant value-set extension rules (M38-T07, §7.6) — add-only/never-weaken classification + union.
export {
  classifyTenantExtension,
  unionTenantExtensions,
  type TenantExtensionContext,
  type TenantExtensionOutcome,
  type TenantExtensionRefusal,
} from "./extensions";

// Annual deprecation remediation rollup (M38-T07, §7.3).
export {
  buildRemediationReport,
  type TenantCodeRecord,
  type RemediationLine,
  type RemediationReport,
  type RemediationOptions,
} from "./remediation";

// Platform seed corpus (M38-T08, §3.9) — code-system catalog + value-set definitions + curated
// members. CPT stays absent until D4 (§7.8): the catalog is keyed by CodeSystemId.
export {
  PLATFORM_CODE_SYSTEMS,
  PLATFORM_VALUE_SETS,
  PLATFORM_VALUE_SET_MEMBERS,
  platformValueSetUrl,
  toInMemorySeed,
  type PlatformCodeSystemSeed,
  type CodeSystemLicenseSource,
  type PlatformValueSetSeed,
  type PlatformValueSetMemberSeed,
} from "./seed";

// D8 tenant-offboarding eraseFn (M38-T10, §11 D8) — deletes the org's value-set extensions only;
// platform reference tables are never touched.
export { eraseTenantTerminology, type TerminologyEraseStore } from "./destruction/index";

// Cache key grammar + TTLs + invalidation + the cache port (M38-T10, §4.6).
export {
  TERMINOLOGY_CACHE_TTL_SECONDS,
  lookupKey,
  lookupSystemPrefix,
  valueSetMembershipKey,
  valueSetPrefix,
  searchKey,
  searchSystemPrefix,
  tenantExtensionKey,
  versionLoadInvalidationPrefixes,
  hashQueryOpts,
  type TerminologyCache,
  createInMemoryTerminologyCache,
} from "./cache/index";

// Background jobs (M38-T10, §4.3) — queue catalog + schedules + pure processors + in-memory ports.
export {
  TERMINOLOGY_QUEUES,
  TERMINOLOGY_JOB_SCHEDULES,
  type TerminologyQueueName,
  runRefreshExpansions,
  runTenantDeprecationScan,
  type RefreshExpansionsPorts,
  type RefreshExpansionsResult,
  type TenantDeprecationScanPorts,
  type TenantDeprecationScanResult,
  type ScanDeprecation,
  createInMemoryRefreshExpansionsPorts,
  createInMemoryTenantDeprecationScanPorts,
} from "./jobs/index";
