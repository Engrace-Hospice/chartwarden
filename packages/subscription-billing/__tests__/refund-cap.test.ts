// GAP-061 — the §2.3 refund cap: `amount <= amount_paid - refunds already requested/approved/executed`,
// and only a `paid` invoice is refundable.
import { describe, expect, it } from "vitest";
import { checkRefundRequest, committedRefundCents } from "../src/domain/validation";

describe("committedRefundCents (GAP-061)", () => {
  it("counts requested, approved and executed_success; ignores denied and executed_failed", () => {
    expect(
      committedRefundCents([
        { status: "requested", amountCents: 100 },
        { status: "approved", amountCents: 200 },
        { status: "executed_success", amountCents: 400 },
        { status: "denied", amountCents: 800 },
        { status: "executed_failed", amountCents: 1600 },
      ]),
    ).toBe(700);
  });
});

describe("checkRefundRequest (GAP-061)", () => {
  const paid = { invoiceStatus: "paid", amountPaidCents: 10_000, committedRefundCents: 0 } as const;

  it("accepts a refund up to the paid amount", () => {
    expect(checkRefundRequest({ ...paid, amountCents: 10_000 })).toEqual({ ok: true });
  });

  it("rejects an amount above amount_paid", () => {
    expect(checkRefundRequest({ ...paid, amountCents: 10_001 })).toEqual({
      ok: false,
      reason: "exceeds_refundable",
      refundableCents: 10_000,
    });
  });

  it("rejects when cumulative refunds would exceed amount_paid", () => {
    expect(
      checkRefundRequest({ ...paid, committedRefundCents: 9_000, amountCents: 1_001 }),
    ).toEqual({
      ok: false,
      reason: "exceeds_refundable",
      refundableCents: 1_000,
    });
  });

  it("rejects a non-paid invoice", () => {
    for (const invoiceStatus of ["draft", "open", "void", "uncollectible"]) {
      expect(checkRefundRequest({ ...paid, invoiceStatus, amountCents: 1 })).toMatchObject({
        ok: false,
        reason: "invoice_not_paid",
      });
    }
  });

  it("rejects non-positive and non-integer amounts", () => {
    for (const amountCents of [0, -5, 1.5]) {
      expect(checkRefundRequest({ ...paid, amountCents })).toMatchObject({
        ok: false,
        reason: "amount_invalid",
      });
    }
  });
});
