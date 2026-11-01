import type { RustCallResult, RustClient } from "./client";
// apps/backend/src/bootstrap/rust-bridge/forwarder.ts — CW-RUST-M02 P1: shadow or serve one route through Rust.
//
// Runs INSIDE the route handler, i.e. strictly after upstream's authenticate hook and the route's preHandlers
// (requireSession), so Rust only ever sees requests Bun has already authenticated (spec §"HTTP behaviour").
//
//   shadow: Bun answers exactly as today. After the response has been sent, the same request goes to Rust in the
//           background (≤ 8 in flight, extra calls DROPPED and counted, 300 ms abort). On a difference Bun resolves
//           once more with an UNCACHED resolver: equal now → `explained:stale-cache`, otherwise `unexplained`.
//   serve:  Rust answers if and only if it returns a valid 200 body; on ANY other outcome Bun's own handler answers
//           and `fallback:<reason>` is counted (spec §Fallback). A Rust error never reaches a client.
//
// Logs carry ids, outcome, reason and counts. Never a permission key, never the assertion (spec §Logging).
import { RUST_BRIDGE_ROUTES, type RustBridgeConfig } from "./config";
import { type AssertionSigner, CANONICAL_UUID_RE, SWEEP_CLASS } from "./signer";

export interface BridgedActor {
  readonly userId: string;
  readonly organizationId: string;
  readonly sessionId: string;
  readonly sessionClass: string;
  readonly requestId: string;
}

export interface PermissionsBody {
  permissions: string[];
}

export interface MePermissionsBridgeInput {
  readonly actor: BridgedActor;
  /** Upstream's own handler, unchanged. */
  readonly bun: () => Promise<PermissionsBody>;
  /** The same resolution with no cache, used only to explain a shadow difference. */
  readonly fresh: () => Promise<PermissionsBody>;
  /** Runs `cb` once the client response has been fully sent. */
  readonly afterResponse: (cb: () => void) => void;
}

export interface MePermissionsBridge {
  handle(input: MePermissionsBridgeInput): Promise<PermissionsBody>;
}

export interface BridgeLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export const SHADOW_MAX_IN_FLIGHT = 8;
/** Serve mode: Rust calls in flight before further requests go straight to Bun (no unbounded socket pile-up). */
export const SERVE_MAX_IN_FLIGHT = 32;
/** Serve mode: consecutive failures that open the circuit, and how long it stays open (Bun answers meanwhile). */
export const CIRCUIT_FAILURES_TO_OPEN = 5;
export const CIRCUIT_OPEN_MS = 30_000;
/** How often the counters are logged (P2 evidence; there is no metrics endpoint for the bridge). */
export const STATS_LOG_INTERVAL_MS = 10 * 60_000;
/** Shadow: the uncached Bun re-check of a difference gets this long, so a stuck query cannot hold a slot forever. */
export const SHADOW_FRESH_TIMEOUT_MS = 2_000;

class FreshTimeout extends Error {
  override name = "FreshTimeout";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      fn();
    };
    const t = setTimeout(() => settle(() => reject(new FreshTimeout())), ms);
    t.unref?.();
    p.then(
      (v) => settle(() => resolve(v)),
      (e) => settle(() => reject(e)),
    );
  });
}

export type FallbackReason =
  | "connect"
  | "timeout"
  | "bad_json"
  | "status"
  | "content_type"
  | "schema"
  | "sign"
  | "busy"
  | "circuit_open";

/** Exactly `{ permissions: string[] }` with unique strings; anything else is refused. */
export function validPermissionsBody(
  r: RustCallResult,
): { body: PermissionsBody } | { reason: FallbackReason } {
  if (!r.ok) return { reason: r.reason };
  if (r.status !== 200) return { reason: "status" };
  if (!r.contentType || !/^application\/json(\s*;|$)/i.test(r.contentType))
    return { reason: "content_type" };
  const b = r.body;
  if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).length !== 1)
    return { reason: "schema" };
  const p = (b as { permissions?: unknown }).permissions;
  if (!Array.isArray(p) || !p.every((x) => typeof x === "string") || new Set(p).size !== p.length) {
    return { reason: "schema" };
  }
  return { body: { permissions: p as string[] } };
}

function setDiff(a: readonly string[], b: readonly string[]): { onlyA: number; onlyB: number } {
  const sa = new Set(a);
  const sb = new Set(b);
  let onlyA = 0;
  let onlyB = 0;
  for (const x of sa) if (!sb.has(x)) onlyA++;
  for (const x of sb) if (!sa.has(x)) onlyB++;
  return { onlyA, onlyB };
}

export interface BridgeStats {
  match: number;
  staleCache: number;
  unexplained: number;
  rustError: number;
  dropped: number;
  skipped: number;
  served: number;
  fallback: Record<string, number>;
}

export function createMePermissionsBridge(deps: {
  readonly config: RustBridgeConfig;
  readonly signer: AssertionSigner;
  readonly client: RustClient;
  readonly logger: BridgeLogger;
  /** Injected clock (tests). */
  readonly nowMs?: () => number;
  /** Shadow re-check limit (default SHADOW_FRESH_TIMEOUT_MS). */
  readonly freshTimeoutMs?: number;
}): MePermissionsBridge & { stats(): BridgeStats; inFlight(): number; close(): void } {
  const nowMs = deps.nowMs ?? Date.now;
  let consecutiveFailures = 0;
  let circuitOpenUntil = 0;
  const route = RUST_BRIDGE_ROUTES["me-permissions"];
  const enabled = deps.config.routes.has("me-permissions");
  const mode = deps.config.mode;
  let inFlight = 0;
  const stats: BridgeStats = {
    match: 0,
    staleCache: 0,
    unexplained: 0,
    rustError: 0,
    dropped: 0,
    skipped: 0,
    served: 0,
    fallback: {},
  };
  const ids = (a: BridgedActor) => ({
    rid: a.requestId,
    user_id: a.userId,
    org_id: a.organizationId,
  });
  const base = { route: route.path, mode };
  // Periodic counters: the only P2 evidence channel besides per-request lines. Counts only, never keys.
  const statsTimer = setInterval(() => {
    if (enabled)
      deps.logger.info(
        { ...base, outcome: "stats", ...structuredClone(stats) },
        "rust bridge stats",
      );
  }, STATS_LOG_INTERVAL_MS);
  statsTimer.unref?.();

  function forwardable(a: BridgedActor): boolean {
    // A machine principal (e.g. "system") or a half-bound session is served by Bun, never forwarded. The sweep's
    // session class is reserved for the sweep: a request carrying it is never signed as one.
    return (
      a.sessionClass !== SWEEP_CLASS &&
      CANONICAL_UUID_RE.test(a.userId) &&
      CANONICAL_UUID_RE.test(a.organizationId) &&
      a.sessionId !== "" &&
      a.sessionClass !== "" &&
      a.requestId !== ""
    );
  }

  async function callRust(
    a: BridgedActor,
  ): Promise<{ body: PermissionsBody } | { reason: FallbackReason }> {
    let assertion: string;
    try {
      assertion = deps.signer.sign({ ...a, method: route.method, path: route.path });
    } catch {
      return { reason: "sign" };
    }
    try {
      return validPermissionsBody(await deps.client.get(route.path, assertion));
    } catch {
      // The client contract is "never throws"; an implementation that does must still never reach a client.
      return { reason: "connect" };
    }
  }

  async function shadow(input: MePermissionsBridgeInput, bunBody: PermissionsBody): Promise<void> {
    if (inFlight >= SHADOW_MAX_IN_FLIGHT) {
      stats.dropped++;
      deps.logger.warn({ ...base, ...ids(input.actor), outcome: "dropped" }, "rust shadow dropped");
      return;
    }
    inFlight++;
    const started = performance.now();
    try {
      const r = await callRust(input.actor);
      if ("reason" in r) {
        stats.rustError++;
        deps.logger.warn(
          { ...base, ...ids(input.actor), outcome: "rust_error", reason: r.reason },
          "rust shadow error",
        );
        return;
      }
      const d = setDiff(bunBody.permissions, r.body.permissions);
      if (d.onlyA === 0 && d.onlyB === 0) {
        stats.match++;
        deps.logger.info(
          {
            ...base,
            ...ids(input.actor),
            outcome: "match",
            count: r.body.permissions.length,
            latency_ms: performance.now() - started,
          },
          "rust shadow",
        );
        return;
      }
      const fresh = await withTimeout(
        input.fresh(),
        deps.freshTimeoutMs ?? SHADOW_FRESH_TIMEOUT_MS,
      );
      const f = setDiff(fresh.permissions, r.body.permissions);
      if (f.onlyA === 0 && f.onlyB === 0) {
        stats.staleCache++;
        deps.logger.info(
          {
            ...base,
            ...ids(input.actor),
            outcome: "explained:stale-cache",
            only_bun: d.onlyA,
            only_rust: d.onlyB,
          },
          "rust shadow",
        );
      } else {
        stats.unexplained++;
        deps.logger.warn(
          {
            ...base,
            ...ids(input.actor),
            outcome: "unexplained",
            only_bun: f.onlyA,
            only_rust: f.onlyB,
          },
          "rust shadow UNEXPLAINED difference",
        );
      }
    } catch (e) {
      // A timed-out re-check is an ERROR, never a classification: the difference stays unresolved, not explained.
      stats.rustError++;
      deps.logger.warn(
        {
          ...base,
          ...ids(input.actor),
          outcome: "rust_error",
          reason: e instanceof FreshTimeout ? "fresh_timeout" : "exception",
        },
        "rust shadow error",
      );
    } finally {
      inFlight--;
    }
  }

  return {
    async handle(input) {
      if (!enabled) return input.bun();
      if (!forwardable(input.actor)) {
        stats.skipped++;
        return input.bun();
      }
      if (mode === "shadow") {
        const body = await input.bun();
        input.afterResponse(() => {
          void shadow(input, body);
        });
        return body;
      }
      let r: Awaited<ReturnType<typeof callRust>>;
      if (nowMs() < circuitOpenUntil) {
        r = { reason: "circuit_open" };
      } else if (inFlight >= SERVE_MAX_IN_FLIGHT) {
        r = { reason: "busy" };
      } else {
        inFlight++;
        try {
          r = await callRust(input.actor);
        } finally {
          inFlight--;
        }
        if ("body" in r) {
          consecutiveFailures = 0;
          stats.served++;
          return r.body;
        }
        if (++consecutiveFailures >= CIRCUIT_FAILURES_TO_OPEN) {
          circuitOpenUntil = nowMs() + CIRCUIT_OPEN_MS;
          consecutiveFailures = 0;
          deps.logger.warn(
            { ...base, outcome: "circuit_open", open_ms: CIRCUIT_OPEN_MS },
            "rust serve circuit opened",
          );
        }
      }
      if (!("reason" in r)) return input.bun();
      stats.fallback[r.reason] = (stats.fallback[r.reason] ?? 0) + 1;
      deps.logger.warn(
        { ...base, ...ids(input.actor), outcome: `fallback:${r.reason}` },
        "rust serve fell back to bun",
      );
      return input.bun();
    },
    stats: () => structuredClone(stats),
    inFlight: () => inFlight,
    close: () => clearInterval(statsTimer),
  };
}
