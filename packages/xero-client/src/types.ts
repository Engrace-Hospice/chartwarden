// @wardenx/xero-client — the shared adapter CONTRACT types (no IO, no SDK). Extracted into their own
// leaf so client.ts / normalize.ts / index.ts all import them WITHOUT closing an index↔client cycle
// (the no-circular fitness rule). No Xero SDK shapes leak past this boundary; money is INTEGER CENTS.

/** A normalized GL account row (post-adapter). */
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
