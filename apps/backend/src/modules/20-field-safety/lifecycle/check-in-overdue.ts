// apps/backend/src/modules/20-field-safety/lifecycle/check-in-overdue.ts — M20-T03 (§2.2.1, §4.8
// `m20.overdue-detector.cron`, D4, §7.3).
//
// The decision half of the 30-second overdue detector: given one `safety_check_in_schedule` row, the policy
// pinned on it and the clock, say which D4 rung the clinician's silence has reached and what that rung owes.
//
// §7.3 NAMES SCHEDULE STATES THAT DO NOT EXIST, AND THE FIX IS THE SHAPE OF THIS FILE. §7.3's worked
// sequence says the cron "flips state to `escalation_tier_1`" and later to `sos_equivalent`. The §3.2
// `safety_check_in_state` enum has six members — `proposed`, `recorded`, `overdue`, `escalated`,
// `superseded`, `incident_opened` — and neither of those is one of them. A detector written to the prose
// would fail on an enum cast at 14:15 with a clinician unaccounted for. So:
//
//   • the STORED state ladder is `proposed → overdue → escalated`, exactly what the enum and migration
//     0110's `m20_scis_overdue_stamped` / `m20_scis_escalated_stamped` CHECKs support; and
//   • the D4 RUNG is DERIVED from `expected_at` against the four policy thresholds. @chartwarden/types already
//     anticipated this — `SafetyOverdueBadge` is documented there as "not a stored column: it is computed
//     from `expectedAt` against the effective policy".
//
// THE LADDER HAS FOUR RUNGS AND THE ROW REACHES `escalated` AT THE SECOND. That is why M20-T03 widened
// `SAFETY_SCHEDULE_ACTIONABLE_STATES` (@chartwarden/types) and migration 0110's `scis_overdue_scan_idx`
// (migration 0112) to include `escalated`: with the two-member set, the detector stopped acting on the row
// at +15 minutes and the +30 and +60 rungs — the two that exist because nobody has reached the clinician
// yet — could never fire.
//
// IDEMPOTENCE WITH TWO TIMESTAMPS AND FOUR RUNGS. The row carries `overdue_detected_at` and `escalated_at`
// and nothing that says WHICH rung last fired, so a naive detector either re-pages every 30 seconds or
// pages once and goes quiet for the remaining three rungs. Neither is acceptable. The trick is that the rung
// is a pure function of an instant: `overdueTierAt(escalated_at)` reconstructs the rung that was in force
// when the last escalation fired, so a rung fires exactly once and every advance re-stamps `escalated_at`.
// No new column, no drift.
//
// THE `sos_equivalent` RUNG DOES NOT MINT AN SOS ROW. §7.3 wants "the same fan-out as an SOS including
// Tier-1 voice escalation, the same `field_safety_composed` recipient set". That is a ROUTING decision, and
// the decision below carries `sosEquivalent: true` for the alert layer (M20-T06) to act on. Writing an
// actual `safety_sos_alert` would be a press no clinician made: it would pollute the §8.3 anomaly counter,
// the §4.3 `getSosFrequency` metric and every board that counts active SOSs, and §2.6/M20-F10 reserve that
// table for real presses.
import type {
  IsoInstant,
  MembershipId,
  SafetyCheckInKind,
  SafetyCheckInScheduleId,
  SafetyCheckInState,
  SafetyOverdueBadge,
  SafetyOverdueTier,
  SafetyPolicyEffectiveDto,
  VisitId,
} from "@chartwarden/types";
import { SAFETY_SCHEDULE_ACTIONABLE_STATES } from "@chartwarden/types";
import { type SafetySideEffect, withAudit } from "./effects";
import { requireSafety } from "./errors";

/** The four D4 thresholds as a ladder of named rungs, plus `none`, in ascending order — the comparison
 *  basis for "has a NEW rung been crossed?". The type itself lives in @chartwarden/types because it rides the
 *  §4.10 `check_in_escalated` payload. */
export const SAFETY_OVERDUE_TIERS = [
  "none",
  "gentle_reminder",
  "supervisor_alert",
  "escalation",
  "sos_equivalent",
] as const satisfies readonly SafetyOverdueTier[];

function tierRank(tier: SafetyOverdueTier): number {
  return SAFETY_OVERDUE_TIERS.indexOf(tier);
}

/** One `safety_check_in_schedule` row as the detector sees it. */
export interface SafetyCheckInScheduleFacts {
  readonly scheduleId: SafetyCheckInScheduleId;
  readonly state: SafetyCheckInState;
  readonly kind: SafetyCheckInKind;
  readonly expectedAt: IsoInstant;
  readonly windowMinutes: number;
  readonly clinicianMembershipId: MembershipId;
  readonly visitId: VisitId | null;
  readonly overdueDetectedAt: IsoInstant | null;
  readonly escalatedAt: IsoInstant | null;
}

/** Minutes elapsed past `expectedAt` at `atIso` (negative before it). */
export function minutesPastExpected(expectedAt: IsoInstant, atIso: IsoInstant): number {
  return (Date.parse(atIso) - Date.parse(expectedAt)) / 60_000;
}

/** D4 — the rung `minutesOverdue` past `expected_at` falls on. Evaluated highest-first so a tenant that
 *  collapses two thresholds onto the same minute gets the MORE urgent of the two, never the milder. */
export function overdueTierFor(
  minutesOverdue: number,
  policy: Pick<
    SafetyPolicyEffectiveDto,
    | "gentleReminderMinutes"
    | "supervisorAlertMinutes"
    | "escalationMinutes"
    | "sosEquivalentMinutes"
  >,
): SafetyOverdueTier {
  if (minutesOverdue >= policy.sosEquivalentMinutes) return "sos_equivalent";
  if (minutesOverdue >= policy.escalationMinutes) return "escalation";
  if (minutesOverdue >= policy.supervisorAlertMinutes) return "supervisor_alert";
  if (minutesOverdue >= policy.gentleReminderMinutes) return "gentle_reminder";
  return "none";
}

/** The rung in force at an arbitrary instant — how the detector reconstructs which rung last fired without
 *  a column to store it (see the header). */
export function overdueTierAt(input: {
  readonly expectedAt: IsoInstant;
  readonly atIso: IsoInstant;
  readonly policy: Pick<
    SafetyPolicyEffectiveDto,
    | "gentleReminderMinutes"
    | "supervisorAlertMinutes"
    | "escalationMinutes"
    | "sosEquivalentMinutes"
  >;
}): SafetyOverdueTier {
  return overdueTierFor(minutesPastExpected(input.expectedAt, input.atIso), input.policy);
}

/**
 * §4.2 — the per-clinician badge the §5 supervisor board renders.
 *
 * `reminder` is the state between `expected_at` and the close of the fulfilment window: the clinician has
 * been prompted and nobody has been alerted yet. Collapsing it into `on_time` would make the board unable to
 * show the one minute in which a nudge is still the whole response.
 */
export function overdueBadgeFor(input: {
  readonly minutesOverdue: number;
  readonly windowMinutes: number;
  readonly tier: SafetyOverdueTier;
}): SafetyOverdueBadge {
  if (tierRank(input.tier) >= tierRank("supervisor_alert")) return "escalated";
  if (input.tier === "gentle_reminder") return "overdue";
  if (input.minutesOverdue > 0 && input.minutesOverdue < input.windowMinutes) return "reminder";
  return "on_time";
}

/** What the detector should do with one schedule this tick. */
export type SafetyOverdueDecision =
  | {
      readonly kind: "none";
      readonly tier: SafetyOverdueTier;
      readonly badge: SafetyOverdueBadge;
      /** When the next rung becomes due — `null` when the top rung has already fired or the row is no
       *  longer actionable. */
      readonly nextDueAt: IsoInstant | null;
      readonly reason?: "not_actionable" | "within_window" | "rung_already_fired";
    }
  | {
      readonly kind: "advance";
      readonly tier: SafetyOverdueTier;
      readonly badge: SafetyOverdueBadge;
      readonly toState: SafetyCheckInState;
      readonly minutesOverdue: number;
      /** D14 — carried onto the decision (not recomputed by the runner) so the §4.10
       *  `check_in_escalated` payload's `afterHours` is the same boolean this rung was decided under. */
      readonly afterHours: boolean;
      /** §7.3's top rung — the alert layer routes this one like an SOS (Tier-1 voice,
       *  `field_safety_composed`). See the header on why no `safety_sos_alert` row is minted. */
      readonly sosEquivalent: boolean;
      readonly effects: ReadonlyArray<SafetySideEffect>;
    };

/** §2.2.1 — the write-path guard for the states the detector acts on (`proposed`, `overdue`, `escalated`;
 *  migration 0112's widened `scis_overdue_scan_idx` is the same set). The cron's own query already filters,
 *  so this exists for the manual escalate route, where a supervisor may be looking at a stale screen. */
export function assertScheduleActionable(state: SafetyCheckInState): void {
  requireSafety(
    (SAFETY_SCHEDULE_ACTIONABLE_STATES as readonly SafetyCheckInState[]).includes(state),
    "OVERDUE_SCHEDULE_NOT_ACTIONABLE",
    `a schedule in '${state}' is not awaiting a check-in`,
  );
}

/** The instant a rung becomes due for a schedule (its threshold, measured from `expected_at`). */
function rungDueAt(
  expectedAt: IsoInstant,
  policy: SafetyPolicyEffectiveDto,
  tier: SafetyOverdueTier,
): IsoInstant | null {
  const minutes: Record<SafetyOverdueTier, number | null> = {
    none: null,
    gentle_reminder: policy.gentleReminderMinutes,
    supervisor_alert: policy.supervisorAlertMinutes,
    escalation: policy.escalationMinutes,
    sos_equivalent: policy.sosEquivalentMinutes,
  };
  const m = minutes[tier];
  return m === null ? null : new Date(Date.parse(expectedAt) + m * 60_000).toISOString();
}

/** The rung above `tier`, or null at the top. */
function nextTier(tier: SafetyOverdueTier): SafetyOverdueTier | null {
  const next = SAFETY_OVERDUE_TIERS[tierRank(tier) + 1];
  return next ?? null;
}

/**
 * §4.8 `m20.overdue-detector.cron` / §7.3 / D4 — the per-schedule decision.
 *
 * `afterHours` comes from `isAfterHours(policy, now, orgTimeZone)` (./policy) and rides into the §4.10
 * `check_in_escalated` payload, where D14 turns it into the M19 on-call union. It is computed by the caller
 * because the timezone is not on the policy row.
 */
export function decideOverdueCheckIn(input: {
  readonly schedule: SafetyCheckInScheduleFacts;
  readonly policy: SafetyPolicyEffectiveDto;
  readonly nowIso: IsoInstant;
  readonly afterHours: boolean;
}): SafetyOverdueDecision {
  const { schedule, policy, nowIso } = input;
  const minutesOverdue = minutesPastExpected(schedule.expectedAt, nowIso);
  const tier = overdueTierFor(minutesOverdue, policy);
  const badge = overdueBadgeFor({
    minutesOverdue,
    windowMinutes: schedule.windowMinutes,
    tier,
  });

  // A row that flipped to `recorded` between the scan and this decision is an ordinary race, not a fault.
  if (
    !(SAFETY_SCHEDULE_ACTIONABLE_STATES as readonly SafetyCheckInState[]).includes(schedule.state)
  ) {
    return { kind: "none", tier, badge, nextDueAt: null, reason: "not_actionable" };
  }

  // §4.8 — the flip out of `proposed` is governed by the fulfilment WINDOW, not by a D4 threshold: the
  // clinician is not late until the window they were given has closed.
  if (schedule.state === "proposed" && minutesOverdue < schedule.windowMinutes) {
    return {
      kind: "none",
      tier,
      badge,
      nextDueAt: new Date(
        Date.parse(schedule.expectedAt) + schedule.windowMinutes * 60_000,
      ).toISOString(),
      reason: "within_window",
    };
  }

  // Which rung last fired, reconstructed from the two stamps (see the header).
  const lastFired: SafetyOverdueTier =
    schedule.escalatedAt !== null
      ? overdueTierAt({ expectedAt: schedule.expectedAt, atIso: schedule.escalatedAt, policy })
      : schedule.overdueDetectedAt !== null
        ? "gentle_reminder"
        : "none";

  if (tierRank(tier) <= tierRank(lastFired) || tier === "none") {
    const upcoming = nextTier(tier === "none" ? "none" : lastFired);
    return {
      kind: "none",
      tier,
      badge,
      nextDueAt: upcoming === null ? null : rungDueAt(schedule.expectedAt, policy, upcoming),
      reason: tier === "none" ? "within_window" : "rung_already_fired",
    };
  }

  // A NEW rung has been crossed. The gentle rung alerts the subscribed supervisors at `warn`; every rung
  // above it is `critical` and moves the row to `escalated`.
  if (tier === "gentle_reminder") {
    return {
      kind: "advance",
      tier,
      badge,
      toState: "overdue",
      minutesOverdue,
      afterHours: input.afterHours,
      sosEquivalent: false,
      effects: withAudit([
        { kind: "set_schedule_state", state: "overdue" },
        { kind: "set_timestamp", field: "overdue_detected_at", at: nowIso },
        { kind: "outbox", event: "m20.safety.check_in_overdue" },
        { kind: "alert", alert: "m20.safety.check_in_overdue" },
      ]),
    };
  }

  return {
    kind: "advance",
    tier,
    badge,
    toState: "escalated",
    minutesOverdue,
    afterHours: input.afterHours,
    sosEquivalent: tier === "sos_equivalent",
    effects: withAudit([
      { kind: "set_schedule_state", state: "escalated" },
      // Re-stamped on EVERY rung — it is what `overdueTierAt` reads back to know which rung last fired.
      { kind: "set_timestamp", field: "escalated_at", at: nowIso },
      ...(schedule.overdueDetectedAt === null
        ? ([
            { kind: "set_timestamp", field: "overdue_detected_at", at: nowIso },
          ] as const satisfies readonly SafetySideEffect[])
        : []),
      { kind: "outbox", event: "m20.safety.check_in_escalated" },
      { kind: "alert", alert: "m20.safety.check_in_escalated" },
    ]),
  };
}
