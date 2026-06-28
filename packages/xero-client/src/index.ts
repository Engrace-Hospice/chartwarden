// @wardenx/xero-client — M27-owned Xero adapter package (D6, architecture §25.14 adapter mandate).
//
// This package is the ONLY place in the WardenX repo permitted to import the `xero-node` SDK (the
// dependency-cruiser adapter-mandate rule enforces). It yields a typed per-tenant `XeroClient` with
// shared OAuth-refresh handling, published to the M1 SeamRegistry as `XeroClientFactory` by M27's boot;
// M29 consumes the factory at M29 lock for non-cost-report uses (AR sync) so OAuth refresh is
// centralized and two modules never hold two token sets for one tenant connection.
//
// P1 scope: the typed adapter CONTRACT + a fail-closed factory stub. The live `xero-node` wiring +
// per-tenant token store + refresh-on-401 land in P3 (PR C1); they stay confined to THIS package.

/** A normalized GL account row (post-adapter; no Xero SDK shapes leak past this boundary). */
export interface NormalizedAccount {
  glCode: string;
  glName: string;
  debitCents: number;
  creditCents: number;
  period?: string;
}

/** A normalized trial balance for a fiscal-year window. */
export interface NormalizedTrialBalance {
  fromDate: string;
  toDate: string;
  accounts: NormalizedAccount[];
  totalDebitsCents: number;
  totalCreditsCents: number;
  balanced: boolean;
}

/** The typed per-tenant Xero client surface M27's trial-balance-pull worker consumes. */
export interface XeroClient {
  getTrialBalance(input: { fromDate: string; toDate: string }): Promise<NormalizedTrialBalance>;
  getChartOfAccounts(): Promise<NormalizedAccount[]>;
  /** Automatic on 401; exposed for explicit reconnect flows. */
  refreshTokens(): Promise<void>;
}

/** The published `XeroClientFactory` seam shape (mirrors `@wardenx/cost-report`'s seam interface). */
export interface XeroClientFactory {
  forTenant(input: { organizationId: string; xeroTenantId?: string }): Promise<XeroClient>;
}

/** Thrown when a tenant has not connected Xero (no stored OAuth tokens). */
export const XERO_NOT_CONNECTED = "XERO_NOT_CONNECTED" as const;

/**
 * P1 fail-closed factory stub. The live implementation (token store + `xero-node` + refresh wrapper)
 * lands in P3 (PR C1) inside this package. Until then `forTenant` throws `XERO_NOT_CONNECTED` so callers
 * surface the reconnect prompt rather than silently succeeding.
 */
export const xeroClientFactory: XeroClientFactory = {
  async forTenant() {
    throw new Error(XERO_NOT_CONNECTED);
  },
};
