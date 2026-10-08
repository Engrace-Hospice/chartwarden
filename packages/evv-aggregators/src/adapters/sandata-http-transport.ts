// @wardenx/evv-aggregators — config-driven HTTPS Sandata transport (GAP-028).
//
// Binds the `SandataTransport` port to a real HTTP endpoint chosen by configuration (the composition root passes
// `SANDATA_API_BASE_URL`; absent => the fail-closed deny transport stays bound). Credentials come from the
// per-(provider, state) `AggregatorCredentialStore` as `secrets.username` / `secrets.password` (HTTP Basic).
//
// VENDOR CONTRACT IS UNVERIFIED: the paths (`/submissions`, `/submissions/{id}`), the Basic auth scheme and the
// response field names below are this repo's working assumption and have NOT been exercised against a Sandata
// sandbox. Treat the first sandbox run as the acceptance test; only this file changes when the contract differs
// (§8.5). It fails closed: any non-2xx/network error is a `transport_failure` or a `rejected` (4xx), never an
// implied acceptance, and a missing credential throws before any request is made.
import type {
  AggregatorCredentials,
  AggregatorPollResult,
  AggregatorSubmitResult,
} from "../interface";
import type { Clock, SandataTransport } from "./sandata-adapter";

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface HttpSandataTransportOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly pollDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_CLIENT_ERROR_MAX = 499;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_REQUEST_TIMEOUT = 408;

function basicAuth(credentials: AggregatorCredentials): string {
  const { username, password } = credentials.secrets as Record<string, string | undefined>;
  if (!username || !password) {
    throw new Error("sandata: credentials must carry secrets.username and secrets.password");
  }
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

const inRange = (status: number, min: number, max: number): boolean =>
  status >= min && status <= max;

/** True when a 4xx is the vendor telling us to retry later rather than a content rejection. */
const isRetryableClientError = (status: number): boolean =>
  status === HTTP_TOO_MANY_REQUESTS || status === HTTP_REQUEST_TIMEOUT;

export function createHttpSandataTransport(opts: HttpSandataTransportOptions): SandataTransport {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  if (!/^https:\/\//.test(baseUrl)) {
    throw new Error("sandata: SANDATA_API_BASE_URL must be an https:// URL");
  }
  const clock = opts.clock ?? (() => new Date());
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const pollDelayMs = opts.pollDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const later = (ms: number): string => new Date(clock().getTime() + ms).toISOString();

  async function call(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> } | null> {
    try {
      const res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: { accept: "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const parsed = await res.json().catch(() => ({}));
      return { status: res.status, body: asRecord(parsed) };
    } catch {
      return null;
    }
  }

  return {
    async post({ body, idempotencyKey, credentials }): Promise<AggregatorSubmitResult> {
      const authorization = basicAuth(credentials);
      const res = await call(
        "POST",
        "/submissions",
        { authorization, "content-type": "application/json", "idempotency-key": idempotencyKey },
        body,
      );
      if (res === null || res.status >= 500 || isRetryableClientError(res.status)) {
        return { result: "transport_failure", nextRetryAt: later(retryDelayMs) };
      }
      const transactionId = str(res.body.transactionId, "");
      if (inRange(res.status, HTTP_OK_MIN, HTTP_OK_MAX)) {
        if (transactionId === "") {
          return { result: "transport_failure", nextRetryAt: later(retryDelayMs) };
        }
        return res.body.status === "accepted"
          ? { result: "accepted", transactionId, acceptedAt: clock().toISOString() }
          : { result: "pending_async", transactionId, nextPollAt: later(pollDelayMs) };
      }
      if (inRange(res.status, HTTP_CLIENT_ERROR_MIN, HTTP_CLIENT_ERROR_MAX)) {
        return {
          result: "rejected",
          rejectionCode: str(res.body.code, `HTTP_${res.status}`),
          rejectionReason: str(res.body.message, "the aggregator rejected the submission"),
          transactionId: transactionId === "" ? null : transactionId,
        };
      }
      return { result: "transport_failure", nextRetryAt: later(retryDelayMs) };
    },

    async pollStatus({ transactionId, credentials }): Promise<AggregatorPollResult> {
      const authorization = basicAuth(credentials);
      const res = await call("GET", `/submissions/${encodeURIComponent(transactionId)}`, {
        authorization,
      });
      const pending: AggregatorPollResult = {
        result: "still_pending",
        nextPollAt: later(pollDelayMs),
      };
      if (res === null || !inRange(res.status, HTTP_OK_MIN, HTTP_OK_MAX)) return pending;
      if (res.body.status === "accepted") {
        return { result: "accepted", acceptedAt: clock().toISOString() };
      }
      if (res.body.status === "rejected") {
        return {
          result: "rejected",
          rejectionCode: str(res.body.code, "REJECTED"),
          rejectionReason: str(res.body.message, "the aggregator rejected the submission"),
        };
      }
      return pending;
    },

    async ping(): Promise<boolean> {
      const res = await call("GET", "/health", {});
      return res !== null && inRange(res.status, HTTP_OK_MIN, HTTP_OK_MAX);
    },
  };
}
