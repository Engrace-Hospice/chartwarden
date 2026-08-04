// @wardenx/cap-management — threshold-band evaluation (D7). Aggregate (agency + per-patient) bands at
// 90% watch / 95% warn / 100% breach; inpatient bands at 18% watch / 20% breach. A band TRANSITION to a
// higher band emits a cap_threshold_event + M36 alert (§2.4); a drop back to the safe band auto-resolves.
//
// Tenants may TIGHTEN thresholds (lower the trigger) but never loosen — the override is applied by lowering
// the threshold inputs, never by reordering the bands. The ordering kernel here is the single source of
// truth for "is band B higher than band A" used by the threshold evaluator.
import { type AlertBand, BAND_THRESHOLDS } from "./types";

/** Monotone rank of each band within its scope family — higher rank = closer to/over breach. */
const AGGREGATE_RANK: Record<string, number> = {
  safe: 0,
  watch_90: 1,
  warn_95: 2,
  breach_100: 3,
};
const INPATIENT_RANK: Record<string, number> = {
  inpatient_safe: 0,
  inpatient_watch_18: 1,
  inpatient_breach_20: 2,
};

/** True if `band` belongs to the inpatient family (vs the aggregate family). */
export function isInpatientBand(band: AlertBand): boolean {
  return band.startsWith("inpatient_");
}

/** The safe/baseline band for a scope (inpatient scope has its own safe member). */
export function safeBandFor(scope: "aggregate" | "inpatient"): AlertBand {
  return scope === "inpatient" ? "inpatient_safe" : "safe";
}

/**
 * The aggregate band for a utilization fraction (e.g. 0.96 → 'warn_95'). Optional tenant overrides tighten
 * the trigger fractions; defaults are the D7 platform floor. A negative/zero fraction reads 'safe'.
 */
export function aggregateBand(
  fraction: number,
  thresholds: { watch: number; warn: number; breach: number } = BAND_THRESHOLDS.aggregate,
): AlertBand {
  if (fraction >= thresholds.breach) return "breach_100";
  if (fraction >= thresholds.warn) return "warn_95";
  if (fraction >= thresholds.watch) return "watch_90";
  return "safe";
}

/** The inpatient band for an inpatient-day fraction (e.g. 0.205 → 'inpatient_breach_20'). */
export function inpatientBand(
  fraction: number,
  thresholds: { watch: number; breach: number } = BAND_THRESHOLDS.inpatient,
): AlertBand {
  if (fraction >= thresholds.breach) return "inpatient_breach_20";
  if (fraction >= thresholds.watch) return "inpatient_watch_18";
  return "inpatient_safe";
}

/** Rank of a band within its family (aggregate or inpatient). */
export function bandRank(band: AlertBand): number {
  return isInpatientBand(band) ? (INPATIENT_RANK[band] ?? 0) : (AGGREGATE_RANK[band] ?? 0);
}

/** True if `next` is a strictly HIGHER band than `prior` (a transition worth alerting). */
export function isEscalation(prior: AlertBand, next: AlertBand): boolean {
  return bandRank(next) > bandRank(prior);
}

/** True if `next` has dropped to the family's safe band (auto-resolve the open threshold event). */
export function isResolution(prior: AlertBand, next: AlertBand): boolean {
  return bandRank(next) === 0 && bandRank(prior) > 0;
}
