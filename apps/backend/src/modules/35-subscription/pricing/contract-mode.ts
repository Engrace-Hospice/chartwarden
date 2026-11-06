// apps/backend/src/modules/35-subscription/pricing/contract-mode.ts — the billing service mode as an EFFECTIVE-DATED history (slice 2).
//
// `subscription_contract_mode` is append-only. The mode in force on a date is the row with the latest `effective_from` at or before it
// (the newest row wins a tie). A mode change takes effect from the 1st of the NEXT month, so the month a tenant is being billed in is
// priced with the mode it started with. The one exception is a tenant that has no statement yet and is not live (still onboarding):
// nothing has been billed and nothing is running, so the change is immediate. A statement reads the mode in force on the first day
// it bills (the later of the month's first day and the go-live day), never the mode in force at the moment it is computed.
// Pure: no IO, no clock (dates are `YYYY-MM-DD` strings, UTC).
import type { BillingServiceMode } from "@chartwarden/types";

export interface ModeHistoryRow {
  readonly billingServiceMode: BillingServiceMode;
  /** `YYYY-MM-DD` (UTC). */
  readonly effectiveFrom: string;
  readonly createdAt: Date;
}

const byEffectiveThenCreated = (a: ModeHistoryRow, b: ModeHistoryRow): number =>
  a.effectiveFrom === b.effectiveFrom
    ? a.createdAt.getTime() - b.createdAt.getTime()
    : a.effectiveFrom < b.effectiveFrom
      ? -1
      : 1;

/** The mode in force on `onIso`; null when no row has taken effect yet (a history never starts after its contract). */
export function modeInForceOn(
  history: readonly ModeHistoryRow[],
  onIso: string,
): BillingServiceMode | null {
  const taken = history.filter((r) => r.effectiveFrom <= onIso).sort(byEffectiveThenCreated);
  return taken[taken.length - 1]?.billingServiceMode ?? null;
}

export interface PendingMode {
  readonly billingServiceMode: BillingServiceMode;
  readonly effectiveOn: string;
}

/**
 * The change that has been recorded but has not taken effect yet as of `todayIso` (the newest row of the latest pending date), else
 * null. A pending row that names the mode already in force is no change at all (an operator who changed their mind and set the
 * current mode again has withdrawn the pending one), so it is not reported.
 */
export function pendingModeAfter(
  history: readonly ModeHistoryRow[],
  todayIso: string,
): PendingMode | null {
  const future = history.filter((r) => r.effectiveFrom > todayIso).sort(byEffectiveThenCreated);
  const last = future[future.length - 1];
  if (!last || last.billingServiceMode === modeInForceOn(history, todayIso)) return null;
  return { billingServiceMode: last.billingServiceMode, effectiveOn: last.effectiveFrom };
}

/** The 1st of the month after the one containing `at`, as `YYYY-MM-DD` (UTC). */
export function firstOfNextMonthIso(at: Date): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
}

/** What a mode change recorded at `at` is dated: today while onboarding with nothing billed, else the 1st of next month. */
export function modeChangeEffectiveOn(
  at: Date,
  facts: { readonly tenantIsLive: boolean; readonly hasStatement: boolean },
): string {
  return !facts.tenantIsLive && !facts.hasStatement
    ? at.toISOString().slice(0, 10)
    : firstOfNextMonthIso(at);
}
