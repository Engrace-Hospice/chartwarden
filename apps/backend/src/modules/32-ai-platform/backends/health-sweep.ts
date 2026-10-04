// apps/backend/src/modules/32-ai-platform/backends/health-sweep.ts — the backend health sweep (F-236).
//
// The routing gate routes only `healthy` / `degraded` backends and treats `unknown` (registered, never
// probed) as unroutable (routing.ts). Nothing on the platform ever WROTE `last_health_status`, so every
// registered backend was `unknown` forever and no route could resolve. This is that writer: it asks each
// bound adapter for its own health (Ollama: is the configured tag pulled; Anthropic: does the model
// resolve) and records the answer with the platform credential's two-column grant
// (provision-runtime-roles.ts) — it can record a probe, never re-pin, re-activate or flip ZDR.
//
// A probe that throws or exceeds the timeout records `unhealthy`: "we could not ask" never reads as fine.
// Runs in the worker process only (one writer), once at start and then on an interval.
import type { ModelBackend } from "@wardenx/ai-platform";
import { type DbClient, schema } from "@wardenx/db";
import type { AiBackendHealthStatus } from "@wardenx/types";
import { eq } from "drizzle-orm";

const PROBE_TIMEOUT_MS = 10_000;

async function probe(backend: ModelBackend, timeoutMs: number): Promise<AiBackendHealthStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      backend.health(),
      new Promise<AiBackendHealthStatus>((resolve) => {
        timer = setTimeout(() => resolve("unhealthy"), timeoutMs);
      }),
    ]);
  } catch {
    return "unhealthy";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runAiBackendHealthSweep(deps: {
  readonly backends: readonly ModelBackend[];
  /** The PLATFORM-pooled client (column UPDATE grant on ai_model_backend). */
  readonly platformDb: DbClient;
  readonly timeoutMs?: number;
}): Promise<
  ReadonlyArray<{ readonly backendKey: string; readonly status: AiBackendHealthStatus }>
> {
  const results: Array<{ backendKey: string; status: AiBackendHealthStatus }> = [];
  for (const backend of deps.backends) {
    const status = await probe(backend, deps.timeoutMs ?? PROBE_TIMEOUT_MS);
    await deps.platformDb
      .update(schema.aiModelBackend)
      .set({ lastHealthStatus: status, lastHealthCheckAt: new Date() })
      .where(eq(schema.aiModelBackend.backendKey, backend.backendKey));
    results.push({ backendKey: backend.backendKey, status });
  }
  return results;
}

/** Start the sweep (immediately, then every `intervalMs`). Returns a stop function. */
export function startAiBackendHealthSweep(deps: {
  readonly backends: readonly ModelBackend[];
  readonly platformDb: DbClient;
  readonly intervalMs?: number;
  readonly log: (msg: string, detail?: Record<string, unknown>) => void;
}): () => void {
  if (deps.backends.length === 0) return () => {};
  const tick = () =>
    runAiBackendHealthSweep(deps).then(
      (r) => deps.log("M32 backend health sweep", { results: r }),
      (err: unknown) =>
        deps.log("M32 backend health sweep failed", {
          error: err instanceof Error ? err.name : "error",
        }),
    );
  void tick();
  const handle = setInterval(() => void tick(), deps.intervalMs ?? 60_000);
  handle.unref?.();
  return () => clearInterval(handle);
}
