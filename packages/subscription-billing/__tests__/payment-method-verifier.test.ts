// GAP-060 — a client-supplied `stripePaymentMethodId` is never trusted: it is retrieved from Stripe and must
// be attached to THIS org's Stripe customer (i.e. it came out of a completed SetupIntent for that customer).
import { describe, expect, it } from "vitest";
import {
  PaymentMethodRejectedError,
  type StripeClient,
  createStripePaymentMethodVerifier,
} from "../src/stripe";

const fakeClient = (body: Record<string, unknown> | Error): StripeClient & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    async execute(request) {
      calls.push(request);
      if (body instanceof Error) throw body;
      return { statusCode: 200, body };
    },
  };
};

describe("createStripePaymentMethodVerifier (GAP-060)", () => {
  it("accepts a card attached to the org's customer and maps its non-secret metadata", async () => {
    const client = fakeClient({
      id: "pm_ok",
      type: "card",
      customer: "cus_org",
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2031 },
    });
    const verified = await createStripePaymentMethodVerifier(client).verifyAttachable({
      stripeCustomerId: "cus_org",
      stripePaymentMethodId: "pm_ok",
    });
    expect(verified).toMatchObject({
      kind: "card",
      cardBrand: "visa",
      cardLast4: "4242",
      cardExpMonth: 12,
      cardExpYear: 2031,
    });
    expect(client.calls).toEqual([
      { operation: "payment_method.retrieve", payload: { paymentMethodId: "pm_ok" } },
    ]);
  });

  it("rejects a payment method that belongs to another customer", async () => {
    const client = fakeClient({ id: "pm_x", type: "card", customer: "cus_other", card: {} });
    await expect(
      createStripePaymentMethodVerifier(client).verifyAttachable({
        stripeCustomerId: "cus_org",
        stripePaymentMethodId: "pm_x",
      }),
    ).rejects.toBeInstanceOf(PaymentMethodRejectedError);
  });

  it("rejects a payment method attached to no customer (SetupIntent never completed)", async () => {
    const client = fakeClient({ id: "pm_x", type: "card", customer: null, card: {} });
    await expect(
      createStripePaymentMethodVerifier(client).verifyAttachable({
        stripeCustomerId: "cus_org",
        stripePaymentMethodId: "pm_x",
      }),
    ).rejects.toMatchObject({ reason: "not_attached_to_customer" });
  });

  it("rejects an id Stripe does not know (404) as not_found", async () => {
    const client = fakeClient(
      Object.assign(new Error("No such PaymentMethod"), { statusCode: 404, retryable: false }),
    );
    await expect(
      createStripePaymentMethodVerifier(client).verifyAttachable({
        stripeCustomerId: "cus_org",
        stripePaymentMethodId: "pm_fake",
      }),
    ).rejects.toMatchObject({ reason: "not_found" });
  });

  it("propagates a transient Stripe failure instead of treating it as a rejection", async () => {
    const boom = Object.assign(new Error("timeout"), { statusCode: 0, retryable: true });
    await expect(
      createStripePaymentMethodVerifier(fakeClient(boom)).verifyAttachable({
        stripeCustomerId: "cus_org",
        stripePaymentMethodId: "pm_a",
      }),
    ).rejects.toBe(boom);
  });
});
