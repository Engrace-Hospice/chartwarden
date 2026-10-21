// @chartwarden/cost-report — M27 validation RULE ENGINE (§2.2 `cost_report_validation` lifecycle, D9, D16,
// D21). `runValidation` applies a rule list against a `ValidationContext` and rolls up the per-rule
// outcomes into the counts the §3.3 `cost_report_validation` row persists (passed/failed/warning/
// overridden/skipped) plus the count of BLOCKING regulatory failures. A `regulatoryRequired` rule that
// fails is BLOCKING — it cannot be skip-and-submit'd (M27-F08); the §2.3 `approve_for_submit` guard
// keys on `blockingRulesFailing === 0` (i.e. `failed_count − overridden_count = 0` over the regulatory
// floor).
//
// MAC-scoping (D16): a rule applies only when its `macJurisdictionScope` is `'all'` or names the
// context's MAC. Deprecated / draft-suggestion rules (§2.1 `status`) are not executed. The whole function
// is PURE and DETERMINISTIC (D8) — given the same rules + context + overridden set, it returns the same
// summary every time; no clock, no I/O. No PHI (D18).
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@chartwarden/db`, no `getSeam`. Types, pure
// functions, constants only.
import type { RuleDef, RuleResult, ValidationContext } from "./types";

/** One rule's evaluated result, carrying enough rule metadata to persist a `cost_report_validation_result`. */
export interface EvaluatedRule {
  readonly ruleCode: string;
  readonly category: RuleDef["category"];
  readonly severity: RuleDef["severity"];
  readonly regulatoryRequired: boolean;
  readonly macJurisdictionScope: string;
  /** Whether this rule's failure was explicitly overridden (only meaningful when `outcome === 'fail'`). */
  readonly overridden: boolean;
  readonly result: RuleResult;
}

/** The rolled-up outcome of a validation run — the shape feeding the §3.3 `cost_report_validation` row. */
export interface ValidationRunSummary {
  readonly results: readonly EvaluatedRule[];
  readonly passedCount: number;
  readonly failedCount: number;
  readonly warningCount: number;
  readonly overriddenCount: number;
  readonly skippedCount: number;
  /**
   * Count of `regulatoryRequired` rules whose outcome is `fail` and that were NOT overridden — the
   * blocking set. `approve_for_submit` requires this to be 0 (M27-F08); a non-regulatory failure or a
   * skip (seam-unbound, not-applicable) never contributes here.
   */
  readonly blockingRulesFailing: number;
}

/**
 * True iff a rule's MAC scope covers `macJurisdiction`. Scope is `'all'` or a comma-separated MAC list
 * (D16). Matching is exact per token (trimmed) and case-insensitive; an empty/`'all'` scope always
 * applies.
 */
function ruleAppliesToMac(scope: string, macJurisdiction: string): boolean {
  const normalized = scope.trim().toLowerCase();
  if (normalized === "" || normalized === "all") return true;
  const target = macJurisdiction.trim().toLowerCase();
  return normalized.split(",").some((token) => token.trim() === target);
}

/**
 * Apply `rules` against `ctx` and roll up the per-rule outcomes. Only `active`-status (the default when
 * `status` is omitted) rules whose MAC scope covers the context's MAC are executed; everything else is
 * filtered out (not counted). `overriddenRuleCodes` carries the rule codes whose failure the Compliance
 * Officer explicitly overrode (§2.2) — an overridden failure still counts in `failedCount` and
 * `overriddenCount` but is removed from `blockingRulesFailing`. Pure + deterministic (D8).
 */
export function runValidation(
  rules: readonly RuleDef[],
  ctx: ValidationContext,
  overriddenRuleCodes: ReadonlySet<string> = new Set(),
): ValidationRunSummary {
  const results: EvaluatedRule[] = [];
  let passedCount = 0;
  let failedCount = 0;
  let warningCount = 0;
  let overriddenCount = 0;
  let skippedCount = 0;
  let blockingRulesFailing = 0;

  for (const rule of rules) {
    const status = rule.status ?? "active";
    if (status !== "active") continue;
    if (!ruleAppliesToMac(rule.macJurisdictionScope, ctx.macJurisdiction)) continue;

    const result = rule.evaluate(ctx);
    const isFail = result.outcome === "fail";
    const overridden = isFail && overriddenRuleCodes.has(rule.ruleCode);

    switch (result.outcome) {
      case "pass":
        passedCount += 1;
        break;
      case "fail":
        failedCount += 1;
        if (overridden) overriddenCount += 1;
        if (rule.regulatoryRequired && !overridden) blockingRulesFailing += 1;
        break;
      case "warn":
        warningCount += 1;
        break;
      case "skip":
        skippedCount += 1;
        break;
    }

    results.push({
      ruleCode: rule.ruleCode,
      category: rule.category,
      severity: rule.severity,
      regulatoryRequired: rule.regulatoryRequired,
      macJurisdictionScope: rule.macJurisdictionScope,
      overridden,
      result,
    });
  }

  return {
    results,
    passedCount,
    failedCount,
    warningCount,
    overriddenCount,
    skippedCount,
    blockingRulesFailing,
  };
}
