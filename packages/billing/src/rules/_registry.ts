// @chartwarden/billing — M23 §4.5 / §11.A the VALIDATION RULE REGISTRY (D1). The configurable rule library
// is the architectural answer to the ">99% claim acceptance" / "31-point audit equivalent" promise:
// every claim runs through a set of typed predicates before it can leave READY. This file holds the
// registry container + the pure runner (mirrors `cost-report/src/validation/rule-engine.ts`); the 19
// platform-default rules live one-per-file in this directory and are assembled in `./index`.
//
// FREEZE-AT-BOOT INVARIANT (§4.5): the Phase-3 composition root registers every platform-default rule
// (and any MAC-profile / tenant-overlay rule) into a registry instance, then calls `freeze()` so the
// active rule set is immutable for the process lifetime. `registerRule` after `freeze()` THROWS — a
// rule set cannot mutate under a live request. Duplicate keys THROW (the key is the registry identity +
// the `validation_result.rule_key`).
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@chartwarden/db`, no `getSeam`, no clock. Types,
// pure functions, constants only. `runRules` is a DETERMINISTIC pure function of (rules, ctx, overrides)
// — given the same materialized `ValidationContext` it returns the same `RuleResult[]` every time. NO PHI.
import type { Rule, RuleParameters, RuleResult, ValidationContext } from "./types";

/** The platform-default rule-set version this package publishes (stamped into `validation_run.rule_set_version`). */
export const DEFAULT_RULE_SET_VERSION = 1;

/** Per-rule parameter overlays keyed by `rule.key` (the tenant `validation_rule_config.parameters` merge). */
export type RuleParameterOverlays = Readonly<Record<string, RuleParameters>>;

/**
 * The rolled-up outcome of a validation run — the shape feeding the §3.3 `validation_run` row. `passed`
 * counts both genuine passes AND skips (a skip is non-blocking, `passed: true`); `skipped` is the subset
 * of those that skipped. `blockingFailures` is the §2.3 submission guard's key: `regulatoryRequired`
 * rules that FAILED at `error` severity and were NOT overridden. A warn/info failure, a non-regulatory
 * failure, or a skip never contributes to it.
 */
export interface RuleRunSummary {
  readonly results: readonly RuleResult[];
  readonly passedCount: number;
  readonly failedCount: number;
  readonly warningCount: number;
  readonly skippedCount: number;
  readonly overriddenCount: number;
  readonly blockingFailures: number;
}

/**
 * A mutable-until-frozen container of `Rule`s keyed by `rule.key`. The Phase-3 boot wires the
 * platform-default set (+ MAC profiles + tenant overlays) then freezes; `runRules` is the pure executor.
 */
export class BillingRuleRegistry {
  private readonly rules = new Map<string, Rule>();
  private frozen = false;

  /** Register one rule. THROWS if the registry is frozen or the key is already registered. */
  registerRule(rule: Rule): void {
    if (this.frozen) {
      throw new Error(
        `BillingRuleRegistry is frozen; cannot register rule '${rule.key}' after boot.`,
      );
    }
    if (this.rules.has(rule.key)) {
      throw new Error(`Duplicate validation rule key '${rule.key}'.`);
    }
    this.rules.set(rule.key, rule);
  }

  /** Register many rules in order (convenience over `registerRule`). */
  registerRules(rules: Iterable<Rule>): void {
    for (const rule of rules) this.registerRule(rule);
  }

  /** Make the rule set immutable for the process lifetime (called once at boot). Idempotent. */
  freeze(): void {
    this.frozen = true;
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  /** All registered rules in registration order. */
  getRules(): readonly Rule[] {
    return [...this.rules.values()];
  }

  /** One rule by key, or `undefined`. */
  getRule(key: string): Rule | undefined {
    return this.rules.get(key);
  }

  /** Whether a rule key is registered. */
  has(key: string): boolean {
    return this.rules.has(key);
  }

  /** The keys of every `regulatoryRequired` rule — the platform floor a tenant cannot disable (D5). */
  regulatoryRequiredKeys(): readonly string[] {
    return this.getRules()
      .filter((r) => r.regulatoryRequired)
      .map((r) => r.key);
  }

  /**
   * Apply every registered rule against `ctx` and return the per-rule `RuleResult[]` in registration
   * order. Each rule's resolved parameters are its `defaultParameters` merged with the matching
   * `overlays[rule.key]` (tenant overlay wins). Pure + deterministic — no clock, no I/O, no seam calls.
   */
  runRules(ctx: ValidationContext, overlays: RuleParameterOverlays = {}): RuleResult[] {
    const results: RuleResult[] = [];
    for (const rule of this.rules.values()) {
      const params: RuleParameters = {
        ...(rule.defaultParameters ?? {}),
        ...(overlays[rule.key] ?? {}),
      };
      results.push(rule.check(ctx, params));
    }
    return results;
  }
}

/**
 * Roll the per-rule `results` up into the `validation_run` summary. `overriddenKeys` carries the rule
 * keys whose `error`-severity failure an elevated approver explicitly overrode (§2.2): an overridden
 * failure still counts in `failedCount` + `overriddenCount` but is removed from `blockingFailures`.
 * `regulatoryKeys` is the registry's regulatory-floor set (so the roll-up needs no rule objects).
 * Pure + deterministic.
 */
export function summarizeRuleRun(
  results: readonly RuleResult[],
  regulatoryKeys: ReadonlySet<string>,
  overriddenKeys: ReadonlySet<string> = new Set(),
): RuleRunSummary {
  let passedCount = 0;
  let failedCount = 0;
  let warningCount = 0;
  let skippedCount = 0;
  let overriddenCount = 0;
  let blockingFailures = 0;

  for (const r of results) {
    const isSkip = r.annotations?.skipReason !== undefined;
    if (isSkip) {
      skippedCount += 1;
      passedCount += 1; // a skip is non-blocking (passed: true)
      continue;
    }
    if (r.passed) {
      passedCount += 1;
      continue;
    }
    // A non-passing result, by severity:
    if (r.severity === "error") {
      failedCount += 1;
      const overridden = overriddenKeys.has(r.ruleKey);
      if (overridden) overriddenCount += 1;
      if (regulatoryKeys.has(r.ruleKey) && !overridden) blockingFailures += 1;
    } else if (r.severity === "warn") {
      warningCount += 1;
    } else {
      // info-severity non-pass: surfaced, never blocking, not a warning
      warningCount += 0;
    }
  }

  return {
    results: [...results],
    passedCount,
    failedCount,
    warningCount,
    skippedCount,
    overriddenCount,
    blockingFailures,
  };
}
