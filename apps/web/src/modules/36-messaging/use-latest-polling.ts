// The channel thread's safety-net polling (moved out of conversation-thread.tsx unchanged in WP 2.2, to keep that file
// under the line ceiling): read the latest page on a timer that backs off after failures, pauses while the tab is
// hidden, and runs slowly while the realtime socket is up. Also re-reads when the tab becomes visible or focused.
import { useEffect } from "react";

const POLL_INTERVAL_MS = 15_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const REALTIME_POLL_INTERVAL_MS = 120_000;

export function useLatestPolling(
  loadLatest: (background?: boolean) => Promise<boolean>,
  realtimeConnected: boolean,
): void {
  useEffect(() => {
    let timer: number | undefined;
    let failures = 0;
    let stopped = false;
    const base = realtimeConnected ? REALTIME_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    const schedule = (): void => {
      const delay = Math.min(base * 2 ** failures, Math.max(MAX_POLL_INTERVAL_MS, base));
      timer = window.setTimeout(tick, delay);
    };
    const tick = async (): Promise<void> => {
      if (stopped) return;
      if (document.hidden) {
        schedule();
        return;
      }
      failures = (await loadLatest(true)) ? 0 : Math.min(failures + 1, 2);
      schedule();
    };
    const refreshWhenVisible = (): void => {
      if (!document.hidden) void loadLatest(true);
    };
    schedule();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [loadLatest, realtimeConnected]);
}
