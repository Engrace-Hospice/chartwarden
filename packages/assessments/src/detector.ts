// @chartwarden/assessments — §2.4 significant-change DETECTOR (delta math + D2 tenant-override floor
// enforcement), M9-T08.
//
// The pure evaluators the recording transaction (§9.6: detection adds < 30 ms to the insert path) runs
// after scoring: given the just-recorded score, the active prior series for the same patient × scale, and
// the tenant's `scale_policy` overrides, it returns every §2.4 threshold-crossing rule that fired with the
// `deltaValue` / `thresholdValue` / `severity` the §4.9 alert payload + the `significant_change_event` row
// carry. The detector is PURE — no DB, no clock; the caller supplies the prior series and `capturedAt`.
//
// D2 (tenant overrides may only TIGHTEN, never loosen; the platform floor is hard-coded): a tenant may
// make a rule fire MORE readily (a lower `≥` trigger, a higher `≤` trigger, a smaller required delta) down
// to — but never past — the clinical floor, and may NEVER make it fire less readily than the platform
// default. A loosening or floor-piercing override raises `SIGNIFICANT_CHANGE_FLOOR_VIOLATION` (it is
// rejected at policy-write time, never silently clamped). The §9.1 canonical case — a tenant cannot set
// `painad ≥ 3` when the floor is `≥ 4` — is enforced by `resolveSignificantChangeThreshold`.

import type {
  AssessmentAlertSeverity,
  ScaleType,
  SignificantChangeRuleId,
} from "@chartwarden/types";
import { require_ } from "./errors";
import { RULE_SCALE, firstEmissionSeverity } from "./significant-change";

/** How a rule's numeric `threshold` is compared to the observed value, which fixes the "tighten" direction
 * (D2). `ge`/`le` are absolute single-reading severity rules; `dropGe`/`increaseGe` are windowed deltas. */
export type SignificantChangeComparator = "ge" | "le" | "dropGe" | "increaseGe";

/** A numeric §2.4 rule: its comparator, the `platform` default (the value the rule name encodes), the
 * clinical `floor` (the most-sensitive value a tenant override may reach), and the lookback `windowDays`
 * for the delta rules. Categorical/progression rules (FAST/GDS/NYHA/Flacker/AIMS) are not numeric and are
 * evaluated by their per-scale modules, not here. */
export interface SignificantChangeThreshold {
  readonly comparator: SignificantChangeComparator;
  readonly platform: number;
  readonly floor: number;
  readonly windowDays?: number;
}

/** §2.4 / D2 — the platform threshold catalog for the numeric significant-change rules. `floor === platform`
 * pins the rule (no tenant movement is legal); a `floor` strictly more sensitive than `platform` lets a
 * tenant tighten within `[floor, platform]` (for `≥`/delta rules) or `[platform, floor]` (for `≤` rules). */
export const SIGNIFICANT_CHANGE_THRESHOLDS: {
  readonly [K in SignificantChangeRuleId]?: SignificantChangeThreshold;
} = {
  pps_drop_20_in_14d: { comparator: "dropGe", platform: 20, floor: 10, windowDays: 14 },
  kps_drop_20_in_14d: { comparator: "dropGe", platform: 20, floor: 10, windowDays: 14 },
  esas_total_increase_20_in_7d: {
    comparator: "increaseGe",
    platform: 20,
    floor: 10,
    windowDays: 7,
  },
  esas_symptom_ge_7: { comparator: "ge", platform: 7, floor: 7 },
  painad_ge_4: { comparator: "ge", platform: 4, floor: 4 },
  braden_le_12: { comparator: "le", platform: 12, floor: 12 },
  morse_ge_51: { comparator: "ge", platform: 51, floor: 51 },
  meld_ge_30: { comparator: "ge", platform: 30, floor: 30 },
};

/** The numeric rules — those with an entry in {@link SIGNIFICANT_CHANGE_THRESHOLDS} — the detector evaluates. */
export function isNumericRule(ruleId: SignificantChangeRuleId): boolean {
  return SIGNIFICANT_CHANGE_THRESHOLDS[ruleId] !== undefined;
}

/**
 * D2 — resolve the effective threshold for a rule given an optional tenant `scale_policy` override. With no
 * override the platform default holds. An override may only TIGHTEN (fire more readily) toward — never past
 * — the clinical floor, and may never LOOSEN past the platform default; a violating override raises
 * `SIGNIFICANT_CHANGE_FLOOR_VIOLATION`. Pure; the policy-write path (M9-T05 `PUT /policy`) calls this to
 * validate an override before persisting it.
 */
export function resolveSignificantChangeThreshold(
  ruleId: SignificantChangeRuleId,
  override?: number,
): number {
  const t = SIGNIFICANT_CHANGE_THRESHOLDS[ruleId];
  require_(
    t !== undefined,
    "SIGNIFICANT_CHANGE_FLOOR_VIOLATION",
    `Rule '${ruleId}' has no numeric threshold to override.`,
  );
  if (override === undefined) return t.platform;
  // "More sensitive" is a LOWER trigger for `≥`/delta rules and a HIGHER trigger for `≤` rules.
  const moreSensitiveIsLower = t.comparator !== "le";
  if (moreSensitiveIsLower) {
    require_(
      override <= t.platform,
      "SIGNIFICANT_CHANGE_FLOOR_VIOLATION",
      `Override ${override} loosens rule '${ruleId}' above its platform floor ${t.platform} (overrides may only tighten).`,
    );
    require_(
      override >= t.floor,
      "SIGNIFICANT_CHANGE_FLOOR_VIOLATION",
      `Override ${override} pierces the clinical floor ${t.floor} for rule '${ruleId}'.`,
    );
  } else {
    require_(
      override >= t.platform,
      "SIGNIFICANT_CHANGE_FLOOR_VIOLATION",
      `Override ${override} loosens rule '${ruleId}' below its platform floor ${t.platform} (overrides may only tighten).`,
    );
    require_(
      override <= t.floor,
      "SIGNIFICANT_CHANGE_FLOOR_VIOLATION",
      `Override ${override} pierces the clinical floor ${t.floor} for rule '${ruleId}'.`,
    );
  }
  return override;
}

/** One prior active reading in the same patient × scale series the detector compares against (delta rules). */
export interface PriorReading {
  readonly score: number | null;
  readonly capturedAt: string;
}

/** The just-recorded reading + the prior active series + the tenant overrides the detector evaluates. */
export interface DetectorInput {
  readonly scaleType: ScaleType;
  readonly score: number | null;
  readonly capturedAt: string;
  /** The single worst per-item symptom score for `esas_symptom_ge_7` (the ESAS-r "any symptom ≥ 7" rule). */
  readonly maxSymptomScore?: number | null;
  /** Active prior rows for the same patient × scale, EXCLUDING the just-recorded one (any order). */
  readonly priorSeries?: ReadonlyArray<PriorReading>;
  /** Tenant `scale_policy.significant_change_overrides` keyed by rule id (validated via {@link resolveSignificantChangeThreshold}). */
  readonly overrides?: Partial<Record<SignificantChangeRuleId, number>>;
}

/** A fired §2.4 rule: the payload the `significant_change_event` row + the §4.9 M36 alert carry. */
export interface SignificantChangeFinding {
  readonly ruleId: SignificantChangeRuleId;
  readonly deltaValue: number;
  readonly thresholdValue: number;
  readonly severity: AssessmentAlertSeverity;
}

/** Whole-day UTC ordinal for an ISO instant (window math is day-granular per §2.4 rule names). */
function epochDay(iso: string): number {
  return Math.floor(Date.parse(iso) / 86_400_000);
}

/** Prior readings within `windowDays` strictly before `capturedAt` (the delta-rule lookback). */
function priorsInWindow(input: DetectorInput, windowDays: number): number[] {
  const cutoff = epochDay(input.capturedAt) - windowDays;
  const at = epochDay(input.capturedAt);
  return (input.priorSeries ?? [])
    .filter(
      (r) => r.score !== null && epochDay(r.capturedAt) >= cutoff && epochDay(r.capturedAt) <= at,
    )
    .map((r) => r.score as number);
}

/**
 * §2.4 — every numeric significant-change rule that fires for the just-recorded reading of `input.scaleType`.
 * Delta rules compare against the most-sensitive baseline in their window (the highest prior for a drop, the
 * lowest prior for an increase); absolute rules test the single reading. Pure and deterministic. Categorical
 * rules (FAST/GDS/NYHA/Flacker/AIMS progression) are not evaluated here.
 */
export function detectSignificantChanges(input: DetectorInput): SignificantChangeFinding[] {
  const findings: SignificantChangeFinding[] = [];
  const rules = (Object.keys(SIGNIFICANT_CHANGE_THRESHOLDS) as SignificantChangeRuleId[]).filter(
    (ruleId) => RULE_SCALE[ruleId] === input.scaleType,
  );
  for (const ruleId of rules) {
    const t = SIGNIFICANT_CHANGE_THRESHOLDS[ruleId];
    if (t === undefined) continue;
    const threshold = resolveSignificantChangeThreshold(ruleId, input.overrides?.[ruleId]);
    let delta: number | null = null;
    let fired = false;
    switch (t.comparator) {
      case "ge": {
        const value =
          ruleId === "esas_symptom_ge_7" ? (input.maxSymptomScore ?? null) : input.score;
        if (value !== null) {
          delta = value;
          fired = value >= threshold;
        }
        break;
      }
      case "le": {
        if (input.score !== null) {
          delta = input.score;
          fired = input.score <= threshold;
        }
        break;
      }
      case "dropGe": {
        const priors = priorsInWindow(input, t.windowDays ?? 0);
        if (input.score !== null && priors.length > 0) {
          const baseline = Math.max(...priors); // worst-case decline within the window
          delta = baseline - input.score;
          fired = delta >= threshold;
        }
        break;
      }
      case "increaseGe": {
        const priors = priorsInWindow(input, t.windowDays ?? 0);
        if (input.score !== null && priors.length > 0) {
          const baseline = Math.min(...priors); // worst-case worsening within the window
          delta = input.score - baseline;
          fired = delta >= threshold;
        }
        break;
      }
    }
    if (fired && delta !== null) {
      findings.push({
        ruleId,
        deltaValue: delta,
        thresholdValue: threshold,
        severity: firstEmissionSeverity(ruleId),
      });
    }
  }
  return findings;
}
