// @chartwarden/assessments — significant-change rule taxonomy (§2.4, §4.9, D2).
//
// The rule-id enum + the CRITICAL_RULES severity floor live in the leaf `@chartwarden/types` (so M36 +
// every consumer reads them without a feature-package import). This module re-exports that surface and
// adds the per-rule → scale mapping the detector keys on. The rule EVALUATORS (delta math + D2
// tenant-override floor enforcement) land in `detector.ts` (M9-T08); this file is the metadata surface
// (rule→scale map + first-emission severity) the detector and the §4.9 alert builder share.

import { CRITICAL_RULES, isCriticalRule } from "@chartwarden/types";
import type {
  AssessmentAlertSeverity,
  ScaleType,
  SignificantChangeRuleId,
} from "@chartwarden/types";

export { CRITICAL_RULES, isCriticalRule };
export type { SignificantChangeRuleId, AssessmentAlertSeverity };

/** The scale each §2.4 rule evaluates against (so the detector dispatches only the relevant rules per
 * captured `scaleType`). D2 thresholds + tenant-override floors are applied in the per-scale
 * `thresholds.ts` modules (M9-T08). */
export const RULE_SCALE: { readonly [K in SignificantChangeRuleId]: ScaleType } = {
  pps_drop_20_in_14d: "pps",
  kps_drop_20_in_14d: "kps",
  esas_total_increase_20_in_7d: "esas_r",
  esas_symptom_ge_7: "esas_r",
  painad_ge_4: "painad",
  nyha_class_iv: "nyha",
  braden_le_12: "braden",
  morse_ge_51: "morse",
  meld_ge_30: "meld",
  fast_progression_30d: "fast",
  gds_progression_30d: "gds",
  flacker_increase: "flacker",
  aims_emergent_dyskinesia: "aims",
};

/** The §2.4 rules that may fire for a captured `scaleType` (the detector's per-scale dispatch list). */
export function rulesForScale(scaleType: ScaleType): SignificantChangeRuleId[] {
  return (Object.keys(RULE_SCALE) as SignificantChangeRuleId[]).filter(
    (ruleId) => RULE_SCALE[ruleId] === scaleType,
  );
}

/** §4.9 — the severity a rule emits at FIRST emission (CRITICAL → `clinical_urgent`, else `medium`);
 * the 24h no-ack escalation cron upgrades `medium` → `high` (M9-T06). */
export function firstEmissionSeverity(ruleId: SignificantChangeRuleId): AssessmentAlertSeverity {
  return isCriticalRule(ruleId) ? "clinical_urgent" : "medium";
}
