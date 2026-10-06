// apps/backend/__tests__/m34-alert-rule-seed.test.ts — GAP-098.
//
// M34's §4.8 alert rules have been declared since the module was written and NEVER seeded — the file's
// own footer called the UPSERT a "Phase 2D TODO" and nothing performed it, so every `m34.*` rule was
// dormant. GAP-098 needs one of them (`tenant_export.oversized_hold`) to actually fire, which forced
// the seed to exist.
//
// The seed is PARTIAL on purpose, and these tests pin the reason. M36's resolver registry THROWS
// `UnknownRecipientResolverError` on an unregistered name, and M34's own two resolvers are implemented
// (`registerM34AlertResolvers`) but never bound at boot — so seeding a rule that names one would turn a
// dormant rule into a FAILING emit. Only rules naming an M36 built-in are seeded. If someone later binds
// those resolvers, the `seedable` set widens on its own; if someone adds a rule with a typo'd resolver,
// the last test here catches it before it reaches a boot.
import { describe, expect, it } from "vitest";
import {
  M34_ALERT_RESOLVER_NAMES,
  M34_ALERT_RULES,
  M34_ALERT_RULE_KEYS,
  M36_BUILT_IN_RESOLVERS,
  PLATFORM_OPS_ROLE_KEY,
  seedableM34AlertRules,
} from "../src/modules/34-saas-tenant-platform/alert-rules";

describe("M34 §4.8 alert-rule seed (GAP-098)", () => {
  it("ships the oversized-hold rule keyed on the event the hold port emits", () => {
    const rule = M34_ALERT_RULES.find((r) => r.ruleKey === "tenant_export.oversized_hold");
    expect(rule).toBeDefined();
    // The eventType is what `AlertEmitter.emit` matches on — it must equal the string
    // `holdForOversizedApproval` passes, or the alert fires and matches no rule.
    expect(rule?.eventType).toBe("m34.tenant_export.oversized_hold");
    expect(rule?.enabled).toBe(true);
    // A held bundle blocks a tenant's migration/BAA-termination until someone acts — the floor is the
    // top of M36's three-level ladder, not `warn`.
    expect(rule?.severityFloor).toBe("critical");
  });

  it("routes the oversized-hold rule at a resolver that resolves real people TODAY", () => {
    const rule = M34_ALERT_RULES.find((r) => r.ruleKey === "tenant_export.oversized_hold");
    expect(M36_BUILT_IN_RESOLVERS).toContain(rule?.recipientResolver);
    expect(rule?.recipientResolver).toBe("role_set");
    expect(rule?.resolverArgs).toEqual({ roleKeys: [PLATFORM_OPS_ROLE_KEY] });
  });

  it("seeds a critical rule for the kill-switch emergency event, routed at real people today", () => {
    const rule = M34_ALERT_RULES.find(
      (r) => r.ruleKey === "feature_flag.platform_emergency_changed",
    );
    expect(rule?.eventType).toBe("m34.feature_flag.platform_emergency_changed");
    expect(rule?.severityFloor).toBe("critical");
    expect(rule?.enabled).toBe(true);
    expect(seedableM34AlertRules().some((r) => r.ruleKey === rule?.ruleKey)).toBe(true);
  });

  it("seeds ONLY rules whose resolver is an M36 built-in", () => {
    for (const rule of seedableM34AlertRules()) {
      expect(
        M36_BUILT_IN_RESOLVERS.includes(rule.recipientResolver),
        `${rule.ruleKey} names ${rule.recipientResolver}`,
      ).toBe(true);
    }
  });

  it("skips — does not seed — every rule naming an M34 resolver that is unbound at boot", () => {
    const seeded = new Set(seedableM34AlertRules().map((r) => r.ruleKey));
    const unbound = M34_ALERT_RULES.filter((r) =>
      (M34_ALERT_RESOLVER_NAMES as readonly string[]).includes(r.recipientResolver),
    );
    // The gap is real and this test documents its size rather than asserting it away.
    expect(unbound.length).toBeGreaterThan(0);
    for (const rule of unbound) expect(seeded.has(rule.ruleKey)).toBe(false);
  });

  it("every rule names either an M36 built-in or one of M34's two declared resolvers", () => {
    // The typo guard: a resolver name that is neither would be silently skipped by the seed filter and
    // then throw the day it was bound. Catch it here instead.
    const known = new Set([...M36_BUILT_IN_RESOLVERS, ...M34_ALERT_RESOLVER_NAMES]);
    for (const rule of M34_ALERT_RULES) {
      expect(known.has(rule.recipientResolver), `${rule.ruleKey} → ${rule.recipientResolver}`).toBe(
        true,
      );
    }
  });

  it("keeps the canonical key list in step with the rule table", () => {
    for (const key of M34_ALERT_RULE_KEYS) {
      expect(
        M34_ALERT_RULES.some((r) => r.ruleKey === key || r.ruleKey.startsWith(`${key}.`)),
        `no rule row for declared key ${key}`,
      ).toBe(true);
    }
    expect(M34_ALERT_RULE_KEYS).toContain("tenant_export.oversized_hold");
  });
});
