// @chartwarden/gusto-client — the shared adapter CONTRACT types (no IO, no SDK). Extracted into their own
// leaf so client.ts / normalize.ts / index.ts all import them WITHOUT closing an index↔client cycle
// (the no-circular fitness rule). No Gusto SDK shapes leak past this boundary; money is INTEGER CENTS.

/** A normalized wage row by discipline feeding Worksheet S-3 Part II. */
export interface NormalizedWageRow {
  discipline: string;
  paidHours: number;
  salaryCents: number;
  fringeCents: number;
  period?: string;
}

/** A normalized wage-data pull for a fiscal-year window. */
export interface NormalizedWageData {
  fromDate: string;
  toDate: string;
  rows: NormalizedWageRow[];
  employeeCount: number;
  totalPaidHours: number;
  totalSalaryCents: number;
}

/** The typed per-tenant Gusto client surface M27's wage-data-pull worker consumes. */
export interface GustoClient {
  getWageData(input: { fromDate: string; toDate: string }): Promise<NormalizedWageData>;
  /** Automatic on 401; exposed for explicit reconnect flows. */
  refreshTokens(): Promise<void>;
}

/** The published `GustoClientFactory` seam shape (mirrors `@chartwarden/cost-report`'s seam interface). */
export interface GustoClientFactory {
  forTenant(input: { organizationId: string; gustoCompanyId?: string }): Promise<GustoClient>;
}
