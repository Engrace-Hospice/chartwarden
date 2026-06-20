// @wardenx/audit — Module 40 (Master Data Management) action catalog (M40-T10; M40 spec §8.1.1).
//
// The app-emitted MDM audit actions from §8.1.1, registered under the D9 `m40.<resource>.<verb>`
// namespace the catalog validator enforces (§4.6.7 owner-prefix). These are governance/ops events
// about DIRECTORY-style reference data: MDM carries no PHI by construction (§8.3), so every entry
// has an empty denylist and is not Part 2 eligible, all `operational` retention. Canonical/overlay
// writes ALSO flow through the M4 audit triggers as `<table>.created/updated/deleted` (the DB-trigger
// layer, M40-T03) — those are not catalogued here; this file is M40's app-level event surface.
import type { ModuleActionCatalog } from "./types";

/** `m40` Master Data Management module actions (M40 §8.1.1). */
export const M40_ACTION_CATALOG: ModuleActionCatalog = [
  {
    action: "m40.nppes.provider_synced.applied", // §8.1.1
    moduleOwner: "m40",
    defaultRetentionClass: "operational",
    description:
      "An M29 NPPES provider-synced event was applied to a physician canonical (npi, outcome, changedFields, syncRunId).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m40.nppes.deactivation_observed_no_canonical", // §8.1.1
    moduleOwner: "m40",
    defaultRetentionClass: "operational",
    description:
      "An NPPES deactivation arrived for an NPI with no M40 canonical — observe-only, no row written (npi, deactivationReason).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m40.legacy_nightly.skipping_m29_recent", // §8.1.1
    moduleOwner: "m40",
    defaultRetentionClass: "operational",
    description:
      "The nightly delta skipped because M29's platform sync completed recently (hoursSinceM29).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m40.legacy_nightly.firing_fallback", // §8.1.1
    moduleOwner: "m40",
    defaultRetentionClass: "operational",
    description:
      "The nightly delta fired as a fallback because M29's sync is stale > 25h (hoursSinceM29, lastM29SyncRunId).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m40.baa_status.cache_miss", // §8.1.1
    moduleOwner: "m40",
    defaultRetentionClass: "operational",
    description: "A BAA-status lookup missed the Valkey cache and recomputed (cacheKey, kind, asOfBucket).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
];
