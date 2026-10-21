// apps/backend/src/modules/29-external-interfaces/nppes — the NPPES public-API client (M29-T07, §2.2, D10).
// A thin, typed wrapper over the CMS NPI Registry public endpoint (no credentials, no BAA — public
// directory). There is NO vendor SDK here (just an HTTP GET), so the §8.5 adapter-confinement mandate does
// not apply; the ONE IO edge (`fetch`) is injected so the client is unit-testable without the network.
//
// Behaviour: Luhn-invalid NPIs short-circuit as `invalid_format` (no request spent); 429 / 5xx are retried
// with exponential backoff up to `maxRetries`; the rate limiter caps request cadence. Every request carries
// the CMS-requested `User-Agent` courtesy header.
import type { Npi } from "@chartwarden/types";
import { isValidNpi } from "./npi-validate";
import { RateLimiter } from "./rate-limiter";
import {
  type NppesApiResponse,
  type NppesFetchResult,
  classifyNppesResponse,
} from "./response-projection";

/** The injected HTTP surface (a subset of the DOM/undici `fetch`). */
export type HttpFetch = (url: string, init: HttpFetchInit) => Promise<HttpFetchResponse>;

export interface HttpFetchInit {
  readonly headers: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface HttpFetchResponse {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export interface NppesClientConfig {
  readonly fetch: HttpFetch;
  readonly baseUrl?: string; // default 'https://npiregistry.cms.hhs.gov/api/'
  readonly apiVersion?: string; // default '2.1'
  readonly userAgent?: string; // default 'WardenX/Phase1 (+https://wardenx.com/contact)'
  readonly requestsPerSecond?: number; // default 4
  readonly maxRetries?: number; // default 3 for 429 / 5xx
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Structured logger (level, event, fields), mirroring the M29 supervisor's port. */
  readonly log?: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void;
}

/** A retryable transport failure (429 / 5xx) — surfaces `status` so backoff can log it. */
export class RetryableHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RetryableHttpError";
  }
}

const DEFAULT_BASE_URL = "https://npiregistry.cms.hhs.gov/api/";
const DEFAULT_USER_AGENT = "WardenX/Phase1 (+https://wardenx.com/contact)";

export class NppesClient {
  private readonly fetch: HttpFetch;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly rateLimiter: RateLimiter;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (
    level: "info" | "warn",
    event: string,
    fields: Record<string, unknown>,
  ) => void;

  constructor(config: NppesClientConfig) {
    this.fetch = config.fetch;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.apiVersion = config.apiVersion ?? "2.1";
    this.userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    this.maxRetries = config.maxRetries ?? 3;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = config.log ?? (() => undefined);
    this.rateLimiter = new RateLimiter({
      rps: config.requestsPerSecond ?? 4,
      now: config.now,
      sleep: config.sleep,
    });
  }

  /** Fetch + classify one NPI. Throws only when retries are exhausted on a retryable transport error. */
  async fetchByNpi(npi: Npi): Promise<NppesFetchResult> {
    if (!isValidNpi(npi)) {
      this.log("warn", "nppes.fetch.invalid_format", { npi });
      return { kind: "invalid_format", npi };
    }

    await this.rateLimiter.acquire();

    const url = `${this.baseUrl}?version=${this.apiVersion}&number=${npi}`;
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.doFetch(url);
        return classifyNppesResponse(npi, response);
      } catch (err) {
        lastErr = err as Error;
        if (!(err instanceof RetryableHttpError) || attempt === this.maxRetries) {
          throw err;
        }
        // Deterministic exponential backoff (no jitter — the injected sleeper is faked under test).
        const backoffMs = 500 * 2 ** attempt;
        this.log("info", "nppes.fetch.retryable_backoff", {
          npi,
          attempt,
          backoffMs,
          status: err.status,
        });
        await this.sleep(backoffMs);
      }
    }

    throw lastErr ?? new Error("nppes_fetch_unknown_failure");
  }

  private async doFetch(url: string): Promise<NppesApiResponse> {
    const res = await this.fetch(url, {
      headers: { "User-Agent": this.userAgent, Accept: "application/json" },
    });

    if (res.status === 429) throw new RetryableHttpError(429, "rate_limited");
    if (res.status >= 500) throw new RetryableHttpError(res.status, "server_error");
    // The API answers unknown NPIs with 200 + result_count 0, so a 404 is an unexpected upstream fault.
    if (res.status === 404) throw new Error("nppes_unexpected_404");
    if (!res.ok) throw new Error(`nppes_http_${res.status}`);

    return (await res.json()) as NppesApiResponse;
  }
}

/** The narrow fetch surface the orchestrator depends on (so a test can stub the client whole). */
export interface NppesFetchPort {
  fetchByNpi(npi: Npi): Promise<NppesFetchResult>;
}
