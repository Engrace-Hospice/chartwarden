// apps/backend/src/modules/37-ipu/jobs/watchdog-plans.ts — GAP-105 (#174): the pure decisions behind M37's
// five remaining §4.8 crons (irc-cap-watchdog, census-snapshot-builder, restraint-reassessment-watchdog,
// bed-cleaning-sla-watchdog, gip-criteria-staleness-sweep). No IO, no clock reads — `nowMs` and every fact
// are injected, so each decision is unit-testable without Redis or a database. The queue catalog for these
// crons is declared here as data too (the M37 `jobs/index.ts` precedent), kept out of that shared file so
// two agents never edit one declaration.
import {
  type IrcOutboxEvent,
  isRestraintReassessmentDue,
  isTurnoverOverdue,
  normalizeTurnoverSlaMinutes,
  planIrcDailyTick,
} from "@chartwarden/inpatient";
import type { IpuBedCleaningStatus, IrcEpisodeState } from "@chartwarden/types";

// ── §4.8 queue catalog (names carry no ':' — BullMQ forbids it in queue names) ───────────────────────────

export const M37_WATCHDOG_QUEUES = {
  /** Hourly, per-org local-day catch-up: advances `irc_episode.consecutive_day_count` (§2.5, D6). */
  ircCapWatchdog: "ipu.irc-cap-watchdog",
  /** Hourly, per-org local-day catch-up: builds `ipu_census_snapshot` for the closed service date (D14). */
  censusSnapshotBuilder: "ipu.census-snapshot-builder",
  /** Every 15 minutes: active restraints past their reassessment interval (D11). */
  restraintReassessmentWatchdog: "ipu.restraint-reassessment-watchdog",
  /** Every 15 minutes: beds past the turnover SLA (D13). */
  bedCleaningSlaWatchdog: "ipu.bed-cleaning-sla-watchdog",
  /** Nightly: GIP admissions with no reassessment in 72 hours (D5). */
  gipCriteriaStalenessSweep: "ipu.gip-criteria-staleness-sweep",
} as const;

/**
 * The cadences. Spec §4.8 says the IRC and census crons run "daily at per-org midnight". A BullMQ repeatable
 * has ONE timezone, so a single fixed cron cannot be every tenant's midnight; both therefore tick HOURLY and
 * decide per org whether the tenant-local day has rolled (the work itself is idempotent per local date). The
 * census runs 30 minutes after the IRC tick so the IRC state a snapshot reads is always the current day's.
 */
export const M37_WATCHDOG_SCHEDULES = {
  ircCapWatchdog: "10 * * * *",
  censusSnapshotBuilder: "40 * * * *",
  restraintReassessmentWatchdog: "*/15 * * * *",
  bedCleaningSlaWatchdog: "*/15 * * * *",
  gipCriteriaStalenessSweep: "15 7 * * *",
} as const;

export const M37_WATCHDOG_QUEUE_PARAMS = {
  ircCapWatchdog: { priority: 2, attempts: 3, backoff: "exponential 60s", concurrency: 1 },
  censusSnapshotBuilder: { priority: 2, attempts: 3, backoff: "exponential 60s", concurrency: 1 },
  restraintReassessmentWatchdog: {
    priority: 1,
    attempts: 3,
    backoff: "exponential 30s",
    concurrency: 1,
  },
  bedCleaningSlaWatchdog: { priority: 3, attempts: 3, backoff: "exponential 60s", concurrency: 1 },
  gipCriteriaStalenessSweep: {
    priority: 3,
    attempts: 3,
    backoff: "exponential 120s",
    concurrency: 1,
  },
} as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ── local-date arithmetic (ISO `YYYY-MM-DD` strings; the org timezone is resolved upstream) ──────────────

function dateToUtcMs(isoDate: string): number {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`M37_WATCHDOG: '${isoDate}' is not an ISO date`);
  return ms;
}

/** `isoDate` shifted by `days` calendar days (negative = earlier). */
export function addDaysToIsoDate(isoDate: string, days: number): string {
  return new Date(dateToUtcMs(isoDate) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole calendar days from `fromIsoDate` to `toIsoDate` (negative when `to` is earlier). */
export function daysBetweenIsoDates(fromIsoDate: string, toIsoDate: string): number {
  return Math.round((dateToUtcMs(toIsoDate) - dateToUtcMs(fromIsoDate)) / DAY_MS);
}

// ── IRC cap (§2.5, D6) ───────────────────────────────────────────────────────────────────────────────────

/** Bounds one episode's catch-up so a corrupt `started_at` cannot spin the loop. */
export const IRC_CATCH_UP_MAX_DAYS = 60;

export interface IrcEpisodeFact {
  readonly consecutiveDayCount: number;
  readonly state: IrcEpisodeState;
  readonly overrideExtensionDays: number;
  /** The tenant-local calendar date the episode started on. */
  readonly startedLocalDate: string;
  /** §2.5 resumption: days inherited from a prior episode closed within 30 days (0/absent = fresh). */
  readonly carriedOverDays?: number;
}

export interface IrcCatchUpPlan {
  readonly consecutiveDayCount: number;
  readonly state: Exclude<IrcEpisodeState, "closed">;
  /** One entry per state ENTRY (approaching / breached), with the day count it fired at. */
  readonly events: readonly {
    readonly event: IrcOutboxEvent;
    readonly consecutiveDayCount: number;
  }[];
}

/**
 * §2.5 — bring an episode's consecutive-day count up to the tenant-local day it is today.
 *
 * `planIrcDailyTick` increments by exactly one, and a cron that ticks "once a day" would double-count on a
 * retry and skip a day on an outage. So the TARGET is derived from the calendar (day 1 = the start date, plus any
 * days a resumed episode inherited) and
 * the tick is applied until the stored count reaches it: re-running on the same local day finds count ==
 * target and returns null (a no-op), and a missed day is caught up rather than lost. Each state ENTRY is
 * reported once, with the count it fired at, because `planIrcDailyTick` already emits only on a transition.
 *
 * A `closed` episode and an episode already at its target return null.
 */
export function planIrcCatchUp(
  episode: IrcEpisodeFact,
  todayLocalDate: string,
): IrcCatchUpPlan | null {
  if (episode.state === "closed") return null;
  const elapsed = daysBetweenIsoDates(episode.startedLocalDate, todayLocalDate);
  const target = Math.min(
    (episode.carriedOverDays ?? 0) + Math.max(elapsed, 0) + 1,
    episode.consecutiveDayCount + IRC_CATCH_UP_MAX_DAYS,
  );
  if (episode.consecutiveDayCount >= target) return null;

  let count = episode.consecutiveDayCount;
  let state: Exclude<IrcEpisodeState, "closed"> = episode.state;
  const events: { event: IrcOutboxEvent; consecutiveDayCount: number }[] = [];
  while (count < target) {
    const tick = planIrcDailyTick({
      consecutiveDayCount: count,
      state,
      overrideExtensionDays: episode.overrideExtensionDays,
    });
    count = tick.consecutiveDayCount;
    state = tick.state;
    for (const effect of tick.effects) {
      if (effect.kind === "outbox")
        events.push({ event: effect.event, consecutiveDayCount: count });
    }
  }
  return { consecutiveDayCount: count, state, events };
}

// ── reminder cycles (restraint + bed cleaning) ───────────────────────────────────────────────────────────

/**
 * Which "nag cycle" a still-overdue item is in, when THIS tick should raise it — else null.
 *
 * An overdue item is re-raised every `repeatMs` after it first went overdue (a restraint nobody has
 * reassessed is a standing hazard; one alert at the deadline and silence after would hide it). A tick fires
 * only inside the first `windowMs` of each cycle, so a 15-minute cron raises it once per cycle rather than
 * on every tick, and the cycle index is the alert's correlation key — so the two ticks a 20-minute window
 * can catch, or a BullMQ retry, collapse into one alert instead of paging twice.
 */
export function reminderCycle(
  dueAtMs: number,
  nowMs: number,
  repeatMs: number,
  windowMs: number,
): number | null {
  if (nowMs < dueAtMs || repeatMs <= 0) return null;
  const elapsed = nowMs - dueAtMs;
  const cycle = Math.floor(elapsed / repeatMs);
  return elapsed - cycle * repeatMs < Math.min(windowMs, repeatMs) ? cycle : null;
}

/** A 15-minute cron's catch window: wide enough that one jittered tick cannot miss a cycle. */
export const WATCHDOG_REMINDER_WINDOW_MS = 20 * MINUTE_MS;

// ── restraint (§2.10, D11) ───────────────────────────────────────────────────────────────────────────────

export interface ActiveRestraintFact {
  readonly restraintEventId: string;
  readonly ipuAdmissionId: string;
  readonly intervalMinutes: number;
  /** The last reassessment, or the application instant when none has been recorded. */
  readonly lastAssessedAtMs: number;
}

export interface RestraintDuePlan {
  readonly restraintEventId: string;
  readonly ipuAdmissionId: string;
  readonly dueAtMs: number;
  readonly cycle: number;
}

/** §2.10 — the restraints this tick owes a `reassessment_due` for. */
export function planRestraintReassessmentDue(
  restraints: readonly ActiveRestraintFact[],
  nowMs: number,
): RestraintDuePlan[] {
  const plans: RestraintDuePlan[] = [];
  for (const r of restraints) {
    if (!isRestraintReassessmentDue(r.lastAssessedAtMs, r.intervalMinutes, nowMs)) continue;
    const repeatMs = r.intervalMinutes * MINUTE_MS;
    const dueAtMs = r.lastAssessedAtMs + repeatMs;
    const cycle = reminderCycle(dueAtMs, nowMs, repeatMs, WATCHDOG_REMINDER_WINDOW_MS);
    if (cycle === null) continue;
    plans.push({
      restraintEventId: r.restraintEventId,
      ipuAdmissionId: r.ipuAdmissionId,
      dueAtMs,
      cycle,
    });
  }
  return plans;
}

// ── bed cleaning (§2.12, D13) ────────────────────────────────────────────────────────────────────────────

export interface TurnoverBedFact {
  readonly bedId: string;
  readonly unitId: string;
  readonly status: IpuBedCleaningStatus;
  /** When the bed entered `discharged_dirty` (the SLA clock start). */
  readonly dischargedDirtyAtMs: number;
  readonly configuredSlaMinutes: number;
}

export interface BedOverduePlan {
  readonly bedId: string;
  readonly unitId: string;
  readonly dischargedDirtyAtMs: number;
  readonly slaMinutes: number;
  readonly cycle: number;
}

/**
 * §2.12 — the beds this tick owes a `cleaning_overdue` for. The unit's configured SLA is applied
 * tighten-only (`normalizeTurnoverSlaMinutes` throws on a loosened value; the column CHECK is the backstop,
 * so a corrupt row falls back to the 120-minute platform floor rather than aborting the whole tick).
 */
export function planBedCleaningOverdue(
  beds: readonly TurnoverBedFact[],
  nowMs: number,
): BedOverduePlan[] {
  const plans: BedOverduePlan[] = [];
  for (const b of beds) {
    const slaMinutes = safeTurnoverSla(b.configuredSlaMinutes);
    if (!isTurnoverOverdue(b.status, b.dischargedDirtyAtMs, nowMs, slaMinutes)) continue;
    const slaMs = slaMinutes * MINUTE_MS;
    // Re-raise once per further SLA period the bed stays dirty (a 2-hour turnover nags every 2 hours).
    const cycle = reminderCycle(
      b.dischargedDirtyAtMs + slaMs,
      nowMs,
      slaMs,
      WATCHDOG_REMINDER_WINDOW_MS,
    );
    if (cycle === null) continue;
    plans.push({
      bedId: b.bedId,
      unitId: b.unitId,
      dischargedDirtyAtMs: b.dischargedDirtyAtMs,
      slaMinutes,
      cycle,
    });
  }
  return plans;
}

function safeTurnoverSla(configuredMinutes: number): number {
  try {
    return normalizeTurnoverSlaMinutes(configuredMinutes);
  } catch {
    return normalizeTurnoverSlaMinutes(120);
  }
}

// ── GIP reassessment staleness (§2.4, D5) ────────────────────────────────────────────────────────────────

/** §4.8 — the nightly sweep flags a GIP admission with no reassessment in this many hours. */
export const GIP_STALENESS_SWEEP_HOURS = 72;

export interface GipAdmissionFact {
  readonly ipuAdmissionId: string;
  /** Last reassessment, else the criteria attestation, else the activation — the staleness clock start. */
  readonly lastAssessedAtMs: number;
  readonly hasReassessment: boolean;
}

export interface GipStalePlan {
  readonly ipuAdmissionId: string;
  readonly lastAssessedAtMs: number;
  readonly staleHours: number;
}

export function planGipStaleness(
  admissions: readonly GipAdmissionFact[],
  nowMs: number,
): GipStalePlan[] {
  const plans: GipStalePlan[] = [];
  for (const a of admissions) {
    const staleHours = (nowMs - a.lastAssessedAtMs) / HOUR_MS;
    if (staleHours <= GIP_STALENESS_SWEEP_HOURS) continue;
    plans.push({
      ipuAdmissionId: a.ipuAdmissionId,
      lastAssessedAtMs: a.lastAssessedAtMs,
      staleHours: Math.floor(staleHours),
    });
  }
  return plans;
}
