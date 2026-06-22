// @wardenx/orders — §2.3 D3 verbal-order workflow + 48h timer (M11-T04). PURE, IO-free.
//
// CMS 42 CFR 418.104(b) makes the verbal-order signature window binding: a verbal order is clinically valid
// pending signature but MUST be signed by the named practitioner within "a reasonable amount of time" — the
// industry/state-board consensus is 48 hours. This module owns the timer math the worker layer (the hourly
// `orders.verbal_timer` + quarter-hourly `orders.verbal_pre_expiry` crons, §4.8) composes over the
// `verbal_order` rows:
//   • `validateVerbalWindowHours`  — the tighten-only platform-floor guard (window_hours ∈ [1, 48]).
//   • `computeVerbalDeadline`      — `deadline_at` under wall-clock OR business-hours (weekend/holiday-skip).
//   • `classifyPreExpiryTier`      — the 12h-pre (medium) / 2h-pre (high) M36 alert cadence (§2.3, §4.9).
//   • `isVerbalExpired`            — `now() >= deadline_at` (the worker's expire predicate).
//   • `planVerbalExpiry`           — the §2.2/§2.6 expiry side-effect plan (flip both rows + audit-symmetry
//                                    discontinuation, reason `expired_verbal`).
// Every fact (received instant, org timezone, holiday set, `now`) is injected as data — no `Date.now()`,
// no DB, `@wardenx/types` + the sibling pure modules only.
import type { IsoInstant, LocalDate, VerbalOrderStatus } from "@wardenx/types";
import { HOUR_MS, isBusinessDay, orgLocalDate, DEFAULT_ORG_TIME_ZONE } from "./time";
import { type OrderSideEffect } from "./effects";
import { OrderStateError, require_ } from "./errors";
import { transitionOrder, type OrderTransition } from "./order-machine";

/** §2.3 D3 — the 48-hour CMS platform floor. A tenant may *tighten* to as short as 1 hour, never loosen. */
export const VERBAL_PLATFORM_FLOOR_HOURS = 48;

/** §2.3 D3 — the minimum a tenant window may be tightened to (the `[1, 48]` range floor). */
export const VERBAL_WINDOW_MIN_HOURS = 1;

/**
 * §2.3 D3 — the per-tenant verbal-order deadline policy (a projection of `order_verbal_policy`). The
 * deadline math reads `windowHours` + `businessHoursOnly`; `holidays` is the tenant holiday calendar (org-
 * local `yyyy-mm-dd` dates) the business-hours mode skips alongside weekends; `timeZone` is the resolved
 * org timezone (M2). `policyVersion` is stamped onto the `verbal_order.deadline_policy_version` column so a
 * later policy change never silently re-dates an existing row.
 */
export interface VerbalDeadlinePolicy {
  readonly windowHours: number;
  readonly businessHoursOnly: boolean;
  readonly holidays?: readonly LocalDate[];
  readonly timeZone?: string;
  readonly policyVersion: string;
}

/** §2.3 D3 — the platform-default verbal policy: the full 48-hour wall-clock window. */
export const DEFAULT_VERBAL_POLICY: VerbalDeadlinePolicy = {
  windowHours: VERBAL_PLATFORM_FLOOR_HOURS,
  businessHoursOnly: false,
  policyVersion: "v1",
} as const;

/**
 * §2.3 D3 — the tighten-only floor guard. A tenant `window_hours` must be in `[1, 48]`; an attempt to set
 * it above the platform floor raises `VERBAL_WINDOW_EXCEEDS_FLOOR`, below the minimum
 * `VERBAL_WINDOW_OUT_OF_RANGE`. The service calls this on `PUT /verbal-policy` before persisting.
 */
export function validateVerbalWindowHours(windowHours: number): void {
  require_(
    Number.isInteger(windowHours) && windowHours >= VERBAL_WINDOW_MIN_HOURS,
    "VERBAL_WINDOW_OUT_OF_RANGE",
    `window_hours must be an integer ≥ ${VERBAL_WINDOW_MIN_HOURS} (got ${windowHours}).`,
  );
  require_(
    windowHours <= VERBAL_PLATFORM_FLOOR_HOURS,
    "VERBAL_WINDOW_EXCEEDS_FLOOR",
    `window_hours may not exceed the ${VERBAL_PLATFORM_FLOOR_HOURS}h platform floor (got ${windowHours}); tenants may tighten, never loosen.`,
  );
}

/** Defensive bound on the business-hours loop (a year of hours) against a pathological all-holiday set. */
const MAX_BUSINESS_HOURS_ITERATIONS = 366 * 24;

/**
 * §2.3 D3 — `verbal_order.deadline_at = received_at + window`. In wall-clock mode (default) the window is
 * `windowHours` elapsed real hours. In business-hours mode the clock is *paused* on weekends and tenant
 * holidays: each elapsed hour counts toward the window only when the org-local calendar day at the START of
 * that hour is a business day, so a window opened Friday afternoon completes Monday/Tuesday. DST is exact —
 * the org-local day boundaries are resolved per-instant via {@link orgLocalDate}.
 */
export function computeVerbalDeadline(
  receivedAt: IsoInstant,
  policy: VerbalDeadlinePolicy = DEFAULT_VERBAL_POLICY,
): IsoInstant {
  validateVerbalWindowHours(policy.windowHours);
  const startMs = Date.parse(receivedAt);
  if (!policy.businessHoursOnly) {
    return new Date(startMs + policy.windowHours * HOUR_MS).toISOString();
  }
  const timeZone = policy.timeZone ?? DEFAULT_ORG_TIME_ZONE;
  const holidays = new Set(policy.holidays ?? []);
  let remaining = policy.windowHours;
  let cursorMs = startMs;
  let iterations = 0;
  while (remaining > 0) {
    if (++iterations > MAX_BUSINESS_HOURS_ITERATIONS) {
      throw new OrderStateError(
        "VERBAL_WINDOW_OUT_OF_RANGE",
        "business-hours deadline did not converge — the tenant holiday calendar leaves no business days.",
      );
    }
    const day = orgLocalDate(new Date(cursorMs).toISOString(), timeZone);
    if (isBusinessDay(day, holidays)) remaining -= 1;
    cursorMs += HOUR_MS;
  }
  return new Date(cursorMs).toISOString();
}

/** §2.3 / §4.9 — the two pre-expiry alert tiers (12h-pre / 2h-pre) and their M36 severity. */
export type VerbalAlertTier = "twelve_hour" | "two_hour";

/** A classified pre-expiry alert (the worker emits `m11.order.verbal_expiring_soon` with these fields). */
export interface VerbalPreExpiryAlert {
  readonly tier: VerbalAlertTier;
  readonly severity: "medium" | "high";
  readonly hoursUntilDeadline: 12 | 2;
}

/** §2.3 / §4.9 — the alert-tier offsets (hours before `deadline_at`) and their severity. */
const PRE_EXPIRY_TIERS: ReadonlyArray<VerbalPreExpiryAlert> = [
  // 2h-pre is checked first: it is closer to the deadline and outranks the 12h tier on any overlap.
  { tier: "two_hour", severity: "high", hoursUntilDeadline: 2 },
  { tier: "twelve_hour", severity: "medium", hoursUntilDeadline: 12 },
];

/** The quarter-hourly worker's match tolerance: a mark fires when `now` is within ±15 min of it (§4.8). */
export const PRE_EXPIRY_TOLERANCE_MS = 15 * 60 * 1000;

/**
 * §2.3 / §4.9 — classify `now` against a verbal order's `deadline_at` into a pre-expiry alert tier, or
 * `null` when no mark is within tolerance. The quarter-hourly `orders.verbal_pre_expiry` cron uses this to
 * decide whether to emit `m11.order.verbal_expiring_soon` (the worker enforces idempotency per
 * `(verbal_order_id, alert_tier)` so a tier fires at most once even though the scan window is ±15 min).
 */
export function classifyPreExpiryTier(
  now: IsoInstant,
  deadlineAt: IsoInstant,
  toleranceMs: number = PRE_EXPIRY_TOLERANCE_MS,
): VerbalPreExpiryAlert | null {
  const nowMs = Date.parse(now);
  const deadlineMs = Date.parse(deadlineAt);
  for (const t of PRE_EXPIRY_TIERS) {
    const markMs = deadlineMs - t.hoursUntilDeadline * HOUR_MS;
    if (Math.abs(nowMs - markMs) <= toleranceMs) return t;
  }
  return null;
}

/** §2.2 — the worker's expire predicate: `now() >= deadline_at` (millisecond-exact at the boundary). */
export function isVerbalExpired(now: IsoInstant, deadlineAt: IsoInstant): boolean {
  return Date.parse(now) >= Date.parse(deadlineAt);
}

/** Whole hours (rounded down, never negative) a verbal order is past its deadline (alert `hoursOverdue`). */
export function hoursOverdue(now: IsoInstant, deadlineAt: IsoInstant): number {
  return Math.max(0, Math.floor((Date.parse(now) - Date.parse(deadlineAt)) / HOUR_MS));
}

/**
 * §2.2 / §2.6 / W-VO-02 — the full expiry side-effect plan the `orders.verbal_timer` worker commits in one
 * transaction past `deadline_at`. It composes the order-machine `expire` transition (`verbal_pending →
 * expired_unsigned`, which flips the `order_record` + emits `m11.order.verbal_expired_unsigned`) and
 * appends the verbal-row-specific effects: flip `verbal_order.status='expired_unsigned'` and write the
 * audit-symmetry `order_discontinuation` row (system actor, `reason='expired_verbal'`, §2.6). Throws
 * `VERBAL_DEADLINE_NOT_REACHED` if called before the deadline (the worker clock guard).
 */
export function planVerbalExpiry(now: IsoInstant, deadlineAt: IsoInstant): OrderTransition {
  const base = transitionOrder("verbal_pending", {
    type: "expire",
    isSystemActor: true,
    deadlineReached: isVerbalExpired(now, deadlineAt),
  });
  const extra: ReadonlyArray<OrderSideEffect> = [
    { kind: "set_verbal_status", status: "expired_unsigned" satisfies VerbalOrderStatus },
    { kind: "write_discontinuation", reason: "expired_verbal" },
  ];
  return { ...base, effects: [...base.effects, ...extra] };
}
