export const CLAIMMD_ERA_DELIVERY_WORKER_ID = "m25-claimmd-era-delivery";

export function startClaimMdEraDeliveryWorker(input: {
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
