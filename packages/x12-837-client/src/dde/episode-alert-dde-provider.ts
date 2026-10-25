// @chartwarden/x12-837-client — the Episode Alert DdeAccessProvider SKELETON (#759, ADR-0103). Built to the port; every
// vendor-specific fact lives in ./episode-alert-dde-wire and is UNVERIFIED, so this adapter cannot be bound yet:
// `createEpisodeAlertDdeProviderFromEnv` throws while the wire is unverified, which keeps `DDE_PROVIDER=episode_alert`
// refusing to start the platform. What is generic and safe to write before the documentation arrives is here: the
// credential and base URL from the environment (no guessed default), the HTTP plumbing (timeout, no redirects, bounded
// body), and the mapping of HTTP statuses onto the port's error codes. Nothing from a request body (the beneficiary) or a
// response body ever reaches a result, reason or log.
import { type X12WorkerResult, degraded } from "../types";
import {
  EA_DDE_WIRE,
  type EpisodeAlertDdeWire,
  WIRE_UNVERIFIED,
  type WireRequest,
  type WireResult,
} from "./episode-alert-dde-wire";
import {
  DDE,
  type DdeAccessProvider,
  type DdeContext,
  type DdeOperation,
  type DdeOperationStatus,
  type DdeOutcome,
  type DdeReceipt,
} from "./types";
import type { Page } from "../clearinghouse/types";

export const EPISODE_ALERT_DDE_API_KEY_ENV = "EPISODE_ALERT_DDE_API_KEY";
export const EPISODE_ALERT_DDE_BASE_URL_ENV = "EPISODE_ALERT_DDE_BASE_URL";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1_000_000;
const NOT_PROVISIONED_STATUSES: ReadonlySet<number> = new Set([401, 402, 403]);
const REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 404, 422]);
const CONFLICT_STATUS = 409;

type EnvMap = Readonly<Record<string, string | undefined>>;

export interface EpisodeAlertDdeOptions {
  /** The platform credential. Never logged, never returned. */
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly wire?: EpisodeAlertDdeWire;
  readonly fetch?: typeof fetch;
  /** Lets `usage: "test"` through. The vendor's sandbox is unknown, so only contract tests may set this. */
  readonly allowTestUsage?: boolean;
}

export class EpisodeAlertDdeProvider implements DdeAccessProvider {
  readonly vendor = "episode_alert" as const;
  private readonly wire: EpisodeAlertDdeWire;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: EpisodeAlertDdeOptions) {
    this.wire = options.wire ?? EA_DDE_WIRE;
    this.doFetch = options.fetch ?? fetch;
  }

  private refuseTest<T>(ctx: DdeContext): X12WorkerResult<T> | null {
    return ctx.usage === "test" && !this.options.allowTestUsage
      ? degraded<T>(
          DDE.NOT_PROVISIONED,
          "no vendor test mode is recorded for this provider; usage test is refused",
        )
      : null;
  }

  private async call<T>(
    request: WireResult<WireRequest>,
    parse: (body: string) => WireResult<T>,
  ): Promise<X12WorkerResult<T>> {
    if (!request.ok) return wireFailure(request.code);
    const sent = await this.send(request.value);
    if (!sent.ok) return sent;
    const parsed = parse(sent.data);
    return parsed.ok ? { ok: true, data: parsed.value } : wireFailure(parsed.code);
  }

  private async send(req: WireRequest): Promise<X12WorkerResult<string>> {
    const base = new URL(`${this.options.baseUrl.replace(/\/+$/, "")}/`);
    let url: URL;
    try {
      url = new URL(req.path, base);
    } catch {
      return degraded(DDE.INVALID_REQUEST, "the request path is not usable");
    }
    // A path may never move the call (and the credential and body with it) to another origin or above the API root.
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      return degraded(DDE.INVALID_REQUEST, "the request path is not usable");
    }
    try {
      const response = await this.doFetch(url, {
        method: req.method,
        headers: req.headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        // The body of a failure is never read, kept or echoed.
        await response.body?.cancel().catch(() => undefined);
        return statusFailure(response.status);
      }
      const text = await readBounded(response);
      return text === null
        ? degraded(DDE.UNAVAILABLE, "the provider answer is too large")
        : { ok: true, data: text };
    } catch {
      // Network error, timeout or a refused redirect: the body and the error text are never echoed.
      return degraded(DDE.UNAVAILABLE, "the provider could not be reached");
    }
  }

  submitOperation(ctx: DdeContext, op: DdeOperation): Promise<X12WorkerResult<DdeReceipt>> {
    const refused = this.refuseTest<DdeReceipt>(ctx);
    if (refused) return Promise.resolve(refused);
    return this.call(this.wire.buildSubmit(this.options.apiKey, ctx, op), (body) =>
      this.wire.parseReceipt(body, op),
    );
  }

  fetchOutcomes(
    ctx: DdeContext,
    cursor: string | null,
  ): Promise<X12WorkerResult<Page<DdeOutcome>>> {
    const refused = this.refuseTest<Page<DdeOutcome>>(ctx);
    if (refused) return Promise.resolve(refused);
    return this.call(this.wire.buildChangeReport(this.options.apiKey, ctx, cursor), (body) =>
      this.wire.parseChangeReport(body),
    );
  }

  fetchOperationStatus(
    ctx: DdeContext,
    providerReference: string,
  ): Promise<X12WorkerResult<DdeOperationStatus>> {
    const refused = this.refuseTest<DdeOperationStatus>(ctx);
    if (refused) return Promise.resolve(refused);
    return this.call(this.wire.buildStatus(this.options.apiKey, ctx, providerReference), (body) =>
      this.wire.parseStatus(body, providerReference),
    );
  }
}

/** The body as text, or null once it passes MAX_BODY_BYTES (counted in bytes, and the stream is stopped there). */
async function readBounded(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function wireFailure<T>(code: string): X12WorkerResult<T> {
  // An unverified wire is the unbound case: nothing was sent. An unreadable answer is a vendor change we must not guess at.
  return code === WIRE_UNVERIFIED
    ? degraded<T>(DDE.NOT_WIRED, "the Episode Alert DDE wire format is not verified; key manually")
    : degraded<T>(DDE.UNAVAILABLE, "the provider answer could not be read");
}

function statusFailure<T>(status: number): X12WorkerResult<T> {
  if (NOT_PROVISIONED_STATUSES.has(status)) {
    return degraded<T>(DDE.NOT_PROVISIONED, "the provider account is not provisioned for this");
  }
  if (status === CONFLICT_STATUS) {
    return degraded<T>(DDE.IDEMPOTENCY_CONFLICT, "the provider reports a conflicting operation");
  }
  if (REFUSED_STATUSES.has(status)) {
    return degraded<T>(DDE.INVALID_REQUEST, "the provider refused the request");
  }
  return degraded<T>(DDE.UNAVAILABLE, "the provider is unavailable");
}

/** The credential and the beneficiary travel to this URL: HTTPS only, no embedded credentials. */
export function assertSafeBaseUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${EPISODE_ALERT_DDE_BASE_URL_ENV} is not a URL`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error(`${EPISODE_ALERT_DDE_BASE_URL_ENV} must be an https URL without credentials`);
  }
}

/**
 * Builds the provider from the platform environment. THROWS while the wire is unverified, so naming `episode_alert`
 * in `DDE_PROVIDER` refuses to boot instead of silently behaving as manual.
 */
export function createEpisodeAlertDdeProviderFromEnv(
  env: EnvMap,
  wire: EpisodeAlertDdeWire = EA_DDE_WIRE,
): EpisodeAlertDdeProvider {
  if (!wire.verified) {
    throw new Error(
      "Episode Alert DDE cannot be bound: its wire format is unverified (no vendor documentation yet; see issue #759 and ADR-0103 D7)",
    );
  }
  const apiKey = env[EPISODE_ALERT_DDE_API_KEY_ENV]?.trim();
  if (!apiKey)
    throw new Error(`${EPISODE_ALERT_DDE_API_KEY_ENV} is required for Episode Alert DDE`);
  const baseUrl = env[EPISODE_ALERT_DDE_BASE_URL_ENV]?.trim();
  if (!baseUrl)
    throw new Error(`${EPISODE_ALERT_DDE_BASE_URL_ENV} is required for Episode Alert DDE`);
  assertSafeBaseUrl(baseUrl);
  return new EpisodeAlertDdeProvider({ apiKey, baseUrl, wire });
}
