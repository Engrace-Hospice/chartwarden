// apps/backend/src/modules/36-messaging/attachments/attachment-scan-gate.ts — WP 1.5: the small, pure-ish pieces that keep
// scanning from becoming a cross-tenant availability lever (round-3 review). No I/O, no DB.
//
//   • `ScanFailure`        a scan that threw, tagged with WHERE: the tenant's own object store, or the scanner transport.
//                          Both are charged to the ONE org whose row failed (per-org cap in the sweep); neither feeds any
//                          shared signal, so no tenant can make another tenant's files wait.
//   • `withDeadline`       a hard wall-clock bound for one scan (read + scanner).
//   • `rotateOrgs`         the sweep's starting org advances every tick, so no org is permanently scanned first or last.
//   • `createInlineScanGate` the bound on concurrent inline (`complete`) scans: each reads up to 25 MB into memory.
//   • `createFixedWindowCounter` a per-process per-user request counter (complete); authorize is counted from its rows.

export type ScanFailureKind = "store" | "scanner";

export class ScanFailure extends Error {
  constructor(
    readonly kind: ScanFailureKind,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : `attachment ${kind} failure`);
    this.name = "ScanFailure";
  }
}

/** Reject with a `ScanFailure` of `kind()` (the phase the scan was in) if `work` has not settled within `ms`. */
export function withDeadline<T>(work: Promise<T>, ms: number, kind: () => ScanFailureKind): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ScanFailure(kind(), new Error("attachment scan exceeded its deadline"))),
      ms,
    );
  });
  // The abandoned `work` keeps its own socket/read timeouts; it may still settle the row, which is idempotent.
  work.catch(() => undefined);
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
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
