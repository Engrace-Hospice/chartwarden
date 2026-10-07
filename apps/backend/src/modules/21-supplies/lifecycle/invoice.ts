// apps/backend/src/modules/21-supplies/lifecycle/invoice.ts — GAP-063 / D16: the pure rules for the M21 -> M27
// vendor-invoice accrual and its reconciliation.
//
// NOT a §2.2 transition (status never moves). Two facts, both integer CENTS (see the events header):
//   1. ACCRUAL — when the vendor accepts the order (`mark-ordered`) the coordinator may record the
//      vendor-quoted total. That quote is the accrued cost: `invoice_total_cents` + `invoice_accrued_at` are
//      written and `m21.supply_request.invoice_accrued` is emitted. No quote ⇒ NO accrual (null), never a
//      fabricated 0 — a zero would read to M27 as a real no-charge order.
//   2. RECONCILIATION — when the vendor's actual invoice arrives it is matched against the accrual. The
//      signed variance (`invoice - accrual`, positive = billed above the accrual) is stored and
//      `m21.supply_request.invoice_reconciled` is emitted once. A request that was never accrued has nothing
//      to reconcile against, and a second reconciliation is refused rather than overwriting the first.
import { SupplyStateError } from "./errors";

/** The currency D16 fixes for the Phase-1 ledger. */
export const INVOICE_CURRENCY = "USD" as const;

function assertCents(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SupplyStateError(
      "M21_INVOICE_AMOUNT_INVALID",
      `${field} must be a non-negative integer number of cents`,
    );
  }
}

/** What an accrual writes onto the row, or `null` when no quote was supplied. */
export interface InvoiceAccrual {
  readonly invoiceTotalCents: number;
  readonly invoiceCurrency: typeof INVOICE_CURRENCY;
}

export function decideInvoiceAccrual(input: {
  readonly quotedTotalCents: number | undefined;
}): InvoiceAccrual | null {
  if (input.quotedTotalCents === undefined) return null;
  assertCents(input.quotedTotalCents, "vendorQuotedTotalCents");
  return { invoiceTotalCents: input.quotedTotalCents, invoiceCurrency: INVOICE_CURRENCY };
}

/** What a reconciliation writes onto the row. */
export interface InvoiceReconciliation {
  readonly invoiceTotalCents: number;
  /** SIGNED: positive means the vendor billed above what M21 accrued. */
  readonly varianceCents: number;
}

export function decideInvoiceReconciliation(input: {
  readonly accruedTotalCents: number | null;
  readonly accruedAt: string | null;
  readonly reconciledAt: string | null;
  readonly invoiceTotalCents: number;
}): InvoiceReconciliation {
  assertCents(input.invoiceTotalCents, "invoiceTotalCents");
  if (input.accruedAt === null || input.accruedTotalCents === null) {
    throw new SupplyStateError(
      "M21_INVOICE_NOT_ACCRUED",
      "this request has no accrued vendor quote to reconcile an invoice against; record the quote at mark-ordered first",
    );
  }
  if (input.reconciledAt !== null) {
    throw new SupplyStateError(
      "M21_INVOICE_ALREADY_RECONCILED",
      "the vendor invoice for this request was already reconciled",
    );
  }
  return {
    invoiceTotalCents: input.invoiceTotalCents,
    varianceCents: input.invoiceTotalCents - input.accruedTotalCents,
  };
}
