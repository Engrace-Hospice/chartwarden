// @wardenx/gusto-client — raw transport PORT + the refresh-on-401 wrapper STRUCTURE (M27 §6 `oauth/`, D6).
//
// This is the integration boundary. The raw bytes leave the process ONLY through the injected
// {@link GustoHttpPort}; this package performs no network I/O and imports no SDK. The default port fails
// closed with {@link GUSTO_NOT_CONNECTED} until the real client is wired (see TODO(M34-oauth) below). The
// {@link requestWithRefresh} wrapper encodes the shared OAuth-refresh handling the seam centralizes: one
// retry after a single token refresh on a 401 (never a refresh loop).
import { GUSTO_NOT_CONNECTED } from "./constants";
import type { GustoTokens, TokenStore } from "./token-store";

/** A raw, token-bearing Gusto API request the transport port executes verbatim. */
export interface GustoRequest {
  readonly method: "GET";
  /** API path under {@link import("./constants").GUSTO_API_BASE_URL}. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** Bearer access token for the `Authorization` header. */
  readonly accessToken: string;
  /** The Gusto company id this request targets. */
  readonly gustoCompanyId: string;
}

/** The raw transport response (status + already-JSON-decoded body) handed back to the normalizer. */
export interface GustoRawResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * The injected raw transport port — the ONLY way bytes leave the process. The live implementation is a
 * Gusto-SDK-backed (or fetch-backed) client wired at tenant onboarding.
 *
 * TODO(M34-oauth): provide the real per-tenant transport (Gusto client built from the stored token set).
 * Until then {@link NO_GUSTO_HTTP_PORT} fails closed.
 */
export type GustoHttpPort = (request: GustoRequest) => Promise<GustoRawResponse>;

/** The default port: no transport is wired, so any pull fails closed with {@link GUSTO_NOT_CONNECTED}. */
export const NO_GUSTO_HTTP_PORT: GustoHttpPort = () => {
  throw new Error(GUSTO_NOT_CONNECTED);
};

/** Mutable per-call session so a mid-flight refresh rotates the tokens the retry sees. */
export interface GustoSession {
  tokens: GustoTokens;
}

/**
 * Execute a Gusto request through the injected port with refresh-on-401 handling: build the request from
 * the current session tokens, send it, and — on exactly one 401 — refresh via the token store, mutate the
 * session, and retry once. Any other status (including a second 401) is returned to the caller to surface.
 * The `build` callback re-derives the request from the (possibly rotated) tokens so the retry carries the
 * fresh access token and company id.
 */
export async function requestWithRefresh(
  http: GustoHttpPort,
  tokenStore: TokenStore,
  organizationId: string,
  session: GustoSession,
  build: (accessToken: string, gustoCompanyId: string) => GustoRequest,
): Promise<GustoRawResponse> {
  const first = await http(build(session.tokens.accessToken, session.tokens.gustoCompanyId));
  if (first.status !== 401) {
    return first;
  }
  session.tokens = await tokenStore.refresh(organizationId, session.tokens);
  return http(build(session.tokens.accessToken, session.tokens.gustoCompanyId));
}
