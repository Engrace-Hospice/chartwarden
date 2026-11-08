import type { createClaimMdEraStore } from "./claimmd-era-store";

export { CLAIMMD_ERA_RESOLUTION_JOB_ID } from "./claimmd-era-store";
type Store = ReturnType<typeof createClaimMdEraStore>;

/** Disabled unless explicitly constructed by the worker composition root; never calls vendor or M25 posting APIs. */
export function createClaimMdEraResolutionWorker(input: {
  readonly store: Store;
  readonly resolver: {
    resolve(inboxId: string): Promise<{ readonly status: string; readonly version: number }>;
  };
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly log?: (summary: {
    readonly examined: number;
    readonly verified: number;
    readonly held: number;
    readonly failed: number;
  }) => void;
}) {
  return {
    async runOnce() {
      const inboxIds = await input.store.pendingResolution(input.accountReference, input.usage, 25);
      let verified = 0;
      let held = 0;
      let failed = 0;
      for (const inboxId of inboxIds) {
        try {
          const result = await input.resolver.resolve(inboxId);
          if (result.status === "verified") verified++;
          else held++;
        } catch {
          failed++;
        }
      }
      const summary = { examined: inboxIds.length, verified, held, failed };
      input.log?.(summary);
      return summary;
    },
  };
}

export function startClaimMdEraResolutionWorker(input: {
  readonly runOnce: () => Promise<unknown>;
  readonly intervalMs?: number;
  readonly logError?: () => void;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      await input.runOnce();
    } catch {
      input.logError?.();
    }
    if (!stopped) timer = setTimeout(() => void tick(), input.intervalMs ?? 60_000);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
