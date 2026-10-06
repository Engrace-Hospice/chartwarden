// apps/backend/src/modules/13-emar/jobs/windows.ts — tick-aligned window arithmetic for M13's deadline sweeps.
//
// WHY. The deadline sweeps (reconciliation warning/overdue, PRN reassessment overdue) emit an EVENT when a
// deadline is crossed, and nothing M13 owns records "already warned" (no schema change). So each tick covers
// exactly the half-open interval `(tickEnd - period, tickEnd]` where `tickEnd` is `now` floored to the period
// grid — consecutive ticks tile the timeline with no gap and no overlap regardless of scheduler jitter, so a
// deadline is announced exactly once. Pure.

const MS_PER_MINUTE = 60_000;

export interface TickWindow {
  /** Exclusive lower bound. */
  readonly from: Date;
  /** Inclusive upper bound — `now` floored to the period grid. */
  readonly to: Date;
}

/** The half-open window `(to - periodMinutes, to]` ending at `now` floored to a `periodMinutes` boundary. */
export function tickWindow(now: Date, periodMinutes: number): TickWindow {
  if (!Number.isInteger(periodMinutes) || periodMinutes <= 0) {
    throw new Error(
      `M13 tickWindow: periodMinutes must be a positive integer, got ${periodMinutes}`,
    );
  }
  const periodMs = periodMinutes * MS_PER_MINUTE;
  const to = Math.floor(now.getTime() / periodMs) * periodMs;
  return { from: new Date(to - periodMs), to: new Date(to) };
}

/** True when `instant` lies in `(window.from, window.to]`. */
export function inTickWindow(instant: Date, window: TickWindow): boolean {
  const t = instant.getTime();
  return t > window.from.getTime() && t <= window.to.getTime();
}

/** The same window shifted `offsetMs` later: `(from + offset, to + offset]` — "deadline `offset` from now". */
export function shiftWindow(window: TickWindow, offsetMs: number): TickWindow {
  return {
    from: new Date(window.from.getTime() + offsetMs),
    to: new Date(window.to.getTime() + offsetMs),
  };
}
