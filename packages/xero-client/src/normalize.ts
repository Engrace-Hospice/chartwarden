// @wardenx/xero-client — raw Xero → normalized mapping (pure, IO-free). Mirrors the M30 cahps-vendors
// `result.ts` parser style: defensive type-guards, structured throw on a malformed payload, money as
// INTEGER CENTS (M27 invariant — no floats past this boundary). No Xero SDK shapes leak past here.
//
// The "raw" intermediate consumed here is the post-transport JSON the injected XeroHttpPort returns. We
// document a stable adapter intermediate (gl code/name + decimal-dollar debit/credit) so this normalizer
// is testable without the live transport; the live xero-node mapping (Reports rows → this intermediate)
// is wired with the transport at M34 — see oauth.ts TODO(M34-oauth).
import type { NormalizedAccount, NormalizedTrialBalance } from "./types";

/** Thrown (as an Error message) when a raw Xero payload does not match the documented shape. */
export const XERO_MALFORMED_RESPONSE = "XERO_MALFORMED_RESPONSE" as const;

function fail(detail: string): never {
  throw new Error(`${XERO_MALFORMED_RESPONSE}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(record: Record<string, unknown>, field: string): string {
  const v = record[field];
  if (typeof v !== "string" || v.length === 0) {
    fail(`'${field}' must be a non-empty string`);
  }
  return v as string;
}

function optStr(record: Record<string, unknown>, field: string): string | undefined {
  const v = record[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") fail(`'${field}' must be a string when present`);
  return v as string;
}

/** Convert a decimal-dollar amount to integer cents; rejects non-finite values. */
export function dollarsToCents(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`'${field}' must be a finite number of dollars`);
  }
  return Math.round((value as number) * 100);
}

function normalizeAccountLine(value: unknown): NormalizedAccount {
  if (!isRecord(value)) fail("account line must be an object");
  const record = value as Record<string, unknown>;
  return {
    glCode: str(record, "glCode"),
    glName: str(record, "glName"),
    debitCents: dollarsToCents(record.debit, "debit"),
    creditCents: dollarsToCents(record.credit, "credit"),
    period: optStr(record, "period"),
  };
}

/**
 * Map a raw Xero trial-balance payload into a {@link NormalizedTrialBalance}. Sums debit/credit cents and
 * sets `balanced` when they tie exactly (integer cents — exact equality is meaningful). Pure; throws
 * {@link XERO_MALFORMED_RESPONSE} on a malformed payload. `fromDate`/`toDate` come from the pull window
 * (the caller's request), not the payload, so the window is authoritative.
 */
export function normalizeTrialBalance(
  body: unknown,
  fromDate: string,
  toDate: string,
): NormalizedTrialBalance {
  if (!isRecord(body)) fail("trial-balance payload must be an object");
  const rawAccounts = (body as Record<string, unknown>).accounts;
  if (!Array.isArray(rawAccounts)) fail("'accounts' must be an array");

  const accounts = rawAccounts.map(normalizeAccountLine);
  let totalDebitsCents = 0;
  let totalCreditsCents = 0;
  for (const account of accounts) {
    totalDebitsCents += account.debitCents;
    totalCreditsCents += account.creditCents;
  }
  return {
    fromDate,
    toDate,
    accounts,
    totalDebitsCents,
    totalCreditsCents,
    balanced: totalDebitsCents === totalCreditsCents,
  };
}

/**
 * Map a raw Xero chart-of-accounts payload (`{ accounts: [...] }`) into {@link NormalizedAccount}[]. The
 * COA carries no balances, so debit/credit cents are zero. Pure; throws on a malformed payload.
 */
export function normalizeChartOfAccounts(body: unknown): NormalizedAccount[] {
  if (!isRecord(body)) fail("chart-of-accounts payload must be an object");
  const rawAccounts = (body as Record<string, unknown>).accounts;
  if (!Array.isArray(rawAccounts)) fail("'accounts' must be an array");
  return rawAccounts.map((value) => {
    if (!isRecord(value)) fail("account must be an object");
    const record = value as Record<string, unknown>;
    return {
      glCode: str(record, "glCode"),
      glName: str(record, "glName"),
      debitCents: 0,
      creditCents: 0,
      period: optStr(record, "period"),
    };
  });
}
