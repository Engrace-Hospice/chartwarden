// @wardenx/inpatient — M37-T08, §2.7 D8. The visitor check-in restriction evaluator + relationship
// resolver. The check-in route merges the active unit-scope (outbreak) and patient-scope restrictions and
// this core computes the effective decision: full_block denies (412), immediate_family_only denies a
// non-immediate-family visitor, mask_required allows with a mask flag, time_limited/no_overnight allow with
// advisory flags. Pure & IO-free.
import type { IpuVisitorRelationship, IpuVisitorRestrictionKind } from "@wardenx/types";
import { IpuStateError } from "../../errors";

/** §2.7 — the immediate-family relationships (the set an immediate_family_only restriction admits). */
export const IMMEDIATE_FAMILY_RELATIONSHIPS: readonly IpuVisitorRelationship[] = [
  "spouse",
  "parent",
  "child",
  "sibling",
  "grandparent",
  "grandchild",
];

/** Whether a relationship counts as immediate family. */
export function isImmediateFamily(relationship: IpuVisitorRelationship): boolean {
  return IMMEDIATE_FAMILY_RELATIONSHIPS.includes(relationship);
}

// ── §2.7 the M39 consent gate on a non-immediate-family visitor (GAP-061's sibling, GAP-062) ────────

/**
 * The M39 consent types that can authorize a NON-immediate-family visitor at the bedside (§2.7: "consent
 * of the patient or representative if the visitor is non-immediate-family"). Any ACTIVE one satisfies the
 * gate — these are the on-file authorizations by which a patient names someone outside the immediate
 * family to receive their PHI.
 *
 * COARSE BY CONSTRUCTION, and the limit is worth stating: check-in captures a free-text `visitor_name`
 * and no recipient id, so nothing can bind THIS visitor to a named recipient on the consent record. The
 * question the gate can honestly answer is "does this patient have an on-file authorization admitting
 * non-family access at all", and that is the question it asks. Binding visitor → named recipient needs a
 * recipient picker at the desk (M39 §2.3 recipients), not a different evaluator call.
 */
export const VISITOR_CONSENT_TYPES: readonly string[] = [
  "hipaa_release",
  "family_caregiver_access",
];

/** A `legal_representative` visitor is additionally authorized by an active healthcare DPOA — the
 *  instrument that MAKES them the representative (M39 §2.3 `per_named_agent`). */
export const LEGAL_REPRESENTATIVE_CONSENT_TYPES: readonly string[] = [
  "dpoa_healthcare",
  ...VISITOR_CONSENT_TYPES,
];

/**
 * §2.7 — which M39 consent types must be checked before admitting this visitor, or `null` when the
 * relationship needs no consent evaluation at all (immediate family — the spec's "spouse visit is
 * consent-default-OK", W-IPU-07 step 5).
 */
export function visitorConsentTypesFor(
  relationship: IpuVisitorRelationship,
): readonly string[] | null {
  if (isImmediateFamily(relationship)) return null;
  return relationship === "legal_representative"
    ? LEGAL_REPRESENTATIVE_CONSENT_TYPES
    : VISITOR_CONSENT_TYPES;
}

/** An active restriction fact the check-in route injects (unit-scope or patient-scope, already filtered to active). */
export interface ActiveVisitorRestriction {
  readonly kind: IpuVisitorRestrictionKind;
}

/** The effective check-in decision. */
export interface VisitorCheckInDecision {
  readonly allowed: boolean;
  readonly maskRequired: boolean;
  readonly noOvernight: boolean;
  readonly timeLimited: boolean;
  /** The restriction kind that shaped the decision (the strictest applied), for the receipt + audit. */
  readonly appliedRestriction: IpuVisitorRestrictionKind | null;
}

/**
 * §2.7 — evaluate a visitor check-in against the active restrictions. Throws {@link IpuStateError}
 * `VISITOR_RESTRICTION_FULL_BLOCK` (412) on a full block, or `VISITOR_IMMEDIATE_FAMILY_ONLY` (412) for a
 * non-immediate-family visitor under an immediate_family_only restriction. Otherwise returns the advisory
 * flags (mask / no-overnight / time-limited) the check-in route echoes into the response + receipt.
 */
export function evaluateVisitorCheckIn(
  relationship: IpuVisitorRelationship,
  restrictions: readonly ActiveVisitorRestriction[],
): VisitorCheckInDecision {
  const kinds = new Set(restrictions.map((r) => r.kind));

  if (kinds.has("full_block")) {
    throw new IpuStateError(
      "VISITOR_RESTRICTION_FULL_BLOCK",
      "Visitation is fully blocked for this unit/patient by an active restriction.",
    );
  }
  if (kinds.has("immediate_family_only") && !isImmediateFamily(relationship)) {
    throw new IpuStateError(
      "VISITOR_IMMEDIATE_FAMILY_ONLY",
      "An active restriction limits visitation to immediate family only.",
    );
  }

  // Strictest applied restriction for the receipt/audit (order: immediate_family_only > mask > time > overnight).
  const applied: IpuVisitorRestrictionKind | null = kinds.has("immediate_family_only")
    ? "immediate_family_only"
    : kinds.has("mask_required")
      ? "mask_required"
      : kinds.has("time_limited")
        ? "time_limited"
        : kinds.has("no_overnight")
          ? "no_overnight"
          : null;

  return {
    allowed: true,
    maskRequired: kinds.has("mask_required"),
    noOvernight: kinds.has("no_overnight"),
    timeLimited: kinds.has("time_limited"),
    appliedRestriction: applied,
  };
}

/** §2.7 — the M37 platform-floor screening checklist (v1). A positive answer to any risk item is a warn flag. */
export interface VisitorScreening {
  readonly feverPresent: boolean;
  readonly coughPresent: boolean;
  readonly recentCovidExposure14d: boolean;
  readonly recentTravelOutsideCountry14d: boolean;
  readonly recentRespiratoryIllnessInHousehold14d: boolean;
}

/** §2.7 — does the screening flag any infection-risk item (surfaced to the charge nurse; advisory, not a hard block)? */
export function screeningHasRisk(s: VisitorScreening): boolean {
  return (
    s.feverPresent ||
    s.coughPresent ||
    s.recentCovidExposure14d ||
    s.recentTravelOutsideCountry14d ||
    s.recentRespiratoryIllnessInHousehold14d
  );
}
