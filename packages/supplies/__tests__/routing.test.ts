import { describe, expect, it } from "vitest";

import {
  ROUTING_PRECEDENCE_ORDER,
  ROUTING_RESOLVER_VERSION,
  type RoutingRuleCandidate,
  isVendorAssignmentCoherent,
  resolveVendorRouting,
} from "../src/routing/precedence";

const ORG = "org-1";
const LOC = "loc-1";
const SKU = "sku-1";
const AT = new Date("2026-07-01T12:00:00Z");

const rule = (over: Partial<RoutingRuleCandidate> & Pick<RoutingRuleCandidate, "ruleId" | "scopeKind">): RoutingRuleCandidate => ({
  scopeId: null,
  skuClassPattern: "E",
  assignedVendorId: "vendor-default",
  assignedFulfillmentMode: "vendor",
  defaultPharmacyDispatchMode: null,
  precedencePriority: 100,
  isActive: true,
  effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  effectiveTo: null,
  ...over,
});

const input = {
  orgId: ORG,
  locationId: LOC,
  skuId: SKU,
  skuClass: "E",
  resolvedAt: AT,
  routingPolicyDigest: "sha256:test",
};

describe("D4 precedence ladder", () => {
  it("orders most-specific first", () => {
    expect([...ROUTING_PRECEDENCE_ORDER]).toEqual(["sku", "location", "tenant", "platform"]);
  });

  it("takes the per-SKU pin over every broader rule", () => {
    const res = resolveVendorRouting(
      [
        rule({ ruleId: "r-platform", scopeKind: "platform", assignedVendorId: "v-platform" }),
        rule({ ruleId: "r-tenant", scopeKind: "tenant", scopeId: ORG, assignedVendorId: "v-tenant" }),
        rule({ ruleId: "r-loc", scopeKind: "location", scopeId: LOC, assignedVendorId: "v-loc" }),
        rule({ ruleId: "r-sku", scopeKind: "sku", scopeId: SKU, assignedVendorId: "v-sku" }),
      ],
      input,
    );
    expect(res.ok).toBe(true);
    expect(res.resolved.precedenceLevelUsed).toBe("sku");
    expect(res.resolved.assignedVendorId).toBe("v-sku");
    expect(res.resolved.matchedRuleId).toBe("r-sku");
    expect(res.resolved.resolverVersion).toBe(ROUTING_RESOLVER_VERSION);
  });

  it("falls to the tenant default when the location rule is for another sku class", () => {
    const res = resolveVendorRouting(
      [
        rule({ ruleId: "r-loc", scopeKind: "location", scopeId: LOC, skuClassPattern: "A" }),
        rule({ ruleId: "r-tenant", scopeKind: "tenant", scopeId: ORG, assignedVendorId: "v-tenant" }),
      ],
      input,
    );
    expect(res.resolved.precedenceLevelUsed).toBe("tenant");
    expect(
      res.resolved.candidatesEvaluated.find((c) => c.ruleId === "r-loc")?.reason,
    ).toBe("sku_class_mismatch");
  });

  it("ignores a rule that is not effective at the resolution instant", () => {
    const res = resolveVendorRouting(
      [
        rule({
          ruleId: "r-sku-expired",
          scopeKind: "sku",
          scopeId: SKU,
          effectiveTo: new Date("2026-06-01T00:00:00Z"),
        }),
        rule({ ruleId: "r-tenant", scopeKind: "tenant", scopeId: ORG, assignedVendorId: "v-tenant" }),
      ],
      input,
    );
    expect(res.resolved.precedenceLevelUsed).toBe("tenant");
    expect(
      res.resolved.candidatesEvaluated.find((c) => c.ruleId === "r-sku-expired")?.reason,
    ).toBe("not_effective_at_resolution_time");
  });

  it("breaks a within-scope tie on precedencePriority, lowest first", () => {
    const res = resolveVendorRouting(
      [
        rule({ ruleId: "r-b", scopeKind: "tenant", scopeId: ORG, precedencePriority: 50, assignedVendorId: "v-b" }),
        rule({ ruleId: "r-a", scopeKind: "tenant", scopeId: ORG, precedencePriority: 10, assignedVendorId: "v-a" }),
      ],
      input,
    );
    expect(res.resolved.matchedRuleId).toBe("r-a");
    expect(
      res.resolved.candidatesEvaluated.find((c) => c.ruleId === "r-b")?.reason,
    ).toBe("outranked_within_scope");
  });

  it("breaks a priority tie deterministically on ruleId", () => {
    const rules = [
      rule({ ruleId: "r-zzz", scopeKind: "tenant", scopeId: ORG }),
      rule({ ruleId: "r-aaa", scopeKind: "tenant", scopeId: ORG }),
    ];
    expect(resolveVendorRouting(rules, input).resolved.matchedRuleId).toBe("r-aaa");
    expect(resolveVendorRouting([...rules].reverse(), input).resolved.matchedRuleId).toBe("r-aaa");
  });

  it("records the roads not taken, not just the road taken", () => {
    const res = resolveVendorRouting(
      [
        rule({ ruleId: "r-sku-other", scopeKind: "sku", scopeId: "sku-other" }),
        rule({ ruleId: "r-tenant", scopeKind: "tenant", scopeId: ORG }),
      ],
      input,
    );
    expect(res.resolved.candidatesEvaluated).toHaveLength(2);
    expect(
      res.resolved.candidatesEvaluated.find((c) => c.ruleId === "r-sku-other")?.reason,
    ).toBe("no_pin_for_sku");
    expect(res.resolved.routingPolicyDigest).toBe("sha256:test");
  });

  it("fails rather than inventing a fallback vendor when nothing matches", () => {
    const res = resolveVendorRouting([], input);
    expect(res.ok).toBe(false);
    expect(res.resolved.assignedVendorId).toBeNull();
    expect(res.resolved.matchedRuleId).toBeNull();
  });

  it("resolves a comfort-kit request with a null skuId through the kit class", () => {
    const res = resolveVendorRouting(
      [
        rule({
          ruleId: "r-kit",
          scopeKind: "tenant",
          scopeId: ORG,
          skuClassPattern: "comfort_kit",
          assignedVendorId: null,
          assignedFulfillmentMode: "internal_supply_hub",
          defaultPharmacyDispatchMode: "supply_hub_dispatch",
        }),
      ],
      { ...input, skuId: null, skuClass: "comfort_kit" },
    );
    expect(res.ok).toBe(true);
    expect(res.resolved.assignedFulfillmentMode).toBe("internal_supply_hub");
    expect(res.resolved.defaultPharmacyDispatchMode).toBe("supply_hub_dispatch");
  });
});

describe("§2.10 vendor-assignment coherence", () => {
  const base = {
    resolverVersion: ROUTING_RESOLVER_VERSION,
    resolvedAt: AT.toISOString(),
    precedenceLevelUsed: "tenant" as const,
    matchedRuleId: "r-1",
    defaultPharmacyDispatchMode: null,
    candidatesEvaluated: [],
    routingPolicyDigest: "sha256:test",
  };

  it("requires a vendor id in vendor mode", () => {
    expect(
      isVendorAssignmentCoherent({ ...base, assignedFulfillmentMode: "vendor", assignedVendorId: "v" }),
    ).toBe(true);
    expect(
      isVendorAssignmentCoherent({ ...base, assignedFulfillmentMode: "vendor", assignedVendorId: null }),
    ).toBe(false);
  });

  it("treats a null vendor on the internal-hub path as correct, not unresolved", () => {
    expect(
      isVendorAssignmentCoherent({
        ...base,
        assignedFulfillmentMode: "internal_supply_hub",
        assignedVendorId: null,
      }),
    ).toBe(true);
    expect(
      isVendorAssignmentCoherent({
        ...base,
        assignedFulfillmentMode: "internal_supply_hub",
        assignedVendorId: "v",
      }),
    ).toBe(false);
  });
});
