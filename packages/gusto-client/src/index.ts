// @wardenx/gusto-client — M27-owned Gusto adapter package (D6, architecture §25.14 adapter mandate).
//
// This package is the ONLY place in the WardenX repo permitted to import the Gusto SDK (dependency-
// cruiser enforces). It yields a typed per-tenant `GustoClient` with shared OAuth-refresh handling,
// published to the M1 SeamRegistry as `GustoClientFactory` by M27's boot; M29 may consume the factory
// for non-cost-report payroll-event ingest at M29 lock so OAuth refresh stays centralized.
//
// P1 scope: the typed adapter CONTRACT + a fail-closed factory stub. The live Gusto wiring + per-tenant
// token store + wage-data endpoint land in P3 (PR C2); they stay confined to THIS package.

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

/** The published `GustoClientFactory` seam shape (mirrors `@wardenx/cost-report`'s seam interface). */
export interface GustoClientFactory {
  forTenant(input: { organizationId: string; gustoCompanyId?: string }): Promise<GustoClient>;
}

/** Thrown when a tenant has not connected Gusto (no stored OAuth tokens). */
export const GUSTO_NOT_CONNECTED = "GUSTO_NOT_CONNECTED" as const;

/**
 * P1 fail-closed factory stub. The live implementation lands in P3 (PR C2) inside this package. Until
 * then `forTenant` throws `GUSTO_NOT_CONNECTED` so callers surface the reconnect prompt rather than
 * silently succeeding (tenants may also be on `wage_source='manual'`, bypassing this path entirely).
 */
export const gustoClientFactory: GustoClientFactory = {
  async forTenant() {
    throw new Error(GUSTO_NOT_CONNECTED);
  },
};
