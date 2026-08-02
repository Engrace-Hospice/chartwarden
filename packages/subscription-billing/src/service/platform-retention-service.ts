// @wardenx/subscription-billing — §3.7 / M35-F06 platform-retention transfer (pure over ports, M35-T03).
//
// The COPY-THEN-DELETE that lets an offboarded tenant's invoices survive erasure (D13, IRS §6001 7-year
// floor) WITHOUT the M35-F06-rejected in-place `organization_id` rewrite. For each tenant `invoice`:
//
//   1. INSERT a `platform_retained_invoice` row (all payload columns copied verbatim + `original_invoice_id`
//      + `original_organization_id` for forensic traceability + `retain_until = transferredAt + 7 years`).
//   2. INSERT its `platform_retained_invoice_line` rows under that retained-invoice parent.
//   3. Only after the copies COMMIT, DELETE the source `invoice_line` + `invoice` rows (FK order).
//
// The platform-retention tables are NOT tenant-RLS-scoped, so the rows survive the tenant RLS teardown.
// The service returns the transferred ids + the tables touched, which the M35 eraser (T06) folds into the
// M4 `EraseReceipt` (`tablesPreservedInPlatformRetention` / `platformRetentionTables`) so M4's
// destruction-certification confirms the rows were MOVED, not deleted.
//
// PURE: the store owns the transactional Drizzle reads/writes/deletes (the caller runs it INSIDE the M4
// destruction `tx`); this orchestration is deterministic given (store, now, retainYears).

import type { OrgId } from "@wardenx/types";
import type { PlatformRetentionStore } from "./ports";

/** The IRS §6001 platform retention floor (D13) — 7 years from the transfer instant. */
export const PLATFORM_INVOICE_RETENTION_YEARS = 7;

/** `now + years` (calendar-year add; the retention floor is a coarse >= comparison, not a leap-exact one). */
export function computeRetainUntil(now: Date, years: number): Date {
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d;
}

export interface TransferResult {
  /** The `platform_retained_invoice.id`s created (one per source invoice). */
  readonly retainedInvoiceIds: string[];
  /** The source `invoice.id`s moved out of the tenant table (forensic cross-ref). */
  readonly transferredInvoiceIds: string[];
  readonly transferredLineCount: number;
  readonly retainUntil: Date | null;
  readonly platformRetentionTables: readonly ["platform_retained_invoice", "platform_retained_invoice_line"];
}

export class PlatformRetentionService {
  constructor(
    private readonly store: PlatformRetentionStore,
    private readonly retainYears: number = PLATFORM_INVOICE_RETENTION_YEARS,
  ) {}

  /**
   * §3.7 / M35-F06 transfer every tenant invoice into the platform-retention tables (copy-then-delete).
   * Idempotent-safe to run inside the M4 destruction `tx`: a partial failure rolls the whole `tx` back,
   * so a source row is never deleted without its retained copy committing.
   */
  async transferInvoicesToPlatformRetention(input: {
    organizationId: OrgId;
    now: Date;
  }): Promise<TransferResult> {
    const invoices = await this.store.tenantInvoicesForOrg(input.organizationId);
    const retainUntil = computeRetainUntil(input.now, this.retainYears);

    const retainedInvoiceIds: string[] = [];
    const transferredInvoiceIds: string[] = [];
    let transferredLineCount = 0;

    for (const invoice of invoices) {
      // 1. copy the invoice header
      const { retainedInvoiceId } = await this.store.insertRetainedInvoice({
        originalInvoiceId: invoice.id,
        originalOrganizationId: input.organizationId,
        transferredAt: input.now,
        retainUntil,
        invoice,
      });
      // 2. copy its lines under the retained parent
      if (invoice.lines.length > 0) {
        await this.store.insertRetainedInvoiceLines({
          retainedInvoiceId,
          originalInvoiceId: invoice.id,
          originalOrganizationId: input.organizationId,
          transferredAt: input.now,
          retainUntil,
          lines: invoice.lines,
        });
      }
      // 3. delete the source rows (impl deletes invoice_line then invoice — FK order)
      await this.store.deleteTenantInvoice({ organizationId: input.organizationId, invoiceId: invoice.id });

      retainedInvoiceIds.push(retainedInvoiceId);
      transferredInvoiceIds.push(invoice.id);
      transferredLineCount += invoice.lines.length;
    }

    return {
      retainedInvoiceIds,
      transferredInvoiceIds,
      transferredLineCount,
      retainUntil: invoices.length > 0 ? retainUntil : null,
      platformRetentionTables: ["platform_retained_invoice", "platform_retained_invoice_line"],
    };
  }
}
