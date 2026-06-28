// @wardenx/xero-client — raw transport PORT + the refresh-on-401 wrapper STRUCTURE (M27 §6 `oauth/`, D6).
//
// This is the integration boundary. The raw bytes leave the process ONLY through the injected
// {@link XeroHttpPort}; this package performs no network I/O and imports no SDK. The default port fails
// closed with {@link XERO_NOT_CONNECTED} until the real client is wired (see TODO(M34-oauth) below). The
// {@link requestWithRefresh} wrapper encodes the shared OAuth-refresh handling the seam centralizes:
// one retry after a single token refresh on a 401 (never a refresh loop).
import { XERO_NOT_CONNECTED } from "./constants";
import type { TokenStore, XeroTokens } from "./token-store";

/** A raw, token-bearing Xero API request the transport port executes verbatim. */
export interface XeroRequest {
  readonly method: "GET";
  /** API path under {@link import("./constants").XERO_API_BASE_URL}. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** Bearer access token for the `Authorization` header. */
  readonly accessToken: string;
  /** The `Xero-tenant-id` header value. */
  readonly xeroTenantId: string;
}

/** The raw transport response (status + already-JSON-decoded body) handed back to the normalizer. */
export interface XeroRawResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * The injected raw transport port — the ONLY way bytes leave the process. The live implementation is a
 * `xero-node`-backed (or fetch-backed) client wired at tenant onboarding.
 *
 * TODO(M34-oauth): provide the real per-tenant transport (xero-node client built from the stored token
 * set). Until then {@link NO_XERO_HTTP_PORT} fails closed.
 */
export type XeroHttpPort = (request: XeroRequest) => Promise<XeroRawResponse>;

/** The default port: no transport is wired, so any pull fails closed with {@link XERO_NOT_CONNECTED}. */
export const NO_XERO_HTTP_PORT: XeroHttpPort = () => {
  throw new Error(XERO_NOT_CONNECTED);
};

/** Mutable per-call session so a mid-flight refresh rotates the tokens the retry sees. */
export interface XeroSession {
  tokens: XeroTokens;
}

/**
 * Execute a Xero request through the injected port with refresh-on-401 handling: build the request from
 * the current session tokens, send it, and — on exactly one 401 — refresh via the token store, mutate the
 * session, and retry once. Any other status (including a second 401) is returned to the caller to surface.
 * The `build` callback re-derives the request from the (possibly rotated) tokens so the retry carries the
 * fresh access token and tenant id.
 */
export async function requestWithRefresh(
  http: XeroHttpPort,
  tokenStore: TokenStore,
  organizationId: string,
  session: XeroSession,
  build: (accessToken: string, xeroTenantId: string) => XeroRequest,
): Promise<XeroRawResponse> {
  const first = await http(build(session.tokens.accessToken, session.tokens.xeroTenantId));
  if (first.status !== 401) {
    return first;
  }
  session.tokens = await tokenStore.refresh(organizationId, session.tokens);
  return http(build(session.tokens.accessToken, session.tokens.xeroTenantId));
}
