// @chartwarden/gusto-client — M27-owned Gusto adapter package (D6, architecture §25.14 adapter mandate).
//
// This package is the ONLY place in the ChartWarden repo permitted to import the Gusto SDK (dependency-
// cruiser enforces). It yields a typed per-tenant `GustoClient` with shared OAuth-refresh handling,
// published to the M1 SeamRegistry as `GustoClientFactory` by M27's boot; M29 may consume the factory
// for non-cost-report payroll-event ingest at M29 lock so OAuth refresh stays centralized.
//
// Structure (PR C2): the typed adapter CONTRACT + the real raw→normalized mapping (`normalize.ts`,
// tested-shape) + a refresh-on-401 wrapper (`oauth.ts`) + a per-tenant token-store PORT (`token-store.ts`)
// + the `LiveGustoClient` shape (`client.ts`). The factory is fail-closed by DEFAULT (no transport, no
// token store) but accepts injected ports via `createGustoClientFactory`. The live Gusto transport +
// per-tenant token store land at tenant onboarding (M34) behind the `TODO(M34-oauth)` boundary in
// `oauth.ts` / `token-store.ts`; they stay confined to THIS package. Tenants on `wage_source='manual'`
// bypass this path entirely. No SDK import, no network here.

// The shared adapter CONTRACT types live in ./types (extracted to avoid an index↔client import cycle).
export type {
  NormalizedWageRow,
  NormalizedWageData,
  GustoClient,
  GustoClientFactory,
} from "./types";
import type { GustoClient, GustoClientFactory } from "./types";

// Fail-closed sentinel + raw endpoint constants.
export { GUSTO_NOT_CONNECTED, GUSTO_API_BASE_URL, GUSTO_PAYROLLS_PATH } from "./constants";

// Per-tenant OAuth token-store port + fail-closed default.
export { NO_TOKEN_STORE } from "./token-store";
export type { TokenStore, GustoTokens } from "./token-store";

// Raw transport port + refresh-on-401 wrapper.
export { NO_GUSTO_HTTP_PORT, requestWithRefresh } from "./oauth";
export type { GustoHttpPort, GustoRequest, GustoRawResponse, GustoSession } from "./oauth";

// Pure raw→normalized mapping (tested-shape).
export { normalizeWageData, dollarsToCents, GUSTO_MALFORMED_RESPONSE } from "./normalize";

// The live per-tenant client shape.
export { LiveGustoClient } from "./client";
export type { LiveGustoClientDeps } from "./client";

import { LiveGustoClient } from "./client";
import { GUSTO_NOT_CONNECTED } from "./constants";
import { type GustoHttpPort, NO_GUSTO_HTTP_PORT } from "./oauth";
import { NO_TOKEN_STORE, type TokenStore } from "./token-store";

/** Injected ports the factory binds: the raw transport + the per-tenant token store. */
export interface GustoClientFactoryDeps {
  readonly tokenStore: TokenStore;
  readonly http: GustoHttpPort;
}

/**
 * Build a `GustoClientFactory` over injected ports. `forTenant` resolves the tenant's tokens via the store;
 * a `null` result (tenant not connected) throws {@link GUSTO_NOT_CONNECTED} so callers surface the reconnect
 * prompt rather than silently succeeding. When tokens resolve it returns a {@link LiveGustoClient} bound to
 * the injected transport with refresh-on-401. The default {@link gustoClientFactory} passes the fail-closed
 * ports; M27's composition root passes live ports once tenant OAuth onboarding lands in M34.
 */
export function createGustoClientFactory(deps: GustoClientFactoryDeps): GustoClientFactory {
  return {
    async forTenant(input): Promise<GustoClient> {
      const tokens = await deps.tokenStore.getTokensForTenant(
        input.organizationId,
        input.gustoCompanyId,
      );
      if (tokens === null) {
        throw new Error(GUSTO_NOT_CONNECTED);
      }
      return new LiveGustoClient({
        organizationId: input.organizationId,
        tokens,
        tokenStore: deps.tokenStore,
        http: deps.http,
      });
    },
  };
}

/**
 * Fail-closed default factory. Built on the {@link NO_TOKEN_STORE} + {@link NO_GUSTO_HTTP_PORT} ports, so
 * `forTenant` throws {@link GUSTO_NOT_CONNECTED} until M27's boot injects live ports via
 * {@link createGustoClientFactory}. Preserves the original P1 stub's fail-closed behavior.
 */
export const gustoClientFactory: GustoClientFactory = createGustoClientFactory({
  tokenStore: NO_TOKEN_STORE,
  http: NO_GUSTO_HTTP_PORT,
});
