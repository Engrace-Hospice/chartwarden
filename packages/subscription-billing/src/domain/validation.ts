// @wardenx/subscription-billing — §2.3 domain-level validation rules (pure kernel, M35-T01).
//
// These are the DOMAIN invariants (not the wire-shape TypeBox schemas, which land with the routes in
// T06). They are pure, penny-exact, DB-free predicates the lifecycle services + the reconciler assert.
// Money is always integer cents (no float arithmetic — §2.3 / D8).

import type { InvoiceLineKind } from "@wardenx/types";

/** The 32-lowercase-hex HMAC-SHA256 digest shape the pseudonym tables enforce (§2.3 CHECK). A raw UUID
 *  (36 chars, dashes) can never satisfy this, so a raw `patient_id` cannot accidentally land in the
 *  pseudonym keyspace. */
export const BILLING_PSEUDONYM_REGEX = /^[a-f0-9]{32}$/;

/** §2.3 `patient_active_period.patient_pseudonym` / `user_active_period.membership_pseudonym` shape check. */
export function isValidBillingPseudonym(value: string): boolean {
  return BILLING_PSEUDONYM_REGEX.test(value);
}

/** §2.3 `invoice.total_cents = invoice.subtotal_cents + invoice.tax_cents` (CHECK-constraint invariant). */
export function invoiceTotalsConsistent(input: {
  totalCents: number;
  subtotalCents: number;
  taxCents: number;
}): boolean {
  return input.totalCents === input.subtotalCents + input.taxCents;
}

/** §2.3 the reconciler invariant (cannot be a CHECK — lines arrive across webhook events):
 *  `SUM(line.total WHERE kind != 'tax') = subtotal` AND `SUM(line.total WHERE kind = 'tax') = tax`. */
export function invoiceLineSumsConsistent(input: {
  lines: ReadonlyArray<{ kind: InvoiceLineKind; totalCents: number }>;
  subtotalCents: number;
  taxCents: number;
}): boolean {
  let nonTax = 0;
  let tax = 0;
  for (const line of input.lines) {
    if (line.kind === "tax") tax += line.totalCents;
    else nonTax += line.totalCents;
  }
  return nonTax === input.subtotalCents && tax === input.taxCents;
}

/** §2.3 `usage_event.quantity > 0` (CHECK). Negative usage is a separate positive-quantity reversal
 *  event handled at aggregation, never at ingest — so ingest quantities are strictly positive integers. */
export function isValidUsageQuantity(quantity: number): boolean {
  return Number.isInteger(quantity) && quantity > 0;
}

/** §2.3 `refund.amount_cents > 0` (CHECK) AND `refund.amount_cents <= invoice.amount_paid_cents`
 *  (application-level join check). */
export function isValidRefundAmount(input: {
  amountCents: number;
  amountPaidCents: number;
}): boolean {
  return (
    Number.isInteger(input.amountCents) &&
    input.amountCents > 0 &&
    input.amountCents <= input.amountPaidCents
  );
}

/** §2.3 a subscription's `plan_id` must reference an `active` (any new subscription) or `deprecated`
 *  (grandfathered existing subscription) plan — never an `inactive` draft. */
export function isPlanReferenceEligible(input: {
  planIsActive: boolean;
  planIsDeprecated: boolean;
  isNewSubscription: boolean;
}): boolean {
  if (input.planIsActive) return true;
  // A deprecated plan is allowed only for an EXISTING (grandfathered) subscription.
  return input.planIsDeprecated && !input.isNewSubscription;
}
