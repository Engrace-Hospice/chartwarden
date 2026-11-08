import type { createClaimMdIdentityWorker } from "./service";

export const CLAIMMD_IDENTITY_JOB_ID = "m23-claimmd-identity-resolver";
export const CLAIMMD_IDENTITY_BATCH_SIZE = 25;
export const CLAIMMD_IDENTITY_LEASE_MS = 60_000;
export const CLAIMMD_IDENTITY_INTERVAL_MS = 15_000;

export interface IdentityWorkerSummary {
  readonly pending: number;
  readonly resolved: number;
  readonly unmatched: number;
  readonly ambiguous: number;
  readonly conflict: number;
  readonly needsReview: number;
  readonly oldestUnresolvedSeconds: number | null;
}

/** Start only after explicit enablement and runtime preflight. The in-process guard complements DB leases. */
export function startClaimMdIdentityWorker(input: {
  readonly worker: ReturnType<typeof createClaimMdIdentityWorker>;
  readonly summarize: () => Promise<IdentityWorkerSummary>;
  readonly intervalMs?: number;
  readonly log: (event: { processed: number; failed: number; summary: IdentityWorkerSummary }) => void;
}) {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await input.worker.runOnce();
      const summary = await input.summarize();
      input.log({ ...result, summary });
    } catch {
      input.log({ processed: 0, failed: 1, summary: {
        pending: 0, resolved: 0, unmatched: 0, ambiguous: 0, conflict: 0, needsReview: 0,
        oldestUnresolvedSeconds: null,
      } });
    } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, input.intervalMs ?? CLAIMMD_IDENTITY_INTERVAL_MS);
  timer.unref?.();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
