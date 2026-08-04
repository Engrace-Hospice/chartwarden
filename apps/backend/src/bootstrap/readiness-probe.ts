// apps/backend/src/bootstrap/readiness-probe.ts — the real `/ready` probe (TASK-040B,
// production-readiness audit 2026-08-03, OPS-004).
//
// Until this file, `buildServer()` never received a `readinessProbe`, so production always ran
// `defaultReadinessProbe` (bootstrap/routes/health.ts) — a hard-coded all-"ok" stub. `/ready` could
// not flip to 503 no matter what was actually down. This factory takes the composition root's
// dependency PINGS as plain injected functions (never a live client import — M1 owns no client
// dependency) and turns them into the `ReadinessChecks` shape `registerHealthRoutes` already knows
// how to serve as 200/503.
//
// Each check is a THUNK, not a live handle, so the composition root can hand it a value that isn't
// constructed yet at the time `buildReadinessProbe()` runs (the outbox dispatcher instance, in
// particular, is built after `buildServer()` returns — see index.ts's `outboxDispatcherRef`
// forward-reference). Omitting a check reports "ok": no configured dependency means nothing to be
// unready about (mirrors today's boot posture — a slice/test boot with no DB/Redis still serves).
import type { ReadinessChecks, ReadinessProbe } from "./routes/health";

export interface ReadinessProbeDeps {
  /** Cheap DB reachability probe, e.g. a `SELECT 1`; omitted when no DB is configured. */
  readonly pingDb?: () => Promise<void>;
  /** Redis/Valkey PING; omitted when `REDIS_URL` is unset (no BullMQ workers run either). */
  readonly pingRedis?: () => Promise<void>;
  /** Current outbox `pending`-row backlog depth across active orgs; omitted when the dispatcher isn't running. */
  readonly outboxPendingDepth?: () => Promise<number>;
  /** Depth at/above which `outbox` reports "fail" — a growing backlog signals a stuck dispatcher. */
  readonly outboxDepthThreshold?: number;
  /** Per-check timeout; a hung probe (wedged pool, stalled reconnect) reports "fail" rather than hanging `/ready`. */
  readonly timeoutMs?: number;
  /** Log sink for probe failures (default `console.warn`) — so a flapping dependency leaves a trail. */
  readonly log?: (message: string) => void;
}

const DEFAULT_OUTBOX_DEPTH_THRESHOLD = 500;
const DEFAULT_TIMEOUT_MS = 3_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function checkReachable(
  probe: (() => Promise<void>) | undefined,
  name: string,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<"ok" | "fail"> {
  if (!probe) return "ok";
  try {
    await withTimeout(probe(), timeoutMs, name);
    return "ok";
  } catch (err) {
    log(`⚠️  readiness probe: ${name} unreachable — ${err instanceof Error ? err.message : String(err)}`);
    return "fail";
  }
}

async function checkOutboxDepth(
  depthFn: (() => Promise<number>) | undefined,
  threshold: number,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<"ok" | "fail"> {
  if (!depthFn) return "ok";
  try {
    const depth = await withTimeout(depthFn(), timeoutMs, "outbox depth");
    if (depth >= threshold) {
      log(`⚠️  readiness probe: outbox pending depth ${depth} >= threshold ${threshold}`);
      return "fail";
    }
    return "ok";
  } catch (err) {
    log(`⚠️  readiness probe: outbox depth check failed — ${err instanceof Error ? err.message : String(err)}`);
    return "fail";
  }
}

/** Build the real `ReadinessProbe` from injected dependency pings (pure — no client construction here). */
export function buildReadinessProbe(deps: ReadinessProbeDeps): ReadinessProbe {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const threshold = deps.outboxDepthThreshold ?? DEFAULT_OUTBOX_DEPTH_THRESHOLD;
  return async (): Promise<ReadinessChecks> => {
    const [db, valkey, outbox] = await Promise.all([
      checkReachable(deps.pingDb, "db", timeoutMs, log),
      checkReachable(deps.pingRedis, "valkey", timeoutMs, log),
      checkOutboxDepth(deps.outboxPendingDepth, threshold, timeoutMs, log),
    ]);
    // MinIO is optional infra (bootstrap/env.ts does not require MINIO_* in production; the M22
    // object store falls back to a REFUSING port, not a silent no-op, when unconfigured) — TASK-040B
    // scopes DB/Redis/outbox only, so this stays the historical "ok" default.
    return { db, valkey, minio: "ok", outbox };
  };
}
