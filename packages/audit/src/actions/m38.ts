// @chartwarden/audit — Module 38 (Clinical Terminology) action catalog (M38-T10; §4.6.1 `m38.ts`,
// M38 spec §8.1).
//
// The app-emitted terminology events from M38 §8.1, registered under the D9 `m38.<resource>.<verb>`
// namespace the catalog validator enforces (the spec writes them `terminology.*`; architecture's
// action-catalog convention wins — owner-prefix must match, §4.6.7). These are governance/ops
// events about REFERENCE data: terminology carries no PHI by construction (§8.3), so every entry
// has an empty denylist and is not Part 2 eligible. Platform writes ALSO flow through the M4 audit
// triggers as `term.<table>.created/updated/deleted` (the DB-trigger layer, T03) — those are not
// catalogued here; this file is M38's app-level event surface.
import type { ModuleActionCatalog } from "./types";

/** `m38` Clinical Terminology module actions (M38 §8.1). */
export const M38_ACTION_CATALOG: ModuleActionCatalog = [
  {
    action: "m38.version.loaded", // §8.1 terminology.version_loaded
    moduleOwner: "m38",
    defaultRetentionClass: "compliance",
    description:
      "A code-system version was loaded and activated (system, versionId, releasedOn, newCodes, retiredCodes, affectedValueSets).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m38.version.load_failed", // §8.1 terminology.version_load_failed (critical)
    moduleOwner: "m38",
    defaultRetentionClass: "compliance",
    description: "A code-system version load failed (system, version, reason); no DB writes occurred.",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m38.deprecation.detected", // §8.1 terminology.deprecations_detected (warn)
    moduleOwner: "m38",
    defaultRetentionClass: "compliance",
    description: "A load detected deprecated codes (system, versionId, deprecatedCount).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m38.tenant_deprecation_scan.completed", // §8.1 terminology.tenant_deprecation_scan_completed
    moduleOwner: "m38",
    defaultRetentionClass: "operational",
    description:
      "A per-tenant deprecation remediation scan completed (orgId, system, affectedRecordCount); an M36 alert was emitted when records were affected.",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m38.value_set_extension.added", // §8.1 terminology.value_set_extension_added
    moduleOwner: "m38",
    defaultRetentionClass: "compliance",
    description: "A tenant added a value-set extension (orgId, valueSetId, system, code, reason).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m38.value_set_extension.removed", // §8.1 terminology.value_set_extension_removed
    moduleOwner: "m38",
    defaultRetentionClass: "compliance",
    description: "A tenant removed a value-set extension (orgId, valueSetId, system, code, reason).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m38.embedding.refreshed", // §8.1 terminology.embeddings_refreshed
    moduleOwner: "m38",
    defaultRetentionClass: "operational",
    description: "Concept embeddings were refreshed after a load (system, versionId, conceptCount).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m38.expansion.staleness_exceeded", // §8.1 terminology.expansion_staleness_exceeded (warn)
    moduleOwner: "m38",
    defaultRetentionClass: "operational",
    description: "A value-set expansion exceeded its freshness window (valueSetId, lagSeconds).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m38.external_lookup.recorded", // §8.1 terminology.external_lookup
    moduleOwner: "m38",
    defaultRetentionClass: "operational",
    description: "A terminology lookup was served to an external surface (via, system, code, asOf).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
];
