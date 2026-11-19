// apps/web/src/shell — the cues that make an open screen read its data again without the person asking: a timer, and the person coming
// back to the tab (window focus, the tab becoming visible). ONE rule for what such a read is, shared by every screen that does it:
//   * a read the PERSON causes (opening the screen, pressing Refresh) is an ordinary request;
//   * a read a CUE causes (this hook) is background work: the caller sends it with BACKGROUND_REQUEST_HEADERS, so it never counts as the
//     person's activity and an unattended screen cannot keep its session alive for ever (GAP-002).
// The cue fires only while the tab is visible. The callback is read through a ref, so a new function each render never restarts the timer;
// `intervalMs` null means no timer (focus and visibility still cue).
import { useEffect, useRef } from "react";

export function useRefreshCues(onCue: () => void, intervalMs: number | null): void {
  const latest = useRef(onCue);
  useEffect(() => {
    latest.current = onCue;
  });
  useEffect(() => {
    const cue = (): void => {
      if (!document.hidden) latest.current();
    };
    const timer = intervalMs === null ? null : window.setInterval(cue, intervalMs);
    window.addEventListener("focus", cue);
    document.addEventListener("visibilitychange", cue);
    return () => {
      if (timer !== null) window.clearInterval(timer);
      window.removeEventListener("focus", cue);
      document.removeEventListener("visibilitychange", cue);
    };
  }, [intervalMs]);
}
