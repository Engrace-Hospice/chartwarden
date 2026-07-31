// @wardenx/supplies — the §2.4 / D4 deterministic vendor-routing precedence ladder.
//
// PURE — the resolver takes the candidate rules the repository already loaded and returns the resolution
// plus the full evaluation trace. No IO here on purpose: the trace is what a surveyor reads years later
// ("why did this hospital bed go to Apria rather than Lincare on 2026-06-09?"), so it must be reproducible
// from recorded inputs alone, not re-derived against today's rule set.

import type {
  DmeVendorId,
  PharmacyDispatchMode,
  RoutingRuleResolved,
  SupplyFulfillmentMode,
  VendorRoutingRuleId,
  VendorRoutingScopeKind,
} from "@wardenx/types";

/** The resolver's version stamp, written into every resolution record. Bump when the ladder changes so an
 *  old record is never replayed through new logic. */
export const ROUTING_RESOLVER_VERSION = "v0.2" as const;

/** Most-specific first. The array order IS the precedence — nothing else encodes it. */
export const ROUTING_PRECEDENCE_ORDER: readonly VendorRoutingScopeKind[] = [
  "sku",
  "location",
  "tenant",
  "platform",
] as const;

/** One candidate `vendor_routing_rule` row, reduced to what the ladder actually reads. */
export interface RoutingRuleCandidate {
  readonly ruleId: VendorRoutingRuleId;
  readonly scopeKind: VendorRoutingScopeKind;
  /** skuId | locationId | orgId; null for the platform scope. */
  readonly scopeId: string | null;
  /** HCPCS prefix ('E', 'A', …) or the literal 'comfort_kit'. Null matches any class. */
  readonly skuClassPattern: string | null;
  readonly assignedVendorId: DmeVendorId | null;
  readonly assignedFulfillmentMode: SupplyFulfillmentMode;
  readonly defaultPharmacyDispatchMode: PharmacyDispatchMode | null;
  /** Ties inside one scope break on this, lowest first. */
  readonly precedencePriority: number;
  readonly isActive: boolean;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
}

export interface RoutingResolutionInput {
  readonly orgId: string;
  readonly locationId: string;
  /** The `data.skuId` of the request; null for a comfort-kit request, which routes on the kit class. */
  readonly skuId: string | null;
  /** HCPCS prefix derived from the request's HCPCS, or 'comfort_kit' for the kit kinds. */
  readonly skuClass: string;
  readonly resolvedAt: Date;
  /** sha256 of the policy inputs, computed by the caller (hashing is IO-adjacent and stays out of here). */
  readonly routingPolicyDigest: string;
}

export type RoutingResolution =
  | { readonly ok: true; readonly resolved: RoutingRuleResolved }
  | { readonly ok: false; readonly reason: "no_rule_matched"; readonly resolved: RoutingRuleResolved };

function isEffective(rule: RoutingRuleCandidate, at: Date): boolean {
  if (!rule.isActive) return false;
  if (rule.effectiveFrom.getTime() > at.getTime()) return false;
  return rule.effectiveTo === null || rule.effectiveTo.getTime() > at.getTime();
}

function scopeIdMatches(rule: RoutingRuleCandidate, input: RoutingResolutionInput): boolean {
  switch (rule.scopeKind) {
    case "sku":
      return input.skuId !== null && rule.scopeId === input.skuId;
    case "location":
      return rule.scopeId === input.locationId;
    case "tenant":
      return rule.scopeId === input.orgId;
    case "platform":
      return true;
  }
}

function classMatches(rule: RoutingRuleCandidate, input: RoutingResolutionInput): boolean {
  // A per-SKU pin is already as specific as it gets; requiring it to ALSO restate the class would let a
  // stale class string silently unpin the SKU.
  if (rule.scopeKind === "sku") return true;
  return rule.skuClassPattern === null || rule.skuClassPattern === input.skuClass;
}

function nonMatchReason(rule: RoutingRuleCandidate, input: RoutingResolutionInput): string {
  if (!isEffective(rule, input.resolvedAt)) return "not_effective_at_resolution_time";
  if (!scopeIdMatches(rule, input)) {
    return rule.scopeKind === "sku" ? "no_pin_for_sku" : `scope_id_mismatch_${rule.scopeKind}`;
  }
  return "sku_class_mismatch";
}

/**
 * D4 — walk the ladder most-specific first and take the first level that yields a match, breaking ties
 * inside a level on `precedencePriority` (lowest wins) and then on `ruleId` so the result is stable across
 * two rules a tenant gave the same priority.
 *
 * The `candidatesEvaluated` trace records EVERY rule the resolver looked at, including the ones that did
 * not match and why. That is the difference between a routing record and a routing decision: the record
 * has to explain the roads not taken.
 */
export function resolveVendorRouting(
  candidates: readonly RoutingRuleCandidate[],
  input: RoutingResolutionInput,
): RoutingResolution {
  const trace: RoutingRuleResolved["candidatesEvaluated"][number][] = [];
  let winner: RoutingRuleCandidate | null = null;
  let winningLevel: VendorRoutingScopeKind | null = null;

  for (const level of ROUTING_PRECEDENCE_ORDER) {
    const atLevel = candidates.filter((c) => c.scopeKind === level);
    const matched = atLevel
      .filter(
        (c) => isEffective(c, input.resolvedAt) && scopeIdMatches(c, input) && classMatches(c, input),
      )
      .sort((a, b) =>
        a.precedencePriority !== b.precedencePriority
          ? a.precedencePriority - b.precedencePriority
          : a.ruleId.localeCompare(b.ruleId),
      );

    for (const c of atLevel) {
      const isWinner = winner === null && matched[0]?.ruleId === c.ruleId;
      const didMatch = matched.some((m) => m.ruleId === c.ruleId);
      trace.push({
        precedenceLevel: level,
        ruleId: c.ruleId,
        matched: isWinner,
        reason: didMatch
          ? isWinner
            ? "sku_class_match"
            : "outranked_within_scope"
          : nonMatchReason(c, input),
      });
    }

    if (winner === null && matched.length > 0) {
      winner = matched[0] ?? null;
      winningLevel = level;
    }
  }

  if (winner === null || winningLevel === null) {
    // D4 step 4: no tenant rule and no platform default. Ships with no platform defaults on purpose —
    // every tenant must configure at least the per-tenant default, and a silent fallback vendor would be
    // an agency shipping controlled substances through a vendor nobody chose.
    return {
      ok: false,
      reason: "no_rule_matched",
      resolved: {
        resolverVersion: ROUTING_RESOLVER_VERSION,
        resolvedAt: input.resolvedAt.toISOString(),
        precedenceLevelUsed: "platform",
        matchedRuleId: null,
        assignedVendorId: null,
        assignedFulfillmentMode: "vendor",
        defaultPharmacyDispatchMode: null,
        candidatesEvaluated: trace,
        routingPolicyDigest: input.routingPolicyDigest,
      },
    };
  }

  return {
    ok: true,
    resolved: {
      resolverVersion: ROUTING_RESOLVER_VERSION,
      resolvedAt: input.resolvedAt.toISOString(),
      precedenceLevelUsed: winningLevel,
      matchedRuleId: winner.ruleId,
      assignedVendorId: winner.assignedVendorId,
      assignedFulfillmentMode: winner.assignedFulfillmentMode,
      defaultPharmacyDispatchMode: winner.defaultPharmacyDispatchMode,
      candidatesEvaluated: trace,
      routingPolicyDigest: input.routingPolicyDigest,
    },
  };
}

/**
 * §2.10 — a resolution assigning `vendor` mode must name a vendor; the other three modes are internal or
 * pharmacy paths where a null vendor is CORRECT rather than an unresolved routing failure. Mirrors the
 * §3.1.5 CHECK so the service rejects before the database does.
 */
export function isVendorAssignmentCoherent(resolved: RoutingRuleResolved): boolean {
  return resolved.assignedFulfillmentMode === "vendor"
    ? resolved.assignedVendorId !== null
    : resolved.assignedVendorId === null;
}
