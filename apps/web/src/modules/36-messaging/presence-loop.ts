// WP 2.12: a visibility-aware repeating request with jitter and error backoff. Used by the presence heartbeat and poll.
//
// Runs once now, then again after `baseMs` (jittered). While the tab is hidden no timer exists and no request is made; the
// loop resumes with an immediate run when the tab is shown again. An "error" doubles the delay (capped), "ok" resets it,
// and "stop" ends the loop for good and tells the caller (the feature is off for this user, or the channel is gone).
import { backoffDelay, jittered } from "./presence-utils";

export type LoopOutcome = "ok" | "error" | "stop";
const MAX_FAILURE_STEPS = 6;

export function startPresenceLoop(
  run: () => Promise<LoopOutcome>,
  baseMs: number,
  onStop: () => void,
): () => void {
  let timer: number | undefined;
  let failures = 0;
  let stopped = false;
  let inFlight = false;

  const clear = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (): void => {
    if (stopped || document.hidden) return;
    timer = window.setTimeout(() => void tick(), jittered(backoffDelay(baseMs, failures)));
  };
  const tick = async (): Promise<void> => {
    timer = undefined;
    if (stopped || inFlight || document.hidden) return;
    inFlight = true;
    const outcome = await run().catch((): LoopOutcome => "error");
    inFlight = false;
    if (stopped) return;
    if (outcome === "stop") {
      stopped = true;
      onStop();
      return;
    }
    failures = outcome === "ok" ? 0 : Math.min(failures + 1, MAX_FAILURE_STEPS);
    schedule();
  };
  const onVisibility = (): void => {
    if (stopped) return;
    if (document.hidden) {
      clear();
      return;
    }
    if (timer === undefined && !inFlight) {
      failures = 0;
      void tick();
    }
  };

  document.addEventListener("visibilitychange", onVisibility);
  void tick();
  return () => {
    stopped = true;
    clear();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
