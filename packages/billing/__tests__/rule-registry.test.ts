import type { Rule } from "@wardenx/billing";
import {
  BillingRuleRegistry,
  DEFAULT_BILLING_RULES,
  DEFAULT_RULE_SET_VERSION,
  createDefaultBillingRegistry,
  summarizeRuleRun,
} from "@wardenx/billing";
// @wardenx/billing — M23 §4.5 the validation RULE REGISTRY pure-domain unit tests (D1). Covers the
// freeze-at-boot invariant (registration is rejected after `freeze()`, duplicate keys throw), the
// platform-default registry factory (22 rules, 19 regulatory), `runRules` producing exactly one result per
// registered rule in registration order, the determinism that underpins the §2.6 `run_input_hash`
// idempotency, and `summarizeRuleRun`'s §2.3 blocking-failure roll-up (regulatory error ⇒ blocking; an
// overridden failure leaves the blocking set but stays counted; a warn failure never blocks).
//
// PURE DOMAIN only — no DB, no Fastify, no clock; no PHI (D13).
import { describe, expect, it } from "vitest";
import { passingContext } from "./_fixtures";

// A trivial always-passing rule for registry-mechanics tests (no context dependence).
function stubRule(key: string): Rule {
  return {
    key,
    version: 1,
    category: "eligibility",
    title: `stub ${key}`,
    description: "test stub",
    severity: "error",
    regulatoryRequired: false,
    check: () => ({ ruleKey: key, severity: "error", passed: true, message: "ok" }),
  };
}

describe("BillingRuleRegistry — freeze-at-boot invariant (§4.5)", () => {
  it("registers rules until frozen, then rejects further registration", () => {
    const reg = new BillingRuleRegistry();
    expect(reg.isFrozen).toBe(false);
    reg.registerRule(stubRule("a"));
    reg.freeze();
    expect(reg.isFrozen).toBe(true);
    expect(() => reg.registerRule(stubRule("b"))).toThrow(/frozen/i);
  });

  it("freeze() is idempotent", () => {
    const reg = new BillingRuleRegistry();
    reg.freeze();
    expect(() => reg.freeze()).not.toThrow();
    expect(reg.isFrozen).toBe(true);
  });

  it("rejects a duplicate rule key", () => {
    const reg = new BillingRuleRegistry();
    reg.registerRule(stubRule("dup"));
    expect(() => reg.registerRule(stubRule("dup"))).toThrow(/duplicate/i);
  });

  it("getRule / has / getRules reflect registration order", () => {
    const reg = new BillingRuleRegistry();
    reg.registerRules([stubRule("x"), stubRule("y"), stubRule("z")]);
    expect(reg.has("y")).toBe(true);
    expect(reg.has("nope")).toBe(false);
    expect(reg.getRule("x")?.key).toBe("x");
    expect(reg.getRules().map((r) => r.key)).toEqual(["x", "y", "z"]);
  });
});

describe("createDefaultBillingRegistry — the platform-floor set", () => {
  it("publishes a rule-set version", () => {
    expect(DEFAULT_RULE_SET_VERSION).toBe(1);
  });

  it("DEFAULT_BILLING_RULES holds 22 rules with unique keys", () => {
    expect(DEFAULT_BILLING_RULES).toHaveLength(22);
    const keys = DEFAULT_BILLING_RULES.map((r) => r.key);
    expect(new Set(keys).size).toBe(22);
  });

  it("builds a fresh, UN-frozen registry pre-loaded with the 22 defaults", () => {
    const reg = createDefaultBillingRegistry();
    expect(reg.isFrozen).toBe(false);
    expect(reg.getRules()).toHaveLength(22);
    // a fresh instance each call (no shared singleton)
    expect(createDefaultBillingRegistry()).not.toBe(reg);
  });

  it("exposes exactly 19 regulatory-required keys (the D5 floor a tenant cannot disable)", () => {
    const reg = createDefaultBillingRegistry();
    const regKeys = reg.regulatoryRequiredKeys();
    expect(regKeys).toHaveLength(19);
    expect(regKeys).toContain("election_addendum_signed"); // FY2027, 42 CFR 418.24(c)
    expect(regKeys).toContain("f2f_telehealth_g0679"); // FY2027, CR 14495
    expect(regKeys).not.toContain("eligibility_check_freshness_30d"); // non-regulatory (warn)
    expect(regKeys).not.toContain("evv_bracket_coherence"); // ADR-0008: operational, never a Medicare regulatory floor
    expect(regKeys).not.toContain("rhc_carry_over_hets_fresh"); // a pricing-accuracy warning, not a floor
  });
});

describe("runRules — one result per rule, in registration order", () => {
  it("returns exactly one RuleResult per registered rule, key-aligned to the registry order", () => {
    const reg = createDefaultBillingRegistry();
    const results = reg.runRules(passingContext());
    expect(results).toHaveLength(22);
    expect(results.map((r) => r.ruleKey)).toEqual(DEFAULT_BILLING_RULES.map((r) => r.key));
  });

  it("is DETERMINISTIC — the same context yields byte-identical results (underpins run_input_hash idempotency)", () => {
    // The §2.6 `run_input_hash` (a service-layer sha256 over the materialized context + claim version) is
    // only a stable idempotency key BECAUSE runRules is a pure, deterministic function of its inputs.
    const reg = createDefaultBillingRegistry();
    const ctx = passingContext();
    const a = reg.runRules(ctx);
    const b = reg.runRules(ctx);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // and a fresh registry over the same context produces the same vector.
    expect(JSON.stringify(createDefaultBillingRegistry().runRules(ctx))).toBe(JSON.stringify(a));
  });

  it("applies a tenant parameter overlay (eligibility freshness window widened) over the default", () => {
    const reg = createDefaultBillingRegistry();
    const ctx = {
      ...passingContext(),
      eligibility: { ...passingContext().eligibility!, ageDays: 45 },
    };
    // default maxAgeDays=30 ⇒ stale ⇒ warn fail; overlay maxAgeDays=60 ⇒ passes.
    const def = reg.runRules(ctx).find((r) => r.ruleKey === "eligibility_check_freshness_30d");
    const overlaid = reg
      .runRules(ctx, { eligibility_check_freshness_30d: { maxAgeDays: 60 } })
      .find((r) => r.ruleKey === "eligibility_check_freshness_30d");
    expect(def?.passed).toBe(false);
    expect(overlaid?.passed).toBe(true);
  });
});

describe("summarizeRuleRun — the §2.3 blocking-failure roll-up", () => {
  function regulatoryKeys() {
    return new Set(createDefaultBillingRegistry().regulatoryRequiredKeys());
  }

  it("a fully-passing context has zero failures and zero blocking failures", () => {
    const reg = createDefaultBillingRegistry();
    const summary = summarizeRuleRun(reg.runRules(passingContext()), regulatoryKeys());
    expect(summary.failedCount).toBe(0);
    expect(summary.blockingFailures).toBe(0);
    // skips count as passed; partition (no info-severity fails in the default set):
    expect(summary.passedCount + summary.failedCount + summary.warningCount).toBe(
      summary.results.length,
    );
    expect(summary.skippedCount).toBeGreaterThan(0); // sia + the two cap rules skip
    expect(summary.skippedCount).toBeLessThanOrEqual(summary.passedCount);
  });

  it("a regulatory error failure contributes to blockingFailures", () => {
    const reg = createDefaultBillingRegistry();
    const ctx = passingContext();
    const failing = {
      ...ctx,
      eligibility: { ...ctx.eligibility!, outcome: "inactive_part_a" as const },
    };
    const summary = summarizeRuleRun(reg.runRules(failing), regulatoryKeys());
    expect(summary.failedCount).toBe(1);
    expect(summary.blockingFailures).toBe(1);
  });

  it("an OVERRIDDEN regulatory failure leaves the blocking set but is still counted as failed", () => {
    const reg = createDefaultBillingRegistry();
    const ctx = passingContext();
    const failing = {
      ...ctx,
      eligibility: { ...ctx.eligibility!, outcome: "inactive_part_a" as const },
    };
    const summary = summarizeRuleRun(
      reg.runRules(failing),
      regulatoryKeys(),
      new Set(["patient_eligibility_part_a_active"]),
    );
    expect(summary.failedCount).toBe(1);
    expect(summary.overriddenCount).toBe(1);
    expect(summary.blockingFailures).toBe(0);
  });

  it("a WARN failure (stale eligibility, non-regulatory) never blocks", () => {
    const reg = createDefaultBillingRegistry();
    const ctx = passingContext();
    const stale = { ...ctx, eligibility: { ...ctx.eligibility!, ageDays: 99 } };
    const summary = summarizeRuleRun(reg.runRules(stale), regulatoryKeys());
    expect(summary.warningCount).toBeGreaterThanOrEqual(1);
    expect(summary.failedCount).toBe(0); // a warn non-pass is not a "failed" (error) result
    expect(summary.blockingFailures).toBe(0);
  });
});
