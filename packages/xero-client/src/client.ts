// @wardenx/xero-client — the per-tenant LiveXeroClient SHAPE (mirrors the M30 cahps-vendors `ShpClient`).
//
// Implements the published {@link XeroClient} contract over the injected raw transport ({@link XeroHttpPort})
// + token store, with refresh-on-401 (oauth.ts). It performs NO direct network I/O and imports no SDK;
// every byte goes through the injected port. Constructed by `createXeroClientFactory` (index.ts) once a
// tenant's tokens resolve; the default factory injects the fail-closed port so an un-wired env throws
// {@link XERO_NOT_CONNECTED}.
import { XERO_ACCOUNTS_PATH, XERO_TRIAL_BALANCE_PATH } from "./constants";
import { normalizeChartOfAccounts, normalizeTrialBalance } from "./normalize";
import { type XeroHttpPort, type XeroSession, requestWithRefresh } from "./oauth";
import type { TokenStore, XeroTokens } from "./token-store";
import type { NormalizedAccount, NormalizedTrialBalance, XeroClient } from "./types";

/** Everything a {@link LiveXeroClient} needs; assembled by the factory after token resolution. */
export interface LiveXeroClientDeps {
  readonly organizationId: string;
  readonly tokens: XeroTokens;
  readonly tokenStore: TokenStore;
  readonly http: XeroHttpPort;
}

function expectOk(response: { status: number }): void {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`XERO_REQUEST_FAILED: status ${response.status}`);
  }
}

export class LiveXeroClient implements XeroClient {
  private readonly session: XeroSession;

  constructor(private readonly deps: LiveXeroClientDeps) {
    this.session = { tokens: deps.tokens };
  }

  async getTrialBalance(input: {
    fromDate: string;
    toDate: string;
  }): Promise<NormalizedTrialBalance> {
    const response = await requestWithRefresh(
      this.deps.http,
      this.deps.tokenStore,
      this.deps.organizationId,
      this.session,
      (accessToken, xeroTenantId) => ({
        method: "GET",
        path: XERO_TRIAL_BALANCE_PATH,
        query: { date: input.toDate, fromDate: input.fromDate, toDate: input.toDate },
        accessToken,
        xeroTenantId,
      }),
    );
    expectOk(response);
    return normalizeTrialBalance(response.body, input.fromDate, input.toDate);
  }

  async getChartOfAccounts(): Promise<NormalizedAccount[]> {
    const response = await requestWithRefresh(
      this.deps.http,
      this.deps.tokenStore,
      this.deps.organizationId,
      this.session,
      (accessToken, xeroTenantId) => ({
        method: "GET",
        path: XERO_ACCOUNTS_PATH,
        accessToken,
        xeroTenantId,
      }),
    );
    expectOk(response);
    return normalizeChartOfAccounts(response.body);
  }

  /** Explicit reconnect: rotate the tokens via the store and adopt them for subsequent calls. */
  async refreshTokens(): Promise<void> {
    this.session.tokens = await this.deps.tokenStore.refresh(
      this.deps.organizationId,
      this.session.tokens,
    );
  }
}
