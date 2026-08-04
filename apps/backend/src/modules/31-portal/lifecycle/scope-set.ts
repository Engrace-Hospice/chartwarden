// apps/backend/src/modules/31-portal/lifecycle/scope-set.ts — M31-T03 (§2.3, §6.1, §6.4, §7.5).
//
// The platform-floor grant scope per grant kind, and `validateScopeSet(scope, kind, tenantOverlay)` — the
// §2.3 validation rule every grant INSERT/UPDATE runs: a tenant overlay may TIGHTEN a floor-allowed
// category to `false` but never LOOSEN a floor-denied one to `true`. The floor is the minimum-necessary
// ceiling (§8.4 D17); a tenant lowers it, never raises it.
//
// PURE. Injected floor version in, a resolved `PortalScopeSet` out (or a `SCOPE_SET_LOOSENS_FLOOR` refusal).
// The scope keys are the T01 leaf `PortalDataCategory` union — the committed contract; §6.2's finer
// `care_plan_read`/`document_upload` tokens are the route-permission layer, resolved in M31-T07 against a
// category being readable here. The route/DB binding (persisting `scope_set_jsonb`) lands in M31-T07.
import type { PortalAccessGrantKind, PortalDataCategory, PortalScopeSet } from "@wardenx/types";
import { PortalStateError } from "./errors";

/** Every data category, in canonical order (the §6.4 floor is expressed as an allow/deny over this set). */
export const PORTAL_DATA_CATEGORIES: readonly PortalDataCategory[] = [
  "care_plan",
  "medications",
  "administrations",
  "assessments",
  "visits",
  "documents",
  "messages",
  "supplies",
  "triage",
  "bereavement",
] as const;

/**
 * §6.1 the platform-floor category allow-set per grant kind (D5/D6/D7). A category absent from a kind's set
 * is floor-DENIED (a tenant can never turn it on); a category present is floor-ALLOWED (a tenant may turn it
 * off). `bereaved_family` is the D6 lateral flip's target scope: bereavement messaging + the resource
 * library only — every live-patient category is floor-denied, which is what makes a bereaved session 404
 * (not 403) on care-plan/visit/medication routes (§8.3).
 */
const GRANT_KIND_FLOOR: Record<PortalAccessGrantKind, readonly PortalDataCategory[]> = {
  // §6.1 `portal_primary_caregiver` / `portal_patient_self` — the deepest live-patient scope.
  patient_self: [
    "care_plan",
    "medications",
    "administrations",
    "assessments",
    "visits",
    "documents",
    "messages",
    "supplies",
    "triage",
  ],
  family_caregiver: [
    "care_plan",
    "medications",
    "administrations",
    "assessments",
    "visits",
    "documents",
    "messages",
    "supplies",
    "triage",
  ],
  // §6.1 `portal_dpoa_healthcare` — full clinical access (D7); same live-patient floor.
  dpoa_healthcare: [
    "care_plan",
    "medications",
    "administrations",
    "assessments",
    "visits",
    "documents",
    "messages",
    "supplies",
    "triage",
  ],
  // §6.1 `portal_personal_representative_post_death` — HISTORICAL read only; no live messaging / telehealth /
  // attestation. Documents + disclosure-accounting drive the estate-executor surface.
  personal_representative: ["care_plan", "medications", "assessments", "visits", "documents"],
  // §6.1 `portal_bereaved_contact` (D6) — the M16-backed surface: bereavement + its messaging channel.
  bereaved_family: ["bereavement", "messages"],
};

/** The §6.4 platform-floor scope for a grant kind (every floor-allowed category `true`, the rest `false`). */
export function platformFloorScopeSet(
  kind: PortalAccessGrantKind,
  floorVersion: string,
): PortalScopeSet {
  const allow = new Set(GRANT_KIND_FLOOR[kind]);
  const categories: { [K in PortalDataCategory]?: boolean } = {};
  for (const cat of PORTAL_DATA_CATEGORIES) categories[cat] = allow.has(cat);
  return { categories, floorVersion };
}

/** Whether a category is floor-ALLOWED for a grant kind (a tenant may keep it on or turn it off). */
export function categoryAllowedByFloor(
  kind: PortalAccessGrantKind,
  category: PortalDataCategory,
): boolean {
  return GRANT_KIND_FLOOR[kind].includes(category);
}

/**
 * §2.3 / §6.4 — resolve a grant's scope set: start at the platform floor for the kind, then apply the
 * tenant overlay. A `false` in the overlay TIGHTENS a floor-allowed category off; a `true` for a
 * floor-DENIED category LOOSENS the floor and is REFUSED (`SCOPE_SET_LOOSENS_FLOOR`). An overlay `true` for
 * a floor-allowed category is a no-op (already on); an absent overlay entry leaves the floor value.
 *
 * @param tenantOverlay per-category tenant tightening — `false` turns a floor-allowed category off. Omit /
 *   `undefined` for "no tenant override".
 */
export function validateScopeSet(
  kind: PortalAccessGrantKind,
  floorVersion: string,
  tenantOverlay?: { readonly [K in PortalDataCategory]?: boolean },
): PortalScopeSet {
  const floor = platformFloorScopeSet(kind, floorVersion);
  if (!tenantOverlay) return floor;
  const categories: { [K in PortalDataCategory]?: boolean } = { ...floor.categories };
  for (const cat of PORTAL_DATA_CATEGORIES) {
    const override = tenantOverlay[cat];
    if (override === undefined) continue;
    if (override && !categoryAllowedByFloor(kind, cat)) {
      throw new PortalStateError(
        "SCOPE_SET_LOOSENS_FLOOR",
        `tenant overlay cannot enable floor-denied category '${cat}' for grant kind '${kind}'`,
      );
    }
    categories[cat] = override && categoryAllowedByFloor(kind, cat);
  }
  return { categories, floorVersion };
}

/** Whether a resolved scope set grants read of a category (the route guard's scope check, M31-T07). */
export function scopeSetContains(scope: PortalScopeSet, category: PortalDataCategory): boolean {
  return scope.categories[category] === true;
}
