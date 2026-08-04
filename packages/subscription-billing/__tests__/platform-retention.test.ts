// M35-T03 — §3.7 / M35-F06 platform-retention transfer (copy-then-delete over an in-memory store).
import { describe, expect, it } from "vitest";
import {
  PLATFORM_INVOICE_RETENTION_YEARS,
  PlatformRetentionService,
  computeRetainUntil,
} from "../src/service/platform-retention-service";
import type { PlatformRetentionStore, RetainableInvoice } from "../src/service/ports";

const NOW = new Date("2026-08-02T00:00:00.000Z");

function invoice(id: string, lineCount: number): RetainableInvoice {
  return {
    id,
    stripeInvoiceId: `in_${id}`,
    invoiceNumber: `NUM-${id}`,
    status: "paid",
    subtotalCents: 50000,
    taxCents: 4000,
    totalCents: 54000,
    amountPaidCents: 54000,
    currencyCode: "usd",
    periodStart: NOW,
    periodEnd: NOW,
    issuedAt: NOW,
    paidAt: NOW,
    lines: Array.from({ length: lineCount }, (_, i) => ({
      id: `${id}-l${i}`,
      stripeLineId: `il_${id}_${i}`,
      kind: "subscription" as const,
      description: "base",
      quantity: 1,
      unitAmountCents: 50000,
      totalCents: 50000,
      periodStart: NOW,
      periodEnd: NOW,
      meterEventType: null,
    })),
  };
}

class FakeRetentionStore implements PlatformRetentionStore {
  invoices: RetainableInvoice[];
  retained: string[] = [];
  retainedLines = 0;
  deleted: string[] = [];
  order: string[] = [];
  seq = 0;
  constructor(invoices: RetainableInvoice[]) {
    this.invoices = invoices;
  }
  async tenantInvoicesForOrg() {
    return this.invoices;
  }
  async insertRetainedInvoice(
    input: Parameters<PlatformRetentionStore["insertRetainedInvoice"]>[0],
  ) {
    this.order.push(`copy-invoice:${input.originalInvoiceId}`);
    const retainedInvoiceId = `ret-${++this.seq}`;
    this.retained.push(retainedInvoiceId);
    return { retainedInvoiceId };
  }
  async insertRetainedInvoiceLines(
    input: Parameters<PlatformRetentionStore["insertRetainedInvoiceLines"]>[0],
  ) {
    this.order.push(`copy-lines:${input.originalInvoiceId}`);
    this.retainedLines += input.lines.length;
  }
  async deleteTenantInvoice(input: { organizationId: string; invoiceId: string }) {
    this.order.push(`delete:${input.invoiceId}`);
    this.deleted.push(input.invoiceId);
  }
}

describe("computeRetainUntil", () => {
  it("adds the 7-year IRS §6001 floor", () => {
    expect(PLATFORM_INVOICE_RETENTION_YEARS).toBe(7);
    expect(computeRetainUntil(NOW, 7).toISOString()).toBe("2033-08-02T00:00:00.000Z");
  });
});

describe("PlatformRetentionService.transferInvoicesToPlatformRetention (M35-F06)", () => {
  it("copies each invoice + its lines, THEN deletes the source (copy-then-delete order)", async () => {
    const store = new FakeRetentionStore([invoice("A", 2), invoice("B", 1)]);
    const svc = new PlatformRetentionService(store);
    const res = await svc.transferInvoicesToPlatformRetention({
      organizationId: "org-1",
      now: NOW,
    });

    expect(res.transferredInvoiceIds).toEqual(["A", "B"]);
    expect(res.retainedInvoiceIds).toHaveLength(2);
    expect(res.transferredLineCount).toBe(3);
    expect(res.platformRetentionTables).toEqual([
      "platform_retained_invoice",
      "platform_retained_invoice_line",
    ]);
    // per-invoice ordering: copy header → copy lines → delete source
    expect(store.order).toEqual([
      "copy-invoice:A",
      "copy-lines:A",
      "delete:A",
      "copy-invoice:B",
      "copy-lines:B",
      "delete:B",
    ]);
  });

  it("returns a null retainUntil when the tenant has no invoices", async () => {
    const svc = new PlatformRetentionService(new FakeRetentionStore([]));
    const res = await svc.transferInvoicesToPlatformRetention({
      organizationId: "org-empty",
      now: NOW,
    });
    expect(res.transferredInvoiceIds).toEqual([]);
    expect(res.retainUntil).toBeNull();
  });

  it("skips the line-copy call for an invoice with no lines", async () => {
    const store = new FakeRetentionStore([invoice("C", 0)]);
    const svc = new PlatformRetentionService(store);
    await svc.transferInvoicesToPlatformRetention({ organizationId: "org-1", now: NOW });
    expect(store.order).toEqual(["copy-invoice:C", "delete:C"]);
  });
});
