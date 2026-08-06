// apps/backend/src/modules/25-remittance/ingest/x12-worker-transport.ts — WX-PR-012 the REAL
// `X12835HttpPort` transport (the M23 `launch-gateway.ts` `fetchHttp`/`m23LaunchGatewayConfigFromEnv`
// precedent). `@wardenx/x12-835-client` deliberately holds no network code (architecture §25.14 — the
// composition root injects a live port); this is that injection. No Python x12-worker sidecar is
// deployed anywhere in this repo/environment today, so `m25X12WorkerPortFromEnv` returns `undefined`
// (→ `createX12835Client()`'s fail-closed `NO_X12_835_PORT` default) absent configuration — the SAME
// graceful, non-throwing "unconfigured" posture `m23LaunchGatewayConfigFromEnv` uses, not a hard
// requirement. Once M25_X12_WORKER_URL is set, this transport genuinely calls out over HTTP.
import type {
  X12835HttpPort,
  X12835HttpRequest,
  X12835HttpResponse,
} from "@wardenx/x12-835-client";

export interface M25X12WorkerConfig {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly timeoutMs: number;
}

/** Read `M25_X12_WORKER_URL`/`M25_X12_WORKER_TOKEN`/`M25_X12_WORKER_TIMEOUT_MS`; `null` when unset. */
export function m25X12WorkerConfigFromEnv(env: NodeJS.ProcessEnv): M25X12WorkerConfig | null {
  const baseUrl = env.M25_X12_WORKER_URL?.trim();
  if (!baseUrl) return null;
  const bearerToken = env.M25_X12_WORKER_TOKEN?.trim();
  const timeout = Number(env.M25_X12_WORKER_TIMEOUT_MS ?? "30000");
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
    throw new Error("M25_X12_WORKER_TIMEOUT_MS must be an integer from 1000 through 120000");
  }
  return { baseUrl, ...(bearerToken ? { bearerToken } : {}), timeoutMs: timeout };
}

/** Build a real `fetch`-backed {@link X12835HttpPort} over `config`. */
export function createFetchX12835HttpPort(config: M25X12WorkerConfig): X12835HttpPort {
  return {
    async request(req: X12835HttpRequest): Promise<X12835HttpResponse> {
      const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${req.path}`, {
        method: req.method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(config.bearerToken ? { authorization: `Bearer ${config.bearerToken}` } : {}),
        },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // A malformed response is rejected by @wardenx/x12-835-client's own mapper (degraded envelope).
      }
      return { status: response.status, body };
    },
  };
}

/** `undefined` (→ the fail-closed default) unless `M25_X12_WORKER_URL` is configured. */
export function m25X12WorkerPortFromEnv(env: NodeJS.ProcessEnv): X12835HttpPort | undefined {
  const config = m25X12WorkerConfigFromEnv(env);
  return config ? createFetchX12835HttpPort(config) : undefined;
}
