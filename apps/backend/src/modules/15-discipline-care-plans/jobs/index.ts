// apps/backend/src/modules/15-discipline-care-plans/jobs/index.ts — GAP-044 (spec §4.6).
//
// The five M15 cron definitions (queue names / schedules / BullMQ parameters) and the PURE planners the
// workers in `./cron-workers.ts` compose: facts in, a list of emissions / state flips out, no IO and no
// `Date.now()`. Keeping the decisions here means the nightly runs are unit-testable without a database and
// the Drizzle layer (`./cron-store.ts`) stays a dumb read/write.
//
// Schedules and time zones. The three daily crons + the hour aggregator run on an HOURLY tick and act for an
// org only when the org-LOCAL hour equals the spec's hour (02:00 / 02:15 / 03:00 / 03:30 org-TZ, §4.6) — the
// M21 par-monitor pattern. The zone is the org-level `org_timezone` setting (`organizationTimezone`, default
// America/New_York): every M15 cron decides over an ORG-wide set (plans / gates / ledgers per provider entity),
// not a per-Location one, so the org zone is the right grain. A half-hour-offset zone runs at local hh:45/hh:15
// (the tick is hourly), still once per local day. The 6-hourly supervisory check is not a wall-clock job and
// stays a plain UTC cadence.
import {
  BLOCKING_VOLUNTEER_GATE_KINDS,
  VOLUNTEER_GATE_EXPIRY_POLICY,
  volunteerGateAlertSeverity,
} from "@chartwarden/discipline-plans";
import type { IsoInstant } from "@chartwarden/types";
import {
  type InitialClockFacts,
  evaluateInitialClock,
  evaluateSupervisoryCadence,
  hoursOverdue,
} from "../lifecycle/index";
import {
  type VolunteerGateFacts,
  daysUntilExpiry,
  deriveGateStatus,
  gatesToExpire,
} from "../volunteer/index";

/** The @chartwarden/tenancy platform-job id the active-org enumeration of the M15 crons runs under. */
export const M15_PLATFORM_JOB_ID = "m15-discipline-plan-cron";

export const M15_QUEUES = {
  supervisoryOverdue: "m15.supervisory.overdue-check",
  mswInitialOverdue: "m15.msw.initial-overdue-check",
  chaplainInitialOverdue: "m15.chaplain.initial-overdue-check",
  volunteerGateWatcher: "m15.volunteer.gate-watcher",
  volunteerHourAggregator: "m15.volunteer.hour-aggregator",
} as const;

export const M15_JOB_SCHEDULES = {
  supervisoryOverdue: "0 */6 * * *",
  mswInitialOverdue: "0 * * * *",
  chaplainInitialOverdue: "15 * * * *",
  volunteerGateWatcher: "0 * * * *",
  volunteerHourAggregator: "30 * * * *",
} as const;

/** The org-local hour each hourly-ticked cron acts in (§4.6); `null` = every tick (not a wall-clock job). */
export const M15_LOCAL_HOURS = {
  supervisoryOverdue: null,
  mswInitialOverdue: 2,
  chaplainInitialOverdue: 2,
  volunteerGateWatcher: 3,
  volunteerHourAggregator: 3,
} as const;

/** Local wall-clock hour (0-23) of `at` in an IANA zone; an unusable zone falls back to UTC. */
export function localHourIn(at: Date, timeZone: string): number {
  const read = (zone: string) =>
    Number(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: zone })
        .formatToParts(at)
        .find((p) => p.type === "hour")?.value,
    );
  try {
    return read(timeZone);
  } catch {
    return read("UTC");
  }
}

/** §4.6 — priority / attempts / backoff / concurrency per queue. BullMQ has no backoff cap, so the
 *  spec's "exponential 30 s, cap 5 min" is the exponential base delay only. */
export const M15_QUEUE_PARAMS = {
  supervisoryOverdue: {
    priority: 2,
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    concurrency: 4,
  },
  mswInitialOverdue: {
    priority: 3,
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    concurrency: 2,
  },
  chaplainInitialOverdue: {
    priority: 3,
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    concurrency: 2,
  },
  volunteerGateWatcher: {
    priority: 2,
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    concurrency: 4,
  },
  volunteerHourAggregator: {
    priority: 3,
    attempts: 3,
    backoff: { type: "exponential", delay: 120_000 },
    concurrency: 2,
  },
} as const;

// ── §7.1 supervisory overdue ────────────────────────────────────────────────────────────────────────

export interface SupervisoryPlanRow {
  readonly planId: string;
  readonly nextSupervisoryDueAt: IsoInstant | null;
  readonly cadenceDaysOverride: number | null;
}

export interface SupervisoryOverdueEmission {
  readonly planId: string;
  readonly hoursOverdue: number;
  /** `warn` while past the 14-day due instant; `critical` once the CHHA encounter-sign gate engages. */
  readonly severity: "warn" | "critical";
}

/**
 * §7.1 / §4.7 — one `m15.aide_supervisory.overdue` per plan whose 418.76(h) clock is breached as of
 * `now`. The ladder's `due` (day-12 warning) state emits nothing: the event is "found a BREACHED clock".
 */
export function planSupervisoryOverdue(
  plans: ReadonlyArray<SupervisoryPlanRow>,
  now: IsoInstant,
): ReadonlyArray<SupervisoryOverdueEmission> {
  const out: SupervisoryOverdueEmission[] = [];
  for (const p of plans) {
    if (p.nextSupervisoryDueAt === null) continue;
    const state = evaluateSupervisoryCadence(
      {
        planId: p.planId as never,
        nextSupervisoryDueAt: p.nextSupervisoryDueAt,
        cadenceDaysOverride: p.cadenceDaysOverride,
      },
      now,
    );
    if (state === null) continue;
    if (state.status !== "overdue" && state.status !== "gate_engaged") continue;
    out.push({
      planId: p.planId,
      hoursOverdue: hoursOverdue(p.nextSupervisoryDueAt, now),
      severity: state.status === "gate_engaged" ? "critical" : "warn",
    });
  }
  return out;
}

// ── §7.2 / §7.3 initial-assessment overdue ──────────────────────────────────────────────────────────

export interface InitialClockPlanRow extends InitialClockFacts {
  readonly planId: string;
  readonly admissionId: string;
}

export interface InitialOverdueEmission {
  readonly planId: string;
  readonly admissionId: string;
  readonly daysOverdue: number;
}

/**
 * §7.2 / §7.3 — plans whose D10 5-day clock lapsed unsatisfied. `evaluateInitialClock` already treats a
 * recorded chaplain declination as satisfying, so a declined spiritual plan is never reported (the
 * "respects declined-care path" rule). A plan with no armed clock is never overdue.
 */
export function planInitialOverdue(
  plans: ReadonlyArray<InitialClockPlanRow>,
  now: IsoInstant,
): ReadonlyArray<InitialOverdueEmission> {
  const out: InitialOverdueEmission[] = [];
  for (const p of plans) {
    const state = evaluateInitialClock(p, now);
    if (!state.overdue) continue;
    out.push({ planId: p.planId, admissionId: p.admissionId, daysOverdue: state.daysOverdue });
  }
  return out;
}

export interface MswInitialEmission extends InitialOverdueEmission {
  readonly severity: "warn" | "critical";
}

/**
 * §7.2 / §4.7 — the MSW initial-assessment ladder: `warn` from the day-3 mark until the clock lapses,
 * `critical` once the 5-day CoP 418.54(c) window is breached (spec lines 1149-1160 "day 3+" warn / "day 5+"
 * critical; §7.2 "By T+3 days … `warn` … By T+5 days … escalates to `critical`"; task 23 "3-day warn / 5-day
 * critical"). `daysOverdue` is 0 while still inside the window. Satisfied or unarmed plans emit nothing.
 */
export function planMswInitialAlerts(
  plans: ReadonlyArray<InitialClockPlanRow>,
  now: IsoInstant,
): ReadonlyArray<MswInitialEmission> {
  const out: MswInitialEmission[] = [];
  for (const p of plans) {
    const state = evaluateInitialClock(p, now);
    if (!state.overdue && !state.warning) continue;
    out.push({
      planId: p.planId,
      admissionId: p.admissionId,
      daysOverdue: state.daysOverdue,
      severity: state.overdue ? "critical" : "warn",
    });
  }
  return out;
}

// ── §7.5 volunteer gate watcher ─────────────────────────────────────────────────────────────────────

/** A live gate row plus the notice state the watcher stamps (`last_expiry_notice_days_out`). */
export interface GateWatcherRow extends VolunteerGateFacts {
  /** The tightest ladder mark already notified for this gate, or null when none was sent. */
  readonly lastNoticeDaysOut: number | null;
}

export interface GateExpiryNotice {
  readonly gateId: string;
  readonly volunteerMembershipId: string;
  readonly gateKind: string;
  readonly validUntil: IsoInstant;
  /** The ladder mark this notice is for (30/14/7/1) — the tightest mark crossed. */
  readonly daysOut: number;
  readonly severity: "info" | "warn" | "critical";
}

/**
 * §7.5 — "the tightest ladder mark crossed and not yet notified". A gate `d` whole days out has crossed every
 * mark `m >= d`; the notice that matters is the tightest of those. It fires once per mark (the caller stamps
 * `lastNoticeDaysOut` with it), so a missed daily run still sends the right notice exactly once, a replay
 * sends nothing, and a gate first seen 10 days out gets the 14-day notice rather than waiting for day 7.
 */
export function planGateExpiryNotices(
  gates: ReadonlyArray<GateWatcherRow>,
  now: IsoInstant,
): ReadonlyArray<GateExpiryNotice> {
  const out: GateExpiryNotice[] = [];
  for (const g of gates) {
    if (g.validUntil === null || g.revokedAt !== null) continue;
    const daysOut = daysUntilExpiry(g.validUntil, now);
    if (daysOut === null || daysOut < 0) continue;
    const mark = Math.min(
      ...VOLUNTEER_GATE_EXPIRY_POLICY.alertAtDaysOut.filter((m) => m >= daysOut),
    );
    if (!Number.isFinite(mark)) continue; // further out than the first mark
    if (g.lastNoticeDaysOut !== null && g.lastNoticeDaysOut <= mark) continue;
    out.push({
      gateId: g.gateId,
      volunteerMembershipId: g.volunteerMembershipId,
      gateKind: g.gateKind,
      validUntil: g.validUntil,
      daysOut: mark,
      severity: volunteerGateAlertSeverity(mark),
    });
  }
  return out;
}

export interface GateWatcherPlan {
  /** Gates whose stored status is `satisfied`/`expiring_soon` and past their `valid_until` → `expired`. */
  readonly toExpire: ReadonlyArray<VolunteerGateFacts>;
  /** Gates still `satisfied` in the column that entered the 30-day lead-in → `expiring_soon`. */
  readonly toMarkExpiringSoon: ReadonlyArray<VolunteerGateFacts>;
  /** The ladder notices due (tightest mark crossed, not yet notified). */
  readonly notices: ReadonlyArray<GateExpiryNotice>;
}

/** Whether an expired gate of this kind cascades to the volunteer's open assignments (§7.5). */
export function expiryCascades(gate: VolunteerGateFacts): boolean {
  return BLOCKING_VOLUNTEER_GATE_KINDS.includes(gate.gateKind);
}

/** §7.5 — everything one nightly gate-watcher pass decides over an org's live gate rows. */
export function planGateWatcher(
  gates: ReadonlyArray<GateWatcherRow>,
  now: IsoInstant,
): GateWatcherPlan {
  const toExpire = gatesToExpire(gates, now);
  const toMarkExpiringSoon = gates.filter(
    (g) =>
      g.status === "satisfied" &&
      g.revokedAt === null &&
      deriveGateStatus(g, now) === "expiring_soon",
  );
  return { toExpire, toMarkExpiringSoon, notices: planGateExpiryNotices(gates, now) };
}
