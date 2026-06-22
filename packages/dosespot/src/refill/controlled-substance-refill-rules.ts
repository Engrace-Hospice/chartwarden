// @wardenx/dosespot — §2.7 / §1.4 controlled-substance refill rules (M12-T04). Pure, IO-free.
//
// The DEA / state-board platform floor for how many refills a controlled-substance prescription may carry:
// Schedule II is *non-refillable* (a new prescription is always required); Schedule III/IV/V allow at most
// five refills within six months (21 CFR 1306.22). The per-tenant `controlled_substance_policy` table may
// *tighten* this matrix (e.g. a state board that caps Schedule IV at 3) but never loosen it above the
// platform floor — the M11 D-Verbal / M40 D6 tighten-only precedent. The state-board adapter registry is
// reserved for Phase 2; Phase 1 ships the platform-floor matrix only. Every fact (the schedule, the
// requested count, the tenant override) is injected as data — `@wardenx/types` + the sibling errors only.
import type { DeaSchedule } from "@wardenx/types";
import { requireRefill } from "./errors";

/**
 * §1.4 — the platform-floor maximum number of refills per DEA schedule (21 CFR 1306.22). Schedule II is
 * non-refillable (`0`); Schedule III/IV/V allow up to five. A null schedule (non-controlled) is not capped
 * here — the order's own `refillsRemaining` governs (see {@link maxRefillsForSchedule}).
 */
export const SCHEDULE_REFILL_MAX: Readonly<Record<DeaSchedule, number>> = {
  II: 0,
  III: 5,
  IV: 5,
  V: 5,
} as const;

/**
 * §1.4 — the platform-floor max-refill count for a (controlled) order, or `null` for a non-controlled order
 * (no controlled-substance cap; the order's `refillsRemaining` is the only limit). The optional
 * `tenantMaxOverride` tightens the floor; {@link validateControlledRefillMaxOverride} enforces tighten-only.
 */
export function maxRefillsForSchedule(
  deaSchedule: DeaSchedule | null,
  tenantMaxOverride?: number,
): number | null {
  if (deaSchedule === null) return null;
  const floor = SCHEDULE_REFILL_MAX[deaSchedule];
  if (tenantMaxOverride === undefined) return floor;
  // Tighten-only: a tenant may only lower the floor (validated separately); take the stricter of the two.
  return Math.min(floor, tenantMaxOverride);
}

/**
 * §2.7 approve — assert the requested `refillsAuthorized` is legal for this schedule before minting the new
 * `medication_order`. Schedule II raises `REFILL_SCHEDULE_II_NON_REFILLABLE`; any count above the (possibly
 * tenant-tightened) schedule max raises `REFILL_EXCEEDS_SCHEDULE_MAX`. Non-controlled orders are unbounded
 * here. Call this from the refill-approve guard (and the route layer repeats the TypeBox `maximum`).
 */
export function assertRefillAuthorizedCount(
  deaSchedule: DeaSchedule | null,
  refillsAuthorized: number,
  tenantMaxOverride?: number,
): void {
  requireRefill(
    Number.isInteger(refillsAuthorized) && refillsAuthorized >= 0,
    "REFILL_EXCEEDS_SCHEDULE_MAX",
    `refillsAuthorized must be a non-negative integer (got ${refillsAuthorized}).`,
  );
  requireRefill(
    deaSchedule !== "II",
    "REFILL_SCHEDULE_II_NON_REFILLABLE",
    "Schedule II medications are non-refillable; a new prescription is required.",
  );
  const max = maxRefillsForSchedule(deaSchedule, tenantMaxOverride);
  if (max === null) return; // non-controlled — the order's refillsRemaining governs
  requireRefill(
    refillsAuthorized <= max,
    "REFILL_EXCEEDS_SCHEDULE_MAX",
    `refillsAuthorized=${refillsAuthorized} exceeds the ${deaSchedule} schedule max of ${max}.`,
  );
}

/**
 * §2.7 admin — the tighten-only guard on a per-tenant `controlled_substance_policy` max-refill override. An
 * override must be in `[0, platformFloor]`; above the floor raises `REFILL_CONTROLLED_MAX_EXCEEDS_FLOOR`,
 * below zero (or non-integer) `REFILL_CONTROLLED_MAX_OUT_OF_RANGE`. The service calls this on the
 * `PATCH /admin/controlled-substance-policy` route before persisting.
 */
export function validateControlledRefillMaxOverride(
  deaSchedule: DeaSchedule,
  tenantMaxOverride: number,
): void {
  requireRefill(
    Number.isInteger(tenantMaxOverride) && tenantMaxOverride >= 0,
    "REFILL_CONTROLLED_MAX_OUT_OF_RANGE",
    `controlled-substance max-refill override must be an integer ≥ 0 (got ${tenantMaxOverride}).`,
  );
  requireRefill(
    tenantMaxOverride <= SCHEDULE_REFILL_MAX[deaSchedule],
    "REFILL_CONTROLLED_MAX_EXCEEDS_FLOOR",
    `controlled-substance max-refill override ${tenantMaxOverride} exceeds the ${deaSchedule} platform floor of ${SCHEDULE_REFILL_MAX[deaSchedule]} (tighten-only).`,
  );
}
