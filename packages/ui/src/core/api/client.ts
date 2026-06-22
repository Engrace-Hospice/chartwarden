// @wardenx/ui — typed REST API client (F0-T02, ADR-0032).
// Wraps openapi-fetch over the generated `paths` (from docs/api/openapi.json via
// `bun run client:gen`) and attaches the WardenX auth + correlation-id headers.
// Leaf-safe: depends only on `openapi-fetch` + the generated schema — NO @wardenx/* import,
// so `packages/ui` stays a leaf and the frontend never compile-imports the backend.
import createClient, { type Client, type ClientOptions, type Middleware } from "openapi-fetch";
import type { paths } from "./schema";

/** The typed client: `client.GET("/api/v1/patients/{id}", { params: { path: { id } } })`. */
export type ApiClient = Client<paths>;

export interface ApiClientOptions {
  /** API origin. Default "" (same-origin — generated paths already carry `/api/v1`). */
  baseUrl?: string;
  /** Returns the bearer token to attach per request, or null/undefined to send none. */
  getAuthToken?: () => string | null | undefined;
  /** Per-request correlation id. Default `crypto.randomUUID()` when available. */
  correlationId?: () => string | undefined;
  /** Override fetch (tests / SSR). */
  fetch?: ClientOptions["fetch"];
}

function defaultCorrelationId(): string | undefined {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return undefined;
}

/** Build a typed API client with WardenX auth + correlation-id middleware. */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const { baseUrl = "", getAuthToken, correlationId = defaultCorrelationId, fetch } = options;
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
  return client;
}
