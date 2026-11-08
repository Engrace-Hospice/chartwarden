import type { ClaimMdEraUsage } from "@chartwarden/x12-837-client";
import type { ClaimMdEraCaptureSummary } from "./claimmd-era-capture";

/** Disabled workers are never constructed. A non-overlapping timer calls a bounded capture tick. */
export function startClaimMdEraCaptureWorker(input: {
  runOnce(accountReference: string, usage: ClaimMdEraUsage): Promise<ClaimMdEraCaptureSummary>;
  readonly accountReference: string;
  readonly usage: ClaimMdEraUsage;
  readonly intervalMs?: number;
  readonly log?: (summary: ClaimMdEraCaptureSummary) => void;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interval = input.intervalMs ?? 60_000;
  const tick = async () => {
    if (stopped) return;
    try {
      input.log?.(await input.runOnce(input.accountReference, input.usage));
    } catch {
      input.log?.({ code: "CAPTURE_FAILED", discovered: 0, captured: 0, failed: 1, cursor: null });
    }
    if (!stopped) timer = setTimeout(() => void tick(), interval);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
