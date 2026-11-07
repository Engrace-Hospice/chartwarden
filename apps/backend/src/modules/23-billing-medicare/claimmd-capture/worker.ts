import type { ClaimMdUsage } from "@chartwarden/x12-837-client";
import type { CaptureCounters, createClaimMdResponseCapture } from "./service";

export const CLAIMMD_RESPONSE_CAPTURE_INTERVAL_MS = 60_000;

/** Non-overlapping account poller; the composition root calls this only after explicit opt-in and preflight. */
export function startClaimMdResponseCaptureWorker(input: {
  readonly capture: ReturnType<typeof createClaimMdResponseCapture>;
  readonly accountReference: string;
  readonly usage: ClaimMdUsage;
  readonly intervalMs?: number;
  readonly log: (summary: CaptureCounters) => void;
}) {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      input.log(await input.capture.runOnce(input.accountReference, input.usage));
    } catch {
      input.log({ pages: 0, events: 0, duplicates: 0, needsReview: 0, cursor: null, code: "CAPTURE_FAILED" });
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(() => void tick(), input.intervalMs ?? CLAIMMD_RESPONSE_CAPTURE_INTERVAL_MS);
    }
  };
  void tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
