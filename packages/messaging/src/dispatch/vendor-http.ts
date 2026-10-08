// @wardenx/messaging — shared HTTP plumbing for the M36 vendor transports (GAP-062).
//
// One bounded request, classified into the {@link TransportError} contract the delivery sweep already
// understands: 429 / 5xx / network / timeout are RETRYABLE (the sweep owns retry + backoff, spec §4.4.1 — so this
// layer never retries on its own), any other 4xx is TERMINAL (bad credentials, unverified sender, invalid
// number). Reasons are stable, PHI-free codes: they carry the HTTP status and the vendor's numeric error code,
// never a destination, a body or a credential.
import { TransportError } from "./transports";

/** `fetch`, injectable so tests drive the adapters without a network. */
export type VendorFetch = (url: string, init: RequestInit) => Promise<Response>;

export const VENDOR_DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_MS = 60_000;

export interface VendorResponse {
  readonly status: number;
  readonly headers: Headers;
  /** Parsed JSON body, or `undefined` when the body was empty / not JSON. */
  readonly json: Record<string, unknown> | undefined;
}

function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

async function readJson(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = await res.json();
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function vendorCode(json: Record<string, unknown> | undefined): string {
  // Twilio: `code`; Postmark: `ErrorCode`. Numeric only, so no free text can leak into the reason.
  const raw = json?.code ?? json?.ErrorCode;
  return typeof raw === "number" && Number.isFinite(raw) ? `:${raw}` : "";
}

/** POST once; resolve on 2xx, otherwise throw a classified {@link TransportError}. */
export async function postToVendor(input: {
  readonly vendor: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
  readonly fetch: VendorFetch;
  readonly timeoutMs?: number;
}): Promise<VendorResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? VENDOR_DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await input.fetch(input.url, {
      method: "POST",
      headers: input.headers,
      body: input.body as unknown as RequestInit["body"],
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new TransportError(`${input.vendor}_${aborted ? "timeout" : "unreachable"}`, true);
  } finally {
    clearTimeout(timer);
  }
  const json = await readJson(res);
  if (res.status >= 200 && res.status < 300)
    return { status: res.status, headers: res.headers, json };
  if (res.status === 429) {
    throw new TransportError(
      `${input.vendor}_rate_limited`,
      true,
      retryAfterMs(res.headers.get("retry-after")),
    );
  }
  if (res.status >= 500)
    throw new TransportError(`${input.vendor}_unavailable:${res.status}`, true);
  throw new TransportError(`${input.vendor}_rejected:${res.status}${vendorCode(json)}`, false);
}
