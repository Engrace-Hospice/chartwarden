// M25 — the two-tier posting routing (D4) over a resolved CARC category (D5). PURE.
//
// The CARC category is resolved upstream by the classify-denial service (M38 catalog lookup + the
// per-tenant denial_taxonomy_overlay, with the M38 platform floor as fallback). The `category` is the
// regulatory floor and is NEVER overridable by a tenant (M25-F09). Given the CAS group code + that
// resolved category + whether the CARC was found in the catalog, this routes each adjustment:
//
//   - taxonomy unmapped         → seed a denial case (taxonomy_status='unmapped', D13), post 'denial_seeded'
//   - category denial/recoupment → seed a denial case, post 'denial_seeded'
//   - group PR                   → record on the patient-responsibility ledger, post 'ledger_recorded'
//   - group CO / PI              → contractual / payer-initiated write-off, post 'auto_posted'
//   - group OA / CR              → flag for billing-supervisor review, post 'flagged_review'
import type { CasGroupCode, DenialCategory, PostAction, TaxonomyStatus } from "./types";

export interface AdjustmentRouting {
  readonly postAction: PostAction;
  /** Insert a denial_case row for this adjustment. */
  readonly seedDenial: boolean;
  /** Record a patient_responsibility_ledger row for this adjustment. */
  readonly seedPrLedger: boolean;
}

/** Route a single CAS adjustment to its posting action + side effects (D4/D5/D13). */
export function routeAdjustment(
  groupCode: CasGroupCode,
  category: DenialCategory,
  taxonomyStatus: TaxonomyStatus,
): AdjustmentRouting {
  if (taxonomyStatus === "unmapped") {
    return { postAction: "denial_seeded", seedDenial: true, seedPrLedger: false };
  }
  if (category === "denial" || category === "recoupment") {
    return { postAction: "denial_seeded", seedDenial: true, seedPrLedger: false };
  }
  if (groupCode === "PR") {
    return { postAction: "ledger_recorded", seedDenial: false, seedPrLedger: true };
  }
  if (groupCode === "CO" || groupCode === "PI") {
    return { postAction: "auto_posted", seedDenial: false, seedPrLedger: false };
  }
  // OA (other adjustment) and CR (correction & reversal) need a human look.
  return { postAction: "flagged_review", seedDenial: false, seedPrLedger: false };
}

/**
 * Resolve the effective category for a CARC. When the CARC is absent from the M38 catalog (no platform
 * category), the case posts under 'unmapped' (D13) and the unmapped feedback loop fires upstream. A present
 * catalog category is authoritative (tenants cannot override it — M25-F09).
 */
export function effectiveCategory(catalogCategory: DenialCategory | null): {
  category: DenialCategory;
  taxonomyStatus: TaxonomyStatus;
} {
  if (catalogCategory === null) return { category: "unmapped", taxonomyStatus: "unmapped" };
  return { category: catalogCategory, taxonomyStatus: "mapped" };
}
