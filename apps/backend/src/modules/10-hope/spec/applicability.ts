import type { HopeIsc } from "../hope-spec-registry";

export type HopeApplicabilityState = "applicable" | "not_applicable" | "pending";

export interface HopeAnswerSnapshot {
  readonly state: "answered" | "skipped";
  readonly value: unknown | null;
}

export type HopeAnswerMap = ReadonlyMap<string, HopeAnswerSnapshot>;

export interface HopeApplicabilityReason {
  readonly ruleId: string;
  readonly cmsRuleId?: string;
  readonly dependsOn: readonly string[];
}

export interface HopeApplicabilityItemResult {
  readonly active: boolean;
  readonly applicability: HopeApplicabilityState;
  readonly reason?: HopeApplicabilityReason;
}

export interface HopeApplicabilityResult {
  readonly items: ReadonlyMap<string, HopeApplicabilityItemResult>;
}

export interface HopeApplicabilityRule {
  readonly id: string;
  readonly cmsRuleId?: string;
  readonly description: string;
  readonly dependsOn: readonly string[];
  readonly affects: readonly string[];
  evaluate(answers: HopeAnswerMap): ReadonlyMap<string, HopeApplicabilityState>;
}

export interface HopeApplicabilityEngine {
  readonly specVersionCode: string;
  readonly rules: readonly HopeApplicabilityRule[];
  evaluate(input: {
    readonly isc: HopeIsc;
    readonly activeItemCodes: readonly string[];
    readonly answers: HopeAnswerMap;
  }): HopeApplicabilityResult;
}

export class HopeApplicabilitySpecUnsupportedError extends Error {
  constructor(readonly specVersionCode: string) {
    super(`HOPE applicability rules are not registered for spec version ${specVersionCode}`);
    this.name = "HopeApplicabilitySpecUnsupportedError";
  }
}

export class HopeApplicabilityRuleCycleError extends Error {
  constructor(readonly ruleIds: readonly string[]) {
    super(`HOPE applicability rule graph contains an unsupported cycle: ${ruleIds.join(" -> ")}`);
    this.name = "HopeApplicabilityRuleCycleError";
  }
}

export function answerValue(answers: HopeAnswerMap, itemCode: string): string | null {
  const answer = answers.get(itemCode);
  return answer?.state === "answered" && typeof answer.value === "string" ? answer.value : null;
}

export function createRule(input: Omit<HopeApplicabilityRule, "evaluate"> & {
  readonly evaluate: (answers: HopeAnswerMap) => Record<string, HopeApplicabilityState>;
}): HopeApplicabilityRule {
  return {
    ...input,
    evaluate: (answers) => new Map(Object.entries(input.evaluate(answers))),
  };
}

export function assertAcyclicApplicabilityRules(rules: readonly HopeApplicabilityRule[]): void {
  const byOutput = new Map<string, string>();
  for (const rule of rules) for (const output of rule.affects) byOutput.set(output, rule.id);
  const edges = new Map<string, string[]>();
  for (const rule of rules) {
    edges.set(
      rule.id,
      rule.dependsOn.flatMap((input) => {
        const producer = byOutput.get(input);
        return producer && producer !== rule.id ? [producer] : [];
      }),
    );
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (ruleId: string, path: string[]) => {
    if (visited.has(ruleId)) return;
    if (visiting.has(ruleId)) throw new HopeApplicabilityRuleCycleError([...path, ruleId]);
    visiting.add(ruleId);
    for (const next of edges.get(ruleId) ?? []) visit(next, [...path, ruleId]);
    visiting.delete(ruleId);
    visited.add(ruleId);
  };
  for (const rule of rules) visit(rule.id, []);
}

export function evaluateRules(input: {
  readonly rules: readonly HopeApplicabilityRule[];
  readonly isc: HopeIsc;
  readonly activeItemCodes: readonly string[];
  readonly answers: HopeAnswerMap;
}): HopeApplicabilityResult {
  const active = new Set(input.activeItemCodes);
  const states = new Map<string, HopeApplicabilityItemResult>();
  for (const itemCode of active) states.set(itemCode, { active: true, applicability: "applicable" });

  for (const rule of input.rules) {
    const evaluated = rule.evaluate(input.answers);
    for (const [itemCode, applicability] of evaluated) {
      if (!active.has(itemCode)) continue;
      const previous = states.get(itemCode);
      const reason: HopeApplicabilityReason = rule.cmsRuleId
        ? { ruleId: rule.id, cmsRuleId: rule.cmsRuleId, dependsOn: rule.dependsOn }
        : { ruleId: rule.id, dependsOn: rule.dependsOn };
      if (!previous || previous.applicability === "not_applicable") continue;
      if (applicability === "not_applicable" || previous.applicability !== "pending") {
        states.set(itemCode, { active: true, applicability, reason });
      }
    }
  }

  return { items: states };
}
