// @chartwarden/xero-client — M27-owned Xero adapter package (D6, architecture §25.14 adapter mandate).
//
// This package is the ONLY place in the ChartWarden repo permitted to import the `xero-node` SDK (the
// dependency-cruiser adapter-mandate rule enforces). It yields a typed per-tenant `XeroClient` with
// shared OAuth-refresh handling, published to the M1 SeamRegistry as `XeroClientFactory` by M27's boot;
// M29 consumes the factory at M29 lock for non-cost-report uses (AR sync) so OAuth refresh is
// centralized and two modules never hold two token sets for one tenant connection.
//
// Structure (PR C1): the typed adapter CONTRACT + the real raw→normalized mapping (`normalize.ts`,
// tested-shape) + a refresh-on-401 wrapper (`oauth.ts`) + a per-tenant token-store PORT (`token-store.ts`)
// + the `LiveXeroClient` shape (`client.ts`). The factory is fail-closed by DEFAULT (no transport, no
// token store) but accepts injected ports via `createXeroClientFactory`. The live `xero-node` transport +
// per-tenant token store land at tenant onboarding (M34) behind the `TODO(M34-oauth)` boundary in
// `oauth.ts` / `token-store.ts`; they stay confined to THIS package. No SDK import, no network here.

// The shared adapter CONTRACT types live in ./types (extracted to avoid an index↔client import cycle).
export type {
  NormalizedAccount,
  NormalizedTrialBalance,
  XeroClient,
  XeroClientFactory,
} from "./types";
import type { XeroClient, XeroClientFactory } from "./types";

// Fail-closed sentinel + raw endpoint constants.
export {
  XERO_NOT_CONNECTED,
  XERO_API_BASE_URL,
  XERO_TRIAL_BALANCE_PATH,
  XERO_ACCOUNTS_PATH,
} from "./constants";

// Per-tenant OAuth token-store port + fail-closed default.
export { NO_TOKEN_STORE } from "./token-store";
export type { TokenStore, XeroTokens } from "./token-store";

// Raw transport port + refresh-on-401 wrapper.
export { NO_XERO_HTTP_PORT, requestWithRefresh } from "./oauth";
export type { XeroHttpPort, XeroRequest, XeroRawResponse, XeroSession } from "./oauth";

// Pure raw→normalized mapping (tested-shape).
export {
  normalizeTrialBalance,
  normalizeChartOfAccounts,
  dollarsToCents,
  XERO_MALFORMED_RESPONSE,
} from "./normalize";

// The live per-tenant client shape.
export { LiveXeroClient } from "./client";
export type { LiveXeroClientDeps } from "./client";

import { LiveXeroClient } from "./client";
import { XERO_NOT_CONNECTED } from "./constants";
import { NO_XERO_HTTP_PORT, type XeroHttpPort } from "./oauth";
import { NO_TOKEN_STORE, type TokenStore } from "./token-store";

/** Injected ports the factory binds: the raw transport + the per-tenant token store. */
export interface XeroClientFactoryDeps {
  readonly tokenStore: TokenStore;
  readonly http: XeroHttpPort;
}

/**
 * Build a `XeroClientFactory` over injected ports. `forTenant` resolves the tenant's tokens via the store;
 * a `null` result (tenant not connected) throws {@link XERO_NOT_CONNECTED} so callers surface the reconnect
 * prompt rather than silently succeeding. When tokens resolve it returns a {@link LiveXeroClient} bound to
 * the injected transport with refresh-on-401. The default {@link xeroClientFactory} passes the fail-closed
 * ports; M27's composition root passes live ports once tenant OAuth onboarding lands in M34.
 */
export function createXeroClientFactory(deps: XeroClientFactoryDeps): XeroClientFactory {
  return {
    async forTenant(input): Promise<XeroClient> {
      const tokens = await deps.tokenStore.getTokensForTenant(
        input.organizationId,
        input.xeroTenantId,
      );
      if (tokens === null) {
        throw new Error(XERO_NOT_CONNECTED);
      }
      return new LiveXeroClient({
        organizationId: input.organizationId,
        tokens,
        tokenStore: deps.tokenStore,
        http: deps.http,
      });
    },
  };
}

/**
 * Fail-closed default factory. Built on the {@link NO_TOKEN_STORE} + {@link NO_XERO_HTTP_PORT} ports, so
 * `forTenant` throws {@link XERO_NOT_CONNECTED} until M27's boot injects live ports via
 * {@link createXeroClientFactory}. Preserves the original P1 stub's fail-closed behavior.
 */
export const xeroClientFactory: XeroClientFactory = createXeroClientFactory({
  tokenStore: NO_TOKEN_STORE,
  http: NO_XERO_HTTP_PORT,
});
