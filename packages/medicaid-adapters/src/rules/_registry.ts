// @wardenx/medicaid-adapters — M24 §4.6 / §11.A the MEDICAID VALIDATION RULE REGISTRY (D10). Mirrors the
// M23 BillingRuleRegistry: a mutable-until-frozen container keyed by rule.key + a pure deterministic runner.
// FREEZE-AT-BOOT: the Phase-3 composition root registers the 13 platform-default rules (+ tenant overlays)
// then freeze()s; register after freeze THROWS; duplicate keys THROW. PURE DOMAIN — no I/O, no clock, no PHI.
import { skip } from "./types";
import type { MedicaidRule, MedicaidValidationContext, RuleParameters, RuleResult } from "./types";

/** The platform-default rule-set version (stamped into medicaid_validation_run.rule_registry_version). */
export const DEFAULT_MEDICAID_RULE_SET_VERSION = "1";

/** Per-rule parameter overlays keyed by rule.key (the tenant medicaid_validation_rule_config merge). */
export type MedicaidRuleParameterOverlays = Readonly<Record<string, RuleParameters>>;

export interface MedicaidRuleRunSummary {
  readonly results: readonly RuleResult[];
  readonly passedCount: number;
  readonly failedCount: number;
  readonly warningCount: number;
  readonly skippedCount: number;
  readonly overriddenCount: number;
  /** regulatory-required rules that FAILED at error severity and were NOT overridden — the §2.3 gate. */
  readonly blockingFailures: number;
}

export class MedicaidRuleRegistry {
  private readonly rules = new Map<string, MedicaidRule>();
  private frozen = false;

  registerRule(rule: MedicaidRule): void {
    if (this.frozen) {
      throw new Error(
        `MedicaidRuleRegistry is frozen; cannot register rule '${rule.key}' after boot.`,
      );
    }
    if (this.rules.has(rule.key)) {
      throw new Error(`Duplicate Medicaid validation rule key '${rule.key}'.`);
    }
    this.rules.set(rule.key, rule);
  }

  registerRules(rules: readonly MedicaidRule[]): void {
    for (const r of rules) this.registerRule(r);
  }

  freeze(): void {
    this.frozen = true;
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  get(key: string): MedicaidRule | undefined {
    return this.rules.get(key);
  }

  all(): readonly MedicaidRule[] {
    return [...this.rules.values()];
  }
}

/** True iff `rule` applies to `ctx.serviceState` (empty applicableStates = all states). */
export function ruleAppliesToState(rule: MedicaidRule, serviceState: string): boolean {
  return rule.applicableStates.length === 0 || rule.applicableStates.includes(serviceState);
}

/**
 * Run a set of rules against a materialized context. DETERMINISTIC pure function: same inputs → same
 * results. A rule whose `applicableStates` excludes `ctx.serviceState` SKIPs `not_applicable`. `overridden`
 * is the set of rule keys an elevated approver has overridden (those failures don't count as blocking).
 */
export function runMedicaidRules(
  rules: readonly MedicaidRule[],
  ctx: MedicaidValidationContext,
  overlays: MedicaidRuleParameterOverlays = {},
  overridden: ReadonlySet<string> = new Set(),
): MedicaidRuleRunSummary {
  const results: RuleResult[] = [];
  let passedCount = 0;
  let failedCount = 0;
  let warningCount = 0;
  let skippedCount = 0;
  let overriddenCount = 0;
  let blockingFailures = 0;

  for (const rule of rules) {
    let result: RuleResult;
    if (!ruleAppliesToState(rule, ctx.serviceState)) {
      result = skip(
        rule.key,
        rule.severity,
        "not_applicable",
        `Not applicable in ${ctx.serviceState}.`,
      );
    } else {
      const params = { ...(rule.defaultParameters ?? {}), ...(overlays[rule.key] ?? {}) };
      result = rule.check(ctx, params);
    }
    results.push(result);

    const isSkippedResult = result.annotations?.skipReason !== undefined;
    if (isSkippedResult) {
      skippedCount += 1;
      passedCount += 1; // a skip is non-blocking
      continue;
    }
    if (result.passed) {
      passedCount += 1;
      continue;
    }
    // a genuine failure
    if (result.severity === "warn" || result.severity === "info") warningCount += 1;
    else failedCount += 1;

    const wasOverridden = overridden.has(rule.key);
    if (wasOverridden) overriddenCount += 1;
    if (rule.regulatoryRequired && result.severity === "error" && !wasOverridden) {
      blockingFailures += 1;
    }
  }

  return {
    results,
    passedCount,
    failedCount,
    warningCount,
    skippedCount,
    overriddenCount,
    blockingFailures,
  };
}
