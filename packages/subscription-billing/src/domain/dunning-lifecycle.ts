// @wardenx/subscription-billing — §4.15 dunning state machine (pure kernel, M35-T01).
//
// The D7 dunning ladder as pure data. `none` is the resting state; a `payment_failed` enters `day_1`;
// each subsequent stage advances after a fixed unresolved interval; `day_28_suspend` suspends the
// subscription and emits `m35.tenant.billing_blocked`; `day_60_cancel` cancels at Stripe. A successful
// payment at ANY active stage jumps to `resolved`, which then resets to `none`. The T05 `dunning-engine`
// cron reads this ordering; encoding it here keeps the advancement rules DB-free and unit-testable.

import type { DunningStage } from "@wardenx/types";

/** The strictly-ordered active dunning ladder (excludes `resolved`, which is reachable from any stage). */
export const DUNNING_LADDER = [
  "none",
  "day_1",
  "day_7",
  "day_14",
  "day_21",
  "day_28_suspend",
  "day_60_cancel",
] as const satisfies readonly DunningStage[];

/** §4.15 the unresolved-interval (in days) after which each stage advances to the next. `none` advances to
 *  `day_1` immediately on `payment_failed` (0 days). `day_60_cancel` is terminal (no further advance). */
export const DUNNING_ADVANCE_AFTER_DAYS: Record<
  Exclude<DunningStage, "resolved" | "day_60_cancel">,
  number
> = {
  none: 0,
  day_1: 6,
  day_7: 7,
  day_14: 7,
  day_21: 7,
  day_28_suspend: 32,
};

/** The next stage in the ladder, or `null` at the terminal `day_60_cancel`. `resolved` has no successor. */
export function nextDunningStage(stage: DunningStage): DunningStage | null {
  if (stage === "resolved") return null;
  const idx = DUNNING_LADDER.indexOf(stage);
  if (idx < 0 || idx >= DUNNING_LADDER.length - 1) return null;
  return DUNNING_LADDER[idx + 1] ?? null;
}

/** §4.15 the retry cadence: how many days after ENTERING a stage the next Stripe payment retry is scheduled
 *  (`m35.dunning.entered_stage.nextAttemptAt`). Distinct from {@link DUNNING_ADVANCE_AFTER_DAYS} — day_1
 *  retries at +24h but only ADVANCES to day_7 after +6 days. Stages with no retry (`none` is the resting
 *  state; `day_28_suspend`/`day_60_cancel` no longer retry the card) are absent → `nextAttemptDays` = null. */
export const DUNNING_RETRY_AFTER_DAYS: Partial<Record<DunningStage, number>> = {
  day_1: 1,
  day_7: 7,
  day_14: 7,
  day_21: 7,
};

/** Days until the next scheduled card retry after entering `stage`, or `null` when the stage does not retry. */
export function dunningRetryDelayDays(stage: DunningStage): number | null {
  return DUNNING_RETRY_AFTER_DAYS[stage] ?? null;
}

/** The dunning stage at which the subscription is suspended (M35 emits `m35.tenant.billing_blocked`). */
export const DUNNING_SUSPEND_STAGE: DunningStage = "day_28_suspend";

/** The dunning stage at which the subscription is canceled at Stripe. */
export const DUNNING_CANCEL_STAGE: DunningStage = "day_60_cancel";

/** True iff a successful payment at `stage` should resolve the dunning sequence (any active stage). */
export function isResolvableDunningStage(stage: DunningStage): boolean {
  return stage !== "none" && stage !== "resolved";
}

/**
 * §4.15 platform-floor override rule. Tenant overrides may only TIGHTEN (suspend sooner), never LOOSEN.
 * Returns the accepted override in days, or `null` if the requested override loosens the 28-day floor and
 * is rejected. (`Organization.settings.m35_dunning_override_days`; server caps with `min(override, 28)`.)
 */
export function acceptedDunningOverrideDays(requestedDays: number): number | null {
  if (!Number.isFinite(requestedDays) || requestedDays <= 0) return null;
  if (requestedDays > 28) return null; // loosening — rejected
  return Math.min(requestedDays, 28);
}
