// @chartwarden/inpatient — M37-T06, §2.5 D6. The IRC 5-consecutive-day cap enforcer. An `irc_episode` opens
// when an `ipu_admission.kind='irc'` goes active (§2.2); the `irc-cap-watchdog` cron ticks the
// consecutive-day count at per-org midnight, driving the state active → approaching_cap → breached and the
// M36 alerts. The M3 ABAC predicate `m37.irc_episode.within_cap` reads {@link isWithinCap} so M23's per-diem
// line generation is blocked at the gate on a breached episode. Pure & IO-free — the cron injects the day
// count / prior-episode history; the service (M37-T11) persists the state + effects and drives break-glass.
import type { IrcEpisodeState } from "@chartwarden/types";
import { IpuStateError, requireIpu } from "../errors";

/** §2.5 — IRC is permitted up to 5 consecutive days per episode (CoP 418.108 caregiver respite). */
export const IRC_CAP_DAYS = 5;
/** §2.5 — the platform-floor maximum a cap-override may extend the window by; tenants cannot loosen. */
export const IRC_CAP_OVERRIDE_MAX_DAYS = 2;
/** §2.5 — the cap-override reason floor (chars). */
export const IRC_CAP_OVERRIDE_REASON_MIN = 100;
/** §2.5 — the resumption look-back: a re-admit within this window does NOT reset the consecutive count. */
export const IRC_RESUMPTION_LOOKBACK_DAYS = 30;

/** The §4.4 `m37.irc_episode.*` outbox events this enforcer emits. */
export type IrcOutboxEvent =
  | "m37.irc_episode.cap_approaching"
  | "m37.irc_episode.cap_breached"
  | "m37.irc_episode.cap_override_invoked";

/** A declarative side effect the service (M37-T11) interprets. */
export type IrcEffect =
  | { readonly kind: "set_state"; readonly state: IrcEpisodeState }
  | { readonly kind: "set_day_count"; readonly count: number }
  | { readonly kind: "set_override"; readonly extensionDays: number }
  | { readonly kind: "outbox"; readonly event: IrcOutboxEvent };

/** §2.5 — the effective cap in days for an episode, given any granted override extension (clamped to the floor). */
export function effectiveCapDays(overrideExtensionDays = 0): number {
  return IRC_CAP_DAYS + Math.min(Math.max(0, overrideExtensionDays), IRC_CAP_OVERRIDE_MAX_DAYS);
}

/**
 * §2.5 — the non-terminal cap state for a consecutive-day count: `breached` at or beyond the (possibly
 * override-extended) cap, `approaching_cap` on the day before, else `active`. Day 4 approaches / day 5
 * breaches for the base 5-day cap; an override moves both thresholds out.
 */
export function computeIrcState(
  consecutiveDayCount: number,
  overrideExtensionDays = 0,
): Exclude<IrcEpisodeState, "closed"> {
  const cap = effectiveCapDays(overrideExtensionDays);
  if (consecutiveDayCount >= cap) return "breached";
  if (consecutiveDayCount >= cap - 1) return "approaching_cap";
  return "active";
}

/** §2.5 — the ABAC `m37.irc_episode.within_cap` reading: a breached episode blocks IRC billing routes. */
export function isWithinCap(state: IrcEpisodeState): boolean {
  return state !== "breached";
}

/** The result of a daily watchdog tick: the new count + state + any state-entry outbox. */
export interface IrcTickResult {
  readonly consecutiveDayCount: number;
  readonly state: Exclude<IrcEpisodeState, "closed">;
  readonly effects: readonly IrcEffect[];
}

/**
 * §2.5 — the `irc-cap-watchdog` daily tick. Increments the consecutive-day count and recomputes the state,
 * emitting `cap_approaching` (warn) / `cap_breached` (block) ONLY on entry into that state (idempotent
 * re-ticks on an already-breached episode emit nothing new). A `closed` episode is not ticked.
 */
export function planIrcDailyTick(prev: {
  readonly consecutiveDayCount: number;
  readonly state: IrcEpisodeState;
  readonly overrideExtensionDays?: number;
}): IrcTickResult {
  requireIpu(
    prev.state !== "closed",
    "ILLEGAL_IRC_TRANSITION",
    "A closed irc_episode is not ticked.",
  );
  const consecutiveDayCount = prev.consecutiveDayCount + 1;
  const state = computeIrcState(consecutiveDayCount, prev.overrideExtensionDays ?? 0);
  const effects: IrcEffect[] = [
    { kind: "set_day_count", count: consecutiveDayCount },
    { kind: "set_state", state },
  ];
  // Emit only on a state transition into approaching_cap / breached.
  if (state !== prev.state) {
    if (state === "approaching_cap")
      effects.push({ kind: "outbox", event: "m37.irc_episode.cap_approaching" });
    if (state === "breached")
      effects.push({ kind: "outbox", event: "m37.irc_episode.cap_breached" });
  }
  return { consecutiveDayCount, state, effects };
}

/**
 * §2.5 cap-window resumption rule — the starting `consecutive_day_count` for a new IRC episode. If the same
 * patient has a prior IRC episode CLOSED within {@link IRC_RESUMPTION_LOOKBACK_DAYS} of the new start, the
 * count CONTINUES from the prior episode (prior count + 1) so two short episodes cannot split around the cap;
 * otherwise a fresh episode starts at day 1.
 */
export function resumedStartingDayCount(
  priorEpisodes: ReadonlyArray<{
    readonly closedAtMs: number | null;
    readonly consecutiveDayCount: number;
  }>,
  newStartMs: number,
): number {
  const windowMs = IRC_RESUMPTION_LOOKBACK_DAYS * 86_400_000;
  const withinWindow = priorEpisodes.filter(
    (e) =>
      e.closedAtMs !== null &&
      newStartMs - e.closedAtMs <= windowMs &&
      newStartMs - e.closedAtMs >= 0,
  );
  if (withinWindow.length === 0) return 1;
  const maxPrior = Math.max(...withinWindow.map((e) => e.consecutiveDayCount));
  return maxPrior + 1;
}

/**
 * §2.5 cap-override (break-glass) — validate an Org-Admin/Compliance-Officer override and return the granted
 * extension + effects. Throws the precise code on a step-up / reason-floor / extension-ceiling failure. The
 * granted extension is clamped to the 2-day platform floor (a request above it is rejected, not silently
 * clamped, so the caller sees the ceiling).
 */
export function planCapOverride(input: {
  readonly reason: string;
  readonly extensionDays: number;
  readonly stepUpVerified: boolean;
}): { readonly extensionDays: number; readonly effects: readonly IrcEffect[] } {
  requireIpu(
    input.stepUpVerified,
    "IRC_CAP_OVERRIDE_STEP_UP_REQUIRED",
    "An IRC cap override requires fresh M2 step-up (Org Admin / Compliance Officer).",
  );
  requireIpu(
    input.reason.trim().length >= IRC_CAP_OVERRIDE_REASON_MIN,
    "IRC_CAP_OVERRIDE_REASON_TOO_SHORT",
    `An IRC cap override requires a reason ≥ ${IRC_CAP_OVERRIDE_REASON_MIN} chars.`,
  );
  requireIpu(
    input.extensionDays >= 1 && input.extensionDays <= IRC_CAP_OVERRIDE_MAX_DAYS,
    "IRC_CAP_OVERRIDE_EXTENSION_TOO_LONG",
    `An IRC cap override may extend by at most ${IRC_CAP_OVERRIDE_MAX_DAYS} days.`,
  );
  return {
    extensionDays: input.extensionDays,
    effects: [
      { kind: "set_override", extensionDays: input.extensionDays },
      { kind: "outbox", event: "m37.irc_episode.cap_override_invoked" },
    ],
  };
}
