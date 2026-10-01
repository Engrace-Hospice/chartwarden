// apps/web/src/modules/14-idg — visibility-aware polling for the Live Meeting surface.
//
// WHY POLLING: there is no realtime channel to subscribe to. `@wardenx/ui` ships a `SocketProvider` leaf
// but nothing in apps/web mounts it, apps/backend has no socket/SSE gateway and neither package depends on
// socket.io (M1 §13.4 realtime server is not built). Rather than invent a server, the live surface
// re-reads its ledgers on a timer while the meeting is `live` and the tab is visible.
//
// Contract:
//   • runs only while `enabled` (the caller passes `meeting.status === "live"`);
//   • never overlaps — a tick is skipped while a refresh is in flight;
//   • pauses while `document.hidden`, and refreshes immediately on `visibilitychange` (→ visible) / `focus`;
//   • aborts the in-flight refresh on unmount / disable / hide (the caller's fetch receives the signal);
//   • a refresh that throws counts as a failure: the next delay doubles (capped at `maxBackoffMs`) and
//     resets after the first success.
import { useCallback, useEffect, useRef, useState } from "react";

export const LIVE_REFRESH_INTERVAL_MS = 10_000;
export const LIVE_REFRESH_MAX_BACKOFF_MS = 60_000;

export interface LiveRefreshOptions {
  /** Poll only while true (a non-live meeting is never polled). */
  readonly enabled: boolean;
  /** Re-read the ledgers. Must reject on failure so the hook can back off; should honour `signal`. */
  readonly refresh: (signal: AbortSignal) => Promise<void>;
  readonly intervalMs?: number;
  readonly maxBackoffMs?: number;
}

export interface LiveRefreshState {
  /** Epoch ms of the last successful refresh, or null before the first. */
  readonly lastUpdatedAt: number | null;
  /** True while the most recent refresh failed (we are backing off). */
  readonly failing: boolean;
  /** Refresh now (no-op while one is in flight or when disabled). */
  readonly refreshNow: () => void;
}

/** Delay before the next tick after `failures` consecutive failures. Exported for tests. */
export function nextDelay(intervalMs: number, failures: number, maxBackoffMs: number): number {
  if (failures <= 0) return intervalMs;
  return Math.min(intervalMs * 2 ** failures, Math.max(maxBackoffMs, intervalMs));
}

export function useLiveRefresh(opts: LiveRefreshOptions): LiveRefreshState {
  const { enabled, intervalMs = LIVE_REFRESH_INTERVAL_MS } = opts;
  const maxBackoffMs = opts.maxBackoffMs ?? LIVE_REFRESH_MAX_BACKOFF_MS;
  const refreshRef = useRef(opts.refresh);
  refreshRef.current = opts.refresh;
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [failing, setFailing] = useState(false);
  const tickRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!enabled) {
      tickRef.current = () => undefined;
      return;
    }
    let disposed = false;
    let inFlight = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clear = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const schedule = (): void => {
      clear();
      if (disposed || document.hidden) return;
      timer = setTimeout(() => void tick(), nextDelay(intervalMs, failures, maxBackoffMs));
    };
    const tick = async (): Promise<void> => {
      if (disposed || inFlight || document.hidden) return;
      clear();
      inFlight = true;
      const mine = new AbortController();
      controller = mine;
      try {
        await refreshRef.current(mine.signal);
        if (!disposed && !mine.signal.aborted) {
          failures = 0;
          setFailing(false);
          setLastUpdatedAt(Date.now());
        }
      } catch {
        if (!disposed && !mine.signal.aborted) {
          failures += 1;
          setFailing(true);
        }
      } finally {
        inFlight = false;
        if (controller === mine) controller = null;
        schedule();
      }
    };
    tickRef.current = () => void tick();

    const onVisibility = (): void => {
      if (document.hidden) {
        clear();
        controller?.abort();
      } else {
        void tick();
      }
    };
    const onFocus = (): void => void tick();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    schedule();
    return () => {
      disposed = true;
      clear();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      tickRef.current = () => undefined;
    };
  }, [enabled, intervalMs, maxBackoffMs]);

  const refreshNow = useCallback(() => tickRef.current(), []);
  return { lastUpdatedAt, failing, refreshNow };
}
