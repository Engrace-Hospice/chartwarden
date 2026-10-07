// GAP-063 — M21 -> M27 vendor-invoice accrual (D16): the pure accrual / reconciliation decisions, the new
// error codes and the route + permission wiring. The Drizzle writes and the emitted outbox rows are exercised
// by the real-publisher live suite (gap-063-m21-vendor-invoice.live.test.ts), not here.
import { M21_CONTRIBUTED_PERMISSIONS } from "@wardenx/auth";
import { describe, expect, it } from "vitest";
import {
  M21_ERROR_STATUS,
  SupplyStateError,
  decideInvoiceAccrual,
  decideInvoiceReconciliation,
} from "../src/modules/21-supplies/lifecycle";
import {
  MarkOrderedBody,
  RecordVendorInvoiceBody,
} from "../src/modules/21-supplies/routes/m21-typebox";

describe("decideInvoiceAccrual", () => {
  it("accrues the vendor-quoted total as integer cents in USD", () => {
    expect(decideInvoiceAccrual({ quotedTotalCents: 12_345 })).toEqual({
      invoiceTotalCents: 12_345,
      invoiceCurrency: "USD",
    });
  });

  it("allows a zero-dollar quote (a no-charge replacement)", () => {
    expect(decideInvoiceAccrual({ quotedTotalCents: 0 })?.invoiceTotalCents).toBe(0);
  });

  it("returns null when no quote was given, so no accrual is fabricated", () => {
    expect(decideInvoiceAccrual({ quotedTotalCents: undefined })).toBeNull();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a non-integer or negative quote (%s)",
    (quotedTotalCents) => {
      expect(() => decideInvoiceAccrual({ quotedTotalCents })).toThrow(SupplyStateError);
    },
  );
});

describe("decideInvoiceReconciliation", () => {
  const base = {
    accruedTotalCents: 10_000,
    accruedAt: "2026-10-01T00:00:00.000Z",
    reconciledAt: null,
  };

  it("computes a signed variance: positive when the vendor billed above the accrual", () => {
    expect(decideInvoiceReconciliation({ ...base, invoiceTotalCents: 10_750 })).toEqual({
      invoiceTotalCents: 10_750,
      varianceCents: 750,
    });
  });

  it("computes a negative variance when the vendor billed below the accrual", () => {
    expect(decideInvoiceReconciliation({ ...base, invoiceTotalCents: 9_000 }).varianceCents).toBe(
      -1_000,
    );
  });

  it("is zero when the invoice matches the accrual", () => {
    expect(decideInvoiceReconciliation({ ...base, invoiceTotalCents: 10_000 }).varianceCents).toBe(
      0,
    );
  });

  it("refuses an invoice for a request that was never accrued", () => {
    expect(() =>
      decideInvoiceReconciliation({
        accruedTotalCents: null,
        accruedAt: null,
        reconciledAt: null,
        invoiceTotalCents: 100,
      }),
    ).toThrow(expect.objectContaining({ code: "M21_INVOICE_NOT_ACCRUED" }));
  });

  it("refuses a second reconciliation instead of silently overwriting the first", () => {
    expect(() =>
      decideInvoiceReconciliation({
        ...base,
        reconciledAt: "2026-10-03T00:00:00.000Z",
        invoiceTotalCents: 10_000,
      }),
    ).toThrow(expect.objectContaining({ code: "M21_INVOICE_ALREADY_RECONCILED" }));
  });

  it("refuses a negative or fractional invoice total", () => {
    expect(() => decideInvoiceReconciliation({ ...base, invoiceTotalCents: -5 })).toThrow(
      SupplyStateError,
    );
    expect(() => decideInvoiceReconciliation({ ...base, invoiceTotalCents: 5.5 })).toThrow(
      SupplyStateError,
    );
  });
});

describe("error catalog and route contract", () => {
  it("maps the new codes to 409 (state) statuses", () => {
    expect(M21_ERROR_STATUS.M21_INVOICE_NOT_ACCRUED).toBe(409);
    expect(M21_ERROR_STATUS.M21_INVOICE_ALREADY_RECONCILED).toBe(409);
  });

  it("registers the reconcile permission key, RBAC only", () => {
    expect(M21_CONTRIBUTED_PERMISSIONS["supplies.request.invoice_reconcile"]).toMatchObject({
      resource: "supply_request",
      action: "invoice_reconcile",
      abac: "none",
    });
  });

  it("mark-ordered accepts an optional integer-cents quote", async () => {
    const { Value } = await import("@sinclair/typebox/value");
    expect(Value.Check(MarkOrderedBody, { vendorOrderReference: "PO-1" })).toBe(true);
    expect(
      Value.Check(MarkOrderedBody, { vendorOrderReference: "PO-1", vendorQuotedTotalCents: 500 }),
    ).toBe(true);
    expect(
      Value.Check(MarkOrderedBody, { vendorOrderReference: "PO-1", vendorQuotedTotalCents: 1.5 }),
    ).toBe(false);
    expect(
      Value.Check(MarkOrderedBody, { vendorOrderReference: "PO-1", vendorQuotedTotalCents: -1 }),
    ).toBe(false);
  });

  it("the vendor-invoice body requires an integer total and nothing else", async () => {
    const { Value } = await import("@sinclair/typebox/value");
    expect(Value.Check(RecordVendorInvoiceBody, { invoiceTotalCents: 9900 })).toBe(true);
    expect(Value.Check(RecordVendorInvoiceBody, {})).toBe(false);
    expect(Value.Check(RecordVendorInvoiceBody, { invoiceTotalCents: 9900, extra: 1 })).toBe(false);
  });
});
