// @wardenx/subscription-billing — §2.2 invoice status mirror (pure kernel, M35-T01).
//
// M35 never AUTHORS invoices; it mirrors the Stripe invoice lifecycle driven by webhooks
// (`invoice.created` → draft, `invoice.finalized` → open, `invoice.paid` → paid, `payment_failed`,
// `voided`, `marked_uncollectible`). This adjacency lets the webhook handler reject an out-of-order or
// spoofed transition (defence-in-depth on top of Stripe's own state), DB-free and unit-testable.

import type { InvoiceStatus } from "@wardenx/types";

/** The allowed Stripe-mirrored invoice transitions. `paid`/`void` are terminal; a late payment may move
 *  `uncollectible → paid` (Stripe permits recovering a written-off invoice). */
export const INVOICE_TRANSITIONS = {
  draft: ["open", "void"],
  open: ["paid", "void", "uncollectible"],
  paid: [],
  void: [],
  uncollectible: ["paid"],
} as const satisfies Record<InvoiceStatus, readonly InvoiceStatus[]>;

/** True iff `from → to` is a legal Stripe-mirrored invoice transition. */
export function canTransitionInvoice(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return (INVOICE_TRANSITIONS[from] as readonly InvoiceStatus[]).includes(to);
}
