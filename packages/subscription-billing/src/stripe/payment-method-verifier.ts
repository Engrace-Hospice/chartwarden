// @wardenx/subscription-billing — GAP-060 the payment-method ownership check (pure over the Stripe client).
//
// `POST /api/v1/payment_methods/attach` receives a `stripePaymentMethodId` from the browser. A client-supplied
// id proves nothing: it can be forged (`pm_fake`), belong to another tenant's customer, or squat the global
// unique index. The only trustworthy fact is Stripe's own: a PaymentMethod is attached to a Customer only by
// a completed SetupIntent (or an explicit attach) for THAT customer. So the verifier retrieves the object
// through the (fail-closed) Stripe client and requires `customer === the org's customer id`. It also takes
// the non-secret display metadata (brand/last4/expiry) from Stripe rather than from the client.

import type { StripeClient } from "./client";
import { isStripeApiError } from "./types";

/** Non-secret metadata mirrored onto `payment_method` — taken from Stripe, never from the request body. */
export interface VerifiedPaymentMethod {
  readonly kind: "card" | "us_bank_account" | "sepa_debit" | "other";
  readonly cardBrand: string | null;
  readonly cardLast4: string | null;
  readonly cardExpMonth: number | null;
  readonly cardExpYear: number | null;
  readonly achBankName: string | null;
  readonly achAccountLast4: string | null;
  readonly achAccountType: string | null;
  readonly sepaCountry: string | null;
  readonly sepaLast4: string | null;
}

export interface PaymentMethodVerifier {
  /** Resolves with Stripe-sourced metadata, or throws {@link PaymentMethodRejectedError}. */
  verifyAttachable(input: {
    readonly stripeCustomerId: string;
    readonly stripePaymentMethodId: string;
  }): Promise<VerifiedPaymentMethod>;
}

export type PaymentMethodRejection = "not_found" | "not_attached_to_customer";

/** The payment method is not an attachable one for this customer (maps to a 4xx, never a 5xx). */
export class PaymentMethodRejectedError extends Error {
  constructor(
    readonly reason: PaymentMethodRejection,
    message: string,
  ) {
    super(message);
    this.name = "PaymentMethodRejectedError";
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) ? v : null;
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

function kindOf(type: unknown): VerifiedPaymentMethod["kind"] {
  return type === "card" || type === "us_bank_account" || type === "sepa_debit" ? type : "other";
}

/** Build the verifier over a {@link StripeClient} (fail-closed transport ⇒ the attach refuses, never trusts). */
export function createStripePaymentMethodVerifier(client: StripeClient): PaymentMethodVerifier {
  return {
    async verifyAttachable({ stripeCustomerId, stripePaymentMethodId }) {
      let body: Readonly<Record<string, unknown>>;
      try {
        const response = await client.execute(
          {
            operation: "payment_method.retrieve",
            payload: { paymentMethodId: stripePaymentMethodId },
          },
          { idempotencyKey: `stripe-idem-payment_method.retrieve-${stripePaymentMethodId}-0` },
        );
        body = response.body;
      } catch (err) {
        if (isStripeApiError(err) && err.statusCode === 404) {
          throw new PaymentMethodRejectedError("not_found", "the payment method does not exist");
        }
        throw err;
      }
      const customer = str(body.customer);
      if (customer === null || customer !== stripeCustomerId) {
        throw new PaymentMethodRejectedError(
          "not_attached_to_customer",
          "the payment method is not attached to this organization's Stripe customer",
        );
      }
      const card = obj(body.card);
      const ach = obj(body.us_bank_account);
      const sepa = obj(body.sepa_debit);
      return {
        kind: kindOf(body.type),
        cardBrand: str(card.brand),
        cardLast4: str(card.last4),
        cardExpMonth: int(card.exp_month),
        cardExpYear: int(card.exp_year),
        achBankName: str(ach.bank_name),
        achAccountLast4: str(ach.last4),
        achAccountType: str(ach.account_type),
        sepaCountry: str(sepa.country),
        sepaLast4: str(sepa.last4),
      };
    },
  };
}
