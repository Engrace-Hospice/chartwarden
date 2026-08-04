// @wardenx/gusto-client — the per-tenant LiveGustoClient SHAPE (mirrors the M30 cahps-vendors `ShpClient`).
//
// Implements the published {@link GustoClient} contract over the injected raw transport ({@link GustoHttpPort})
// + token store, with refresh-on-401 (oauth.ts). It performs NO direct network I/O and imports no SDK;
// every byte goes through the injected port. Constructed by `createGustoClientFactory` (index.ts) once a
// tenant's tokens resolve; the default factory injects the fail-closed port so an un-wired env throws
// {@link GUSTO_NOT_CONNECTED}.
import { GUSTO_PAYROLLS_PATH } from "./constants";
import { normalizeWageData } from "./normalize";
import { type GustoHttpPort, type GustoSession, requestWithRefresh } from "./oauth";
import type { GustoTokens, TokenStore } from "./token-store";
import type { GustoClient, NormalizedWageData } from "./types";

/** Everything a {@link LiveGustoClient} needs; assembled by the factory after token resolution. */
export interface LiveGustoClientDeps {
  readonly organizationId: string;
  readonly tokens: GustoTokens;
  readonly tokenStore: TokenStore;
  readonly http: GustoHttpPort;
}

function expectOk(response: { status: number }): void {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GUSTO_REQUEST_FAILED: status ${response.status}`);
  }
}

export class LiveGustoClient implements GustoClient {
  private readonly session: GustoSession;

  constructor(private readonly deps: LiveGustoClientDeps) {
    this.session = { tokens: deps.tokens };
  }

  async getWageData(input: { fromDate: string; toDate: string }): Promise<NormalizedWageData> {
    const response = await requestWithRefresh(
      this.deps.http,
      this.deps.tokenStore,
      this.deps.organizationId,
      this.session,
      (accessToken, gustoCompanyId) => ({
        method: "GET",
        path: GUSTO_PAYROLLS_PATH.replace("{companyId}", gustoCompanyId),
        query: { start_date: input.fromDate, end_date: input.toDate },
        accessToken,
        gustoCompanyId,
      }),
    );
    expectOk(response);
    return normalizeWageData(response.body, input.fromDate, input.toDate);
  }

  /** Explicit reconnect: rotate the tokens via the store and adopt them for subsequent calls. */
  async refreshTokens(): Promise<void> {
    this.session.tokens = await this.deps.tokenStore.refresh(
      this.deps.organizationId,
      this.session.tokens,
    );
  }
}
