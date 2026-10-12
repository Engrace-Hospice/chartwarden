import { useEffect, useRef } from "react";

const SCANNING_REFRESH_START_MS = 5_000;
const SCANNING_REFRESH_MAX_MS = 30_000;
/** A file still "scanning" after this long is left alone; the next poll/push/focus read still updates it. */
const SCANNING_REFRESH_BUDGET_MS = 10 * 60_000;

/**
 * While `scanningKey` is non-empty (it names the scanning attachments a latest-page read can update, sorted and
 * joined) call `refresh` on a doubling timer, 5 s up to 30 s, for at most SCANNING_REFRESH_BUDGET_MS. A change of
 * the key restarts the backoff and the budget. Stops when the key empties, when `resetKey` changes (channel
 * switch) and on unmount; ticks while the document is hidden skip the read.
 */
export function useScanningRefresh(
  scanningKey: string,
  refresh: (background: boolean) => unknown,
  resetKey: string,
): void {
  // The newest refresh without restarting the backoff each time its identity changes.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey restarts the backoff on a channel switch
  useEffect(() => {
    if (scanningKey === "") return;
    // Only ticks that actually read (visible document) spend the budget, so a backgrounded tab does not use it
    // up and leave a still-scanning file stuck when the user comes back; hidden ticks keep the cheap timer going.
    let spent = 0;
    let delay = SCANNING_REFRESH_START_MS;
    let timer: number | undefined;
    const tick = (): void => {
      if (!document.hidden) {
        if (spent >= SCANNING_REFRESH_BUDGET_MS) return;
        spent += delay;
        void refreshRef.current(true);
      }
      delay = Math.min(delay * 2, SCANNING_REFRESH_MAX_MS);
      timer = window.setTimeout(tick, delay);
    };
    timer = window.setTimeout(tick, delay);
    return () => window.clearTimeout(timer);
  }, [scanningKey, resetKey]);
}
