// apps/backend/src/modules/36-messaging/attachments/attachment-scan-gate.ts — WP 1.5: the small, pure-ish pieces that keep
// scanning from becoming a cross-tenant availability lever (round-3 review). No I/O, no DB.
//
//   • `ScanFailure`        a scan that threw, tagged with WHERE: the tenant's own object store, or the scanner transport.
//                          Both are charged to the ONE org whose row failed (per-org cap in the sweep); neither feeds any
//                          shared signal, so no tenant can make another tenant's files wait.
//   • `runWithDeadline`    a hard wall-clock bound for one scan or storage call that ABORTS the work (signal), not abandons it.
//   • `rotateOrgs`         the sweep's starting org advances every tick (the tiebreak when there are more orgs than time).
//   • `fairShareMs`        each org's slice of a tick's remaining budget (work-conserving: unused time flows to later orgs).
//   • `createInlineScanGate` the bound on concurrent inline (`complete`) scans: each reads up to 25 MB into memory.
//   • `createFixedWindowCounter` a per-process per-user request counter (complete); authorize is counted from its rows.

export type ScanFailureKind = "store" | "scanner";

/** After a deadline aborts the work, how long to wait for it to actually stop before giving up on a non-cooperating port. */
export const ABORT_SETTLE_GRACE_MS = 5_000;

export class ScanFailure extends Error {
  constructor(
    readonly kind: ScanFailureKind,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : `attachment ${kind} failure`);
    this.name = "ScanFailure";
  }
}

/**
 * Run `work` under a hard wall-clock bound that REALLY stops it. At `ms` the `signal` handed to `work` is aborted (the
 * port destroys its socket / aborts its fetch) and the call rejects with `makeError()` as soon as `work` settles, so a
 * caller that holds a slot (the inline scan gate) releases it only when the work has stopped, not while it still runs.
 * Backstop: a port that ignores the signal cannot wedge the caller forever; `graceMs` after the abort the call rejects
 * anyway (the abandoned work then runs to its own timeout, the pre-abort behaviour).
 */
export async function runWithDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  makeError: () => Error,
  graceMs: number = ABORT_SETTLE_GRACE_MS,
): Promise<T> {
  const controller = new AbortController();
  let deadlineHit = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backstop: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      deadlineHit = true;
      controller.abort(makeError());
      backstop = setTimeout(() => reject(makeError()), graceMs);
    }, ms);
  });
  const running = work(controller.signal).catch((error: unknown) => {
    throw deadlineHit ? makeError() : error;
  });
  try {
    return await Promise.race([running, stuck]);
  } finally {
    clearTimeout(timer);
    clearTimeout(backstop);
    running.catch(() => undefined); // a backstopped run may still reject later: never an unhandled rejection
  }
}

/** Throws if the deadline already fired. Called between a scan's steps so no verdict is written after the abort. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("attachment work aborted");
  }
}

/**
 * The org list starting at a tick-derived offset. The cron fires once a minute, so `floor(nowMs / 60 s)` advances by one
 * per tick and every org takes every position in turn; a tick that runs out of budget therefore drops a DIFFERENT tail
 * each time. Stateless on purpose (no cursor to persist or lose); a skipped tick just skips one rotation step.
 */
export function rotateOrgs<T>(orgs: readonly T[], nowMs: number, periodMs = 60_000): T[] {
  if (orgs.length < 2) return [...orgs];
  const start = Math.floor(nowMs / periodMs) % orgs.length;
  return [...orgs.slice(start), ...orgs.slice(0, start)];
}

/**
 * This org's time slice: the budget still unspent divided by the orgs still to go (this one included). Deterministic and
 * work-conserving: an org that finishes early leaves its time to the later ones, an org that drags is cut off at its
 * share so the orgs behind it still get theirs. Never negative.
 */
export function fairShareMs(remainingBudgetMs: number, orgsLeft: number): number {
  return Math.max(0, remainingBudgetMs) / Math.max(1, orgsLeft);
}

export interface InlineScanGate {
  /** A release function, or null when saturated (the caller leaves the row pending for the sweep: not an error). */
  tryAcquire(orgId: string): (() => void) | null;
}

export function createInlineScanGate(maxPerProcess: number, maxPerOrg: number): InlineScanGate {
  let total = 0;
  const byOrg = new Map<string, number>();
  return {
    tryAcquire(orgId) {
      const org = byOrg.get(orgId) ?? 0;
      if (total >= maxPerProcess || org >= maxPerOrg) return null;
      total += 1;
      byOrg.set(orgId, org + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        total -= 1;
        const left = (byOrg.get(orgId) ?? 1) - 1;
        if (left <= 0) byOrg.delete(orgId);
        else byOrg.set(orgId, left);
      };
    },
  };
}

/** Fixed-window counter: `hit(key)` returns the count in the current window. Per process (ponytail: a replica multiplies it). */
export function createFixedWindowCounter(windowMs: number, nowMs: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    hit(key: string): number {
      const t = nowMs();
      const found = windows.get(key);
      if (!found || t - found.start >= windowMs) {
        if (windows.size > 10_000) windows.clear(); // bound memory; a reset only under-counts
        windows.set(key, { start: t, count: 1 });
        return 1;
      }
      found.count += 1;
      return found.count;
    },
  };
}
