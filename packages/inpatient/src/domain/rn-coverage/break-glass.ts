// @wardenx/inpatient — M37-T07, §2.3 D3. RN-coverage break-glass override semantics. A break-glass key
// (`m37.rn_coverage.break_glass`, Org Admin / Compliance Officer / Medical Director only) admits a temporary
// override window so care can proceed while coverage is restored; the override MUST be ended by a
// non-break-glass actor, and it lapses automatically after the max window. Pure & IO-free; the M4
// break-glass-audit-of-audit tagging happens at the service layer (M37-T11).
import { requireIpu } from "../../errors";

/** §2.3 — the maximum RN-coverage break-glass override window (hours). */
export const RN_BREAK_GLASS_MAX_HOURS = 4;

/** An active break-glass override the coverage evaluator merges into the `rn_coverage_active` reading. */
export interface RnCoverageBreakGlass {
  readonly invokedAtMs: number;
  readonly endedAtMs: number | null;
}

/** §2.3 — has a break-glass override lapsed (ended, or older than the max window)? */
export function isBreakGlassExpired(bg: RnCoverageBreakGlass, nowMs: number): boolean {
  if (bg.endedAtMs !== null) return nowMs >= bg.endedAtMs;
  return nowMs - bg.invokedAtMs >= RN_BREAK_GLASS_MAX_HOURS * 3_600_000;
}

/** §2.3 — is a break-glass override currently in force? */
export function isBreakGlassActive(bg: RnCoverageBreakGlass | null, nowMs: number): boolean {
  return bg !== null && !isBreakGlassExpired(bg, nowMs);
}

/**
 * §2.3 — the effective RN-coverage-active reading the ABAC predicate returns: coverage is active when the
 * current hour is genuinely covered OR an unexpired break-glass override is in force.
 */
export function effectiveRnCoverageActive(
  currentHourUncovered: boolean,
  breakGlass: RnCoverageBreakGlass | null,
  nowMs: number,
): boolean {
  return !currentHourUncovered || isBreakGlassActive(breakGlass, nowMs);
}

/**
 * §2.3 — validate that a break-glass override is being ENDED by a non-break-glass actor (the override cannot
 * be self-perpetuated by the same break-glass credential). Throws `RN_BREAK_GLASS_ENDER_INVALID`.
 */
export function validateBreakGlassEnd(enderIsBreakGlassActor: boolean): void {
  requireIpu(
    !enderIsBreakGlassActor,
    "RN_BREAK_GLASS_ENDER_INVALID",
    "An RN-coverage break-glass override must be ended by a non-break-glass actor.",
  );
}

/** §2.3 — validate a break-glass invocation carries fresh step-up (Org Admin / Compliance Officer / Med Director). */
export function validateBreakGlassInvoke(stepUpVerified: boolean): void {
  requireIpu(
    stepUpVerified,
    "RN_BREAK_GLASS_STEP_UP_REQUIRED",
    "An RN-coverage break-glass requires fresh M2 step-up (Org Admin / Compliance Officer / Medical Director).",
  );
}
