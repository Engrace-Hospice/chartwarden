export const CLAIMMD_ACK_INTERVAL_MS = 15_000;

/** Off by default; the composition root constructs this only after explicit mode preflight. */
export function startClaimMdAckWorker(input: { readonly dispatcher: { runOnce(): Promise<{
  readonly recorded: number; readonly duplicates: number; readonly failures: number }> };
  readonly log: (summary: { recorded: number; duplicates: number; failures: number }) => void;
  readonly intervalMs?: number }) {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { input.log(await input.dispatcher.runOnce()); }
    catch { input.log({ recorded: 0, duplicates: 0, failures: 1 }); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, input.intervalMs ?? CLAIMMD_ACK_INTERVAL_MS);
  timer.unref?.();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
