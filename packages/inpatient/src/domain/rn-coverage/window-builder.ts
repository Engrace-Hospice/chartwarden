// @wardenx/inpatient — M37-T07, §2.3 D3. Builds the materialized `ipu_rn_coverage_window` invariant from a
// unit's shifts + staff assignments. The `rn-coverage-watchdog` worker (M37-T11 cron) rebuilds these rows
// every 5 minutes per unit over a rolling 168h-back + 48h-forward window. Pure & IO-free — the worker loads
// the confirmed RN assignments under RLS and injects them as plain facts.
import type { IpuShiftAssignmentState, IpuShiftRole } from "@wardenx/types";

/** §2.3 — the RN-equivalent discipline set that satisfies the 24/7 coverage invariant (platform floor). */
export const RN_EQUIVALENT_ROLES: readonly IpuShiftRole[] = ["rn", "charge_rn", "np_in_rn_role"];

/** One hour of the coverage grid: a UTC hour-start, whether an RN covers it, and the covering assignment ids. */
export interface CoverageHour {
  readonly hourStartMs: number;
  readonly isCovered: boolean;
  readonly rnAssignmentIds: readonly string[];
}

/**
 * A staff-assignment coverage fact. Per-membership eligibility (M2 active + unexpired RN license) is resolved
 * upstream and injected as `membershipEligible`, so the builder is a pure function of the assignment grid.
 */
export interface StaffAssignmentFact {
  readonly assignmentId: string;
  readonly role: IpuShiftRole;
  readonly state: IpuShiftAssignmentState;
  readonly shiftStartMs: number;
  readonly shiftEndMs: number;
  /** M2 membership active AND unexpired RN license (resolved upstream). */
  readonly membershipEligible: boolean;
}

/** Whether an assignment counts toward RN coverage at all (RN-equivalent, confirmed, eligible membership). */
export function isCoveringAssignment(a: StaffAssignmentFact): boolean {
  return RN_EQUIVALENT_ROLES.includes(a.role) && a.state === "confirmed" && a.membershipEligible;
}

/**
 * §2.3 — which confirmed RN assignments cover the hour beginning at `hourStartMs`? An assignment covers the
 * hour when the shift's `[shift_start_at, shift_end_at)` interval contains the hour start.
 */
export function coveringAssignmentsForHour(
  assignments: readonly StaffAssignmentFact[],
  hourStartMs: number,
): string[] {
  return assignments
    .filter((a) => isCoveringAssignment(a) && a.shiftStartMs <= hourStartMs && hourStartMs < a.shiftEndMs)
    .map((a) => a.assignmentId);
}

const HOUR_MS = 3_600_000;

/** Truncate a timestamp down to its UTC hour boundary. */
export function hourStartOf(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/**
 * §2.3 — build the coverage grid for `hours` consecutive hours starting at the hour containing `rangeStartMs`.
 * Each row records whether ≥1 confirmed RN covers that hour and the covering assignment ids. The service
 * upserts these onto `ipu_rn_coverage_window` (unique on unit × hour_start_at).
 */
export function buildCoverageWindows(
  assignments: readonly StaffAssignmentFact[],
  rangeStartMs: number,
  hours: number,
): CoverageHour[] {
  const start = hourStartOf(rangeStartMs);
  const grid: CoverageHour[] = [];
  for (let i = 0; i < hours; i++) {
    const hourStartMs = start + i * HOUR_MS;
    const ids = coveringAssignmentsForHour(assignments, hourStartMs);
    grid.push({ hourStartMs, isCovered: ids.length > 0, rnAssignmentIds: ids });
  }
  return grid;
}
