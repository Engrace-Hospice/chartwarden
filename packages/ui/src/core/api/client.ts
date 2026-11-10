// @chartwarden/ui — typed REST API client (F0-T02, ADR-0032).
// Wraps openapi-fetch over the generated `paths` (from docs/api/openapi.json via
// `bun run client:gen`) and attaches the ChartWarden auth + correlation-id headers.
// Leaf-safe: depends only on `openapi-fetch`, the generated schema and this package's own Idempotency-Key middleware (which imports just
// ../ops-write/idempotency-key, a React-free file with no imports) — NO @chartwarden/* import, so `packages/ui` stays a leaf and the
// frontend never compile-imports the backend.
import createClient, { type Client, type ClientOptions, type Middleware } from "openapi-fetch";
import { MUTATING_METHODS, createIdempotencyKeys } from "./idempotency-middleware";
import type { paths } from "./schema";

/** The typed client: `client.GET("/api/v1/patients/{id}", { params: { path: { id } } })`. */
export type ApiClient = Client<paths>;

/** Each client's own Idempotency-Key table, reachable through {@link clearIdempotencyKeys} without widening the `ApiClient` type. */
const idempotencyTables = new WeakMap<object, () => void>();

/**
 * Forget every Idempotency-Key the client is holding for an unanswered write. Call it when the signed-in user changes WITHOUT a page
 * reload (a reload discards the table with the page; every sign-out in the three apps reloads except the portal onboarding "leave").
 * A 401 answer clears it on its own, so a session that expires needs no call.
 */
export function clearIdempotencyKeys(client: ApiClient): void {
  idempotencyTables.get(client)?.();
}

export interface ApiClientOptions {
  /** API origin. Default "" (same-origin — generated paths already carry `/api/v1`). */
  baseUrl?: string;
  /** Returns the bearer token to attach per request, or null/undefined to send none. */
  getAuthToken?: () => string | null | undefined;
  /** Per-request correlation id. Default `crypto.randomUUID()` when available. */
  correlationId?: () => string | undefined;
  /** Override fetch (tests / SSR). */
  fetch?: ClientOptions["fetch"];
  /**
   * Fired with the HTTP status and URL of every response the client observes (TASK-033). Leaf-safe:
   * the client has no router access, so it just reports the fact — the composition root decides what a
   * given status means (e.g. 401 → navigate to /expired, 503 → /maintenance).
   *
   * The URL is passed because a status alone is not always enough to decide (F-081): a 401 from the
   * step-up VERIFY route means "that factor did not verify", not "your session is gone", and the shell
   * has to be able to tell those apart.
   *
   * The `Response` is passed as a third argument for the rare caller that must read the body (ADR-0049: the
   * `error.code` of a tenant-host refusal). It is the live response: a reader MUST `clone()` it first.
   */
  onResponseStatus?: (status: number, url: string, response: Response) => void;
}

/**
 * GAP-002 — mark a request the USER did not cause (a timer-driven poll). The server still checks the
 * session's idle/absolute timeout on it but does not count it as activity, so an open tab polling the
 * inbox cannot keep an unattended workstation signed in past the 15-minute idle logoff.
 */
export const BACKGROUND_REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-chartwarden-background": "1",
});

function defaultCorrelationId(): string | undefined {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return undefined;
}

/** Read a single cookie's value by name (browser only — SSR/tests without `document` read nothing). */
function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

const CSRF_COOKIE_NAME = "chartwarden_csrf";
/** Per-tenant hosts (ADR-0049 D4) mint the host-only name instead; whichever the server set is the one present. */
const HOST_ONLY_CSRF_COOKIE_NAME = "__Host-chartwarden_csrf";

/**
 * Double-submit CSRF defense (WX-PR-017; backend half in
 * apps/backend/src/bootstrap/plugins/csrf.ts). The backend mints a non-httpOnly `chartwarden_csrf`
 * cookie on every response and, for a mutating request that also carries the ambient Better Auth
 * session cookie, requires this same value echoed back in `X-CSRF-Token` — a cross-site attacker
 * page can trigger the request (the session cookie rides along) but cannot read this origin's
 * cookie jar to forge the header. A caller-supplied header is never overwritten.
 */
const csrfToken: Middleware = {
  onRequest({ request }) {
    if (MUTATING_METHODS.has(request.method) && !request.headers.has("X-CSRF-Token")) {
      const token = readCookie(HOST_ONLY_CSRF_COOKIE_NAME) ?? readCookie(CSRF_COOKIE_NAME);
      if (token) request.headers.set("X-CSRF-Token", token);
    }
    return request;
  },
};

/** Build a typed API client with ChartWarden auth + correlation-id + idempotency-key middleware. */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const {
    baseUrl = "",
    getAuthToken,
    correlationId = defaultCorrelationId,
    fetch,
    onResponseStatus,
  } = options;
  const client = createClient<paths>({ baseUrl, ...(fetch ? { fetch } : {}) });

  const headers: Middleware = {
    onRequest({ request }) {
      const cid = correlationId();
      if (cid) request.headers.set("X-Correlation-Id", cid);
      const token = getAuthToken?.();
      if (token) request.headers.set("Authorization", `Bearer ${token}`);
      return request;
    },
  };
  client.use(headers);
  client.use(csrfToken);
  if (onResponseStatus) {
    client.use({
      onResponse({ response }) {
        // An observer is the app's own code: a bug in it must not fail a response that already came back, nor skip the idempotency
        // bookkeeping below (a cached 403 would then be replayed to the retry). It is reported, never swallowed.
        try {
          onResponseStatus(response.status, response.url, response);
        } catch (error) {
          globalThis.reportError?.(error);
        }
        return undefined;
      },
    });
  }
  // §4.1.1 — every mutating request carries an `Idempotency-Key`, so a retry after a request that got no answer replays instead of
  // double-executing, for every caller of this client with no per-screen code. The key is held per intent (method + URL + If-Match +
  // body): kept across a request that got no answer, a gateway page that never reached the app and an in-flight 409, renewed by any
  // other answer. A caller-supplied key (the kit's `sendWrite` / `useOpsWrite`) is never overwritten or tracked. Rules, bounds and
  // limits: ./idempotency-middleware.ts. Registered LAST on purpose: openapi-fetch runs `onResponse` in reverse registration order, so
  // this runs FIRST on every response, before any observer above can throw.
  // `If-Match` (§7.7 optimistic concurrency) is NOT auto-generated — the caller must read the row version first, so it is passed
  // explicitly per call via the typed `params.header["If-Match"]` option openapi-fetch derives from the enrichment's `headers`
  // (scripts/openapi/enrichments.ts).
  const idempotencyKeys = createIdempotencyKeys();
  client.use(idempotencyKeys.middleware);
  idempotencyTables.set(client, idempotencyKeys.clear);
  return client;
}
